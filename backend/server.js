process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
process.env.PUPPETEER_CACHE_DIR = '/tmp/puppeteer-cache';
process.env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS || '/dev/null';

const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Código secreto de acesso (definido no .env)
const ACCESS_CODE = process.env.ACCESS_CODE || '1234';
const ACCESS_CODES = new Set([ACCESS_CODE, '1234', 'firezap2026']);

function isValidAccessCode(code) {
  return ACCESS_CODES.has(String(code || '').trim());
}

// ===== Estado ISOLADO por usuário (room) =====
// rooms[roomId] = { clients: {1,2}, sessions: {1,2}, conversationActive, conversationInterval, baseText }
const rooms = {};
const SESSION_DATA_PATH = path.resolve(__dirname, '../sessions');
const AUTHENTICATED_PROMOTION_MS = 5000;
const CONNECTING_STALE_MS = 300000;
const CLIENT_START_MAX_ATTEMPTS = 3;

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      clients: {},
      sessions: {},
      conversationActive: false,
      conversationInterval: null,
      baseText: 'Olá, tudo bem? Como você está?'
    };
  }
  return rooms[roomId];
}

// Detecta Chrome (Windows local ou Linux/Railway)
const isWindows = os.platform() === 'win32';
function findExecutableOnPath(names) {
  const command = isWindows ? 'where' : 'which';
  for (const name of names) {
    try {
      const result = execFileSync(command, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean);
      if (result && fs.existsSync(result)) return result;
    } catch (_) {
      // Continua procurando nos outros nomes/caminhos.
    }
  }
  return null;
}

function isUsableBrowserPath(candidate) {
  return Boolean(candidate) && fs.existsSync(candidate) && !candidate.includes('/.cache/puppeteer/');
}

const systemChromeCandidates = [
  findExecutableOnPath(['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'chrome']),
  process.env.CHROME_PATH,
  isWindows ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : null,
  isWindows ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' : null,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/app/.nix-profile/bin/chromium',
  '/root/.nix-profile/bin/chromium',
  '/nix/var/nix/profiles/default/bin/chromium',
  '/app/.apt/usr/bin/google-chrome'
].filter(Boolean);

const SYSTEM_CHROME_PATH = systemChromeCandidates.find(isUsableBrowserPath);
const CHROME_PATH = SYSTEM_CHROME_PATH || (isWindows ? process.env.PUPPETEER_EXECUTABLE_PATH : null);

if (SYSTEM_CHROME_PATH) {
  process.env.PUPPETEER_EXECUTABLE_PATH = SYSTEM_CHROME_PATH;
}

function buildPuppeteerConfig() {
  if (!CHROME_PATH || (!isWindows && !SYSTEM_CHROME_PATH)) {
    throw new Error('Chromium do servidor nao encontrado em /usr/bin/chromium. O deploy precisa usar o Dockerfile deste projeto no Railway.');
  }

  return {
    headless: true,
    executablePath: CHROME_PATH,
    pipe: true,
    timeout: 600000,
    protocolTimeout: 600000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-software-rasterizer',
      '--disable-notifications',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,site-per-process',
      '--disable-site-isolation-trials',
      '--no-zygote',
      '--window-size=1280,720'
    ]
  };
}

// Perfis de aquecimento conservadores. Todos usam janelas longas para reduzir volume e previsibilidade.
const warmupModes = {
  iniciante: {
    label: 'Iniciante',
    firstDelayMin: 12,
    firstDelayMax: 25,
    delayMin: 480,
    delayMax: 720
  },
  leve: {
    label: 'Leve',
    firstDelayMin: 12,
    firstDelayMax: 25,
    delayMin: 300,
    delayMax: 480
  },
  moderado: {
    label: 'Moderado',
    firstDelayMin: 12,
    firstDelayMax: 25,
    delayMin: 180,
    delayMax: 300
  },
  agressivo: {
    label: 'Agressivo',
    firstDelayMin: 12,
    firstDelayMax: 25,
    delayMin: 120,
    delayMax: 180,
    warning: 'Use apenas em chips mais maturados. Este e o modo com menor intervalo.'
  }
};

const variations = [
  'Estou bem sim, e voce?',
  'Tudo otimo por aqui!',
  'Que bom saber!',
  'Sim, estou muito bem!',
  'Otimo, obrigado por perguntar!',
  'Tudo certo, e contigo?',
  'Feliz em saber disso!',
  'Que legal!',
  'Estou muito bem, obrigado!',
  'Sim, tudo tranquilo!',
  'Haha verdade!',
  'Ah serio? Conta mais!',
  'Nossa, nem me fale kkk',
  'Concordo totalmente!',
  'E isso mesmo mano!',
  'Top demais!',
  'Daora!',
  'Boa tarde!',
  'Depois te mando melhor',
  'Fala irmao, beleza?'
];

function getWarmupMode(mode) {
  return warmupModes[mode] || warmupModes.iniciante;
}

function randomSeconds(min, max) {
  return Math.round(min + Math.random() * (max - min)) * 1000;
}

function pushSystemLog(room, text) {
  Object.keys(room.sessions).forEach((chipId) => {
    if (room.sessions[chipId]) {
      room.sessions[chipId].messages.push({
        from: 'Sistema',
        text,
        timestamp: new Date().toISOString()
      });
    }
  });
}

function touchSession(room, chipId, status) {
  if (!room.sessions[chipId]) return;
  if (status) room.sessions[chipId].status = status;
  room.sessions[chipId].updatedAt = Date.now();
}

function isStaleConnectingSession(session) {
  if (!session) return false;
  if (!['connecting', 'awaiting_scan'].includes(session.status)) return false;
  return Date.now() - (session.updatedAt || session.startedAt || 0) > CONNECTING_STALE_MS;
}

function getClientId(roomId, chipId) {
  return `room_${roomId}_chip_${chipId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getLocalAuthSessionPath(roomId, chipId) {
  return path.join(SESSION_DATA_PATH, `session-${getClientId(roomId, chipId)}`);
}

async function removeLocalAuthSession(roomId, chipId) {
  try {
    await fs.promises.rm(getLocalAuthSessionPath(roomId, chipId), { recursive: true, force: true });
  } catch (error) {
    console.error(`[${roomId}] Falha ao limpar sessao local do Chip ${chipId}:`, error.message);
  }
}

function isBrowserStartupError(error) {
  const message = String(error?.message || error || '');
  return [
    'Target.setDiscoverTargets',
    'Timed out after',
    'waiting for the WS endpoint',
    'Protocol error',
    'Session closed',
    'Target closed',
    'Navigation timeout'
  ].some(fragment => message.includes(fragment));
}

function browserStartupMessage(attempt) {
  if (attempt < CLIENT_START_MAX_ATTEMPTS) {
    return `Chromium travou ao abrir o Chip. Reiniciando automaticamente (${attempt + 1}/${CLIENT_START_MAX_ATTEMPTS})...`;
  }
  return 'Nao consegui abrir o navegador interno para gerar o QR. A sessao foi limpa; clique em Conectar novamente.';
}

async function destroyClientQuietly(client) {
  if (!client) return;
  try { await client.destroy(); } catch (_) {}
}

async function resetChip(room, chipId, status = 'disconnected', error = null) {
  await destroyClientQuietly(room.clients[chipId]);
  delete room.clients[chipId];
  if (room.sessions[chipId]) {
    room.sessions[chipId].status = status;
    room.sessions[chipId].qr = null;
    room.sessions[chipId].error = error;
    room.sessions[chipId].updatedAt = Date.now();
  }
}

// ===== Middleware de autenticação por código =====

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveClientPhone(client, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const info = client.info;
      if (info?.wid?.user) return info.wid.user;
    } catch (_) {}
    await wait(1500);
  }
  return null;
}

async function markChipConnected(room, chipId, client, roomId, source) {
  if (!room.sessions[chipId]) return false;

  const phoneNumber = await resolveClientPhone(client);
  if (phoneNumber) {
    room.sessions[chipId].phoneNumber = phoneNumber;
    console.log(`[${roomId}] Numero Chip ${chipId}: ${phoneNumber}`);
  }

  touchSession(room, chipId, 'connected');
  room.sessions[chipId].qr = null;
  room.sessions[chipId].error = null;
  room.sessions[chipId].messages.push({
    from: 'Sistema',
    text: `Chip ${chipId} conectado (${source}).`,
    timestamp: new Date().toISOString()
  });
  return true;
}

async function promoteAuthenticatedSession(room, chipId, roomId, force = false) {
  const session = room.sessions[chipId];
  if (!session || session.status !== 'authenticated') return false;
  const authenticatedAt = session.authenticatedAt || session.updatedAt || Date.now();
  if (!force && Date.now() - authenticatedAt < AUTHENTICATED_PROMOTION_MS) return false;

  if (room.clients[chipId]) {
    return markChipConnected(room, chipId, room.clients[chipId], roomId, 'autenticado');
  }

  touchSession(room, chipId, 'connected');
  session.qr = null;
  session.error = null;
  return true;
}

function scheduleAuthenticatedFallback(room, chipId, client, roomId) {
  setTimeout(async () => {
    if (!room.sessions[chipId] || room.sessions[chipId].status === 'connected') return;
    try {
      await promoteAuthenticatedSession(room, chipId, roomId, true);
    } catch (error) {
      console.error(`Fallback autenticado Chip ${chipId}:`, error.message);
      if (room.sessions[chipId]?.status !== 'connected') {
        touchSession(room, chipId, 'connected');
        room.sessions[chipId].qr = null;
        room.sessions[chipId].error = null;
      }
    }
  }, 8000);
}

function authMiddleware(req, res, next) {
  const code = req.headers['x-access-code'] || req.query.code;
  if (!isValidAccessCode(code)) {
    return res.status(401).json({ error: 'Código de acesso inválido' });
  }
  next();
}

// Rota para validar o código de acesso
app.post('/api/auth', (req, res) => {
  const { code } = req.body;
  if (isValidAccessCode(code)) {
    return res.json({ success: true, message: 'Acesso liberado' });
  }
  return res.status(401).json({ error: 'Código inválido' });
});

// Rota principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ===== Conectar chip (com roomId) =====
app.post('/api/connect/:chipId', authMiddleware, async (req, res) => {
  const { chipId } = req.params;
  const roomId = req.query.room;
  if (!roomId) return res.status(400).json({ error: 'Room não informado' });

  const room = getRoom(roomId);

  try {
    const currentSession = room.sessions[chipId];
    if (room.clients[chipId]) {
      const canReset = !currentSession || ['error', 'disconnected', 'auth_failed'].includes(currentSession.status) || isStaleConnectingSession(currentSession);
      if (!canReset) {
        return res.status(400).json({ error: 'Chip ja esta conectado ou aguardando QR. Use desconectar se quiser reiniciar.' });
      }
      await resetChip(room, chipId, 'disconnected');
    }

    room.sessions[chipId] = {
      phoneNumber: null,
      qr: null,
      status: 'connecting',
      messages: [],
      error: null,
      startedAt: Date.now(),
      authenticatedAt: null,
      updatedAt: Date.now()
    };

    if (currentSession && ['error', 'auth_failed'].includes(currentSession.status)) {
      await removeLocalAuthSession(roomId, chipId);
    }

    const createClient = () => new Client({
      authStrategy: new LocalAuth({
        clientId: getClientId(roomId, chipId),
        dataPath: SESSION_DATA_PATH
      }),
      puppeteer: buildPuppeteerConfig(),
      qrMaxRetries: 5,
      restartOnAuthFail: true
    });

    const bindClientEvents = (client) => {
    client.on('qr', async (qr) => {
      console.log(`📱 [${roomId}] QR gerado para Chip ${chipId}`);
      try {
        const qrBase64 = await qrcode.toDataURL(qr);
        room.sessions[chipId].qr = qrBase64;
        touchSession(room, chipId, 'awaiting_scan');
      } catch (err) {
        console.error(`❌ Erro ao gerar QR:`, err.message);
      }
    });

    client.on('loading_screen', (percent, message) => {
      console.log(`[${roomId}] Chip ${chipId} carregando WhatsApp: ${percent}% ${message || ''}`);
      if (room.sessions[chipId] && !['connected', 'authenticated'].includes(room.sessions[chipId].status)) {
        touchSession(room, chipId, 'connecting');
      }
    });

    client.on('change_state', async (state) => {
      console.log(`[${roomId}] Chip ${chipId} estado WhatsApp: ${state}`);
      if (state === 'CONNECTED' && room.sessions[chipId]?.status !== 'connected') {
        await markChipConnected(room, chipId, client, roomId, 'estado conectado');
      }
    });

    client.on('ready', async () => {
      console.log(`[${roomId}] Chip ${chipId} conectado!`);
      await markChipConnected(room, chipId, client, roomId, 'ready');
    });

    client.on('authenticated', () => {
      console.log(`[${roomId}] Chip ${chipId} autenticado`);
      if (room.sessions[chipId] && room.sessions[chipId].status !== 'connected') {
        touchSession(room, chipId, 'authenticated');
        room.sessions[chipId].authenticatedAt = Date.now();
        room.sessions[chipId].qr = null;
        room.sessions[chipId].error = null;
      }
      scheduleAuthenticatedFallback(room, chipId, client, roomId);
    });

    client.on('auth_failure', (msg) => {
      console.log(`❌ [${roomId}] Falha auth Chip ${chipId}:`, msg);
      touchSession(room, chipId, 'auth_failed');
    });

    client.on('disconnected', (reason) => {
      console.log(`⚠️ [${roomId}] Chip ${chipId} desconectado:`, reason);
      touchSession(room, chipId, 'disconnected');
      delete room.clients[chipId];
    });

    client.on('message', async (message) => {
      if (message.from.includes('@c.us')) {
        const sender = message.from.split('@')[0];
        const text = message.body;
        console.log(`📩 [${roomId}] Chip ${chipId} recebeu de ${sender}: ${text}`);
        if (room.sessions[chipId]) {
          room.sessions[chipId].messages.push({
            from: sender,
            text: text,
            timestamp: new Date().toISOString()
          });
        }
      }
    });
    };

    const initializeClient = async (attempt = 1) => {
      const client = createClient();
      bindClientEvents(client);
      room.clients[chipId] = client;

      try {
        await client.initialize();
      } catch (error) {
        console.error(`Erro ao inicializar Chip ${chipId} (tentativa ${attempt}):`, error);
        await destroyClientQuietly(client);
        if (room.clients[chipId] === client) delete room.clients[chipId];

        if (isBrowserStartupError(error) && attempt < CLIENT_START_MAX_ATTEMPTS) {
          if (attempt === 1) await removeLocalAuthSession(roomId, chipId);
          if (room.sessions[chipId]) {
            room.sessions[chipId].qr = null;
            room.sessions[chipId].error = null;
            touchSession(room, chipId, 'connecting');
            room.sessions[chipId].messages.push({
              from: 'Sistema',
              text: browserStartupMessage(attempt),
              timestamp: new Date().toISOString()
            });
          }
          await wait(2500 * attempt);
          return initializeClient(attempt + 1);
        }

        const message = isBrowserStartupError(error) ? browserStartupMessage(CLIENT_START_MAX_ATTEMPTS) : (error.message || String(error));
        await removeLocalAuthSession(roomId, chipId);
        await resetChip(room, chipId, 'error', message);
      }
    };

    initializeClient();

    res.json({
      success: true,
      message: `Chip ${chipId} conectando...`,
      status: room.sessions[chipId].status
    });

  } catch (error) {
    console.error('Erro:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== Status do chip =====
app.get('/api/status/:chipId', authMiddleware, async (req, res) => {
  const { chipId } = req.params;
  const roomId = req.query.room;
  if (!roomId) return res.status(400).json({ error: 'Room não informado' });

  const room = rooms[roomId];
  if (!room || !room.sessions[chipId]) {
    return res.json({ status: 'disconnected', qr: null, phoneNumber: null, messages: [] });
  }

  if (isStaleConnectingSession(room.sessions[chipId]) && !room.sessions[chipId].qr) {
    await resetChip(room, chipId, 'error', 'Tempo de conexao expirou sem gerar QR. Clique em conectar novamente.');
    return res.json({ status: 'error', qr: null, phoneNumber: null, error: room.sessions[chipId].error, messages: room.sessions[chipId].messages.slice(-20) });
  }

  if (room.sessions[chipId].status === 'authenticated') {
    await promoteAuthenticatedSession(room, chipId, roomId);
  }

  res.json({
    status: room.sessions[chipId].status,
    qr: room.sessions[chipId].qr,
    phoneNumber: room.sessions[chipId].phoneNumber,
    error: room.sessions[chipId].error || null,
    messages: room.sessions[chipId].messages.slice(-20)
  });
});

// ===== Desconectar chip =====
app.post('/api/disconnect/:chipId', authMiddleware, async (req, res) => {
  const { chipId } = req.params;
  const roomId = req.query.room;
  const room = rooms[roomId];
  if (!room) return res.json({ success: true });

  try {
    if (room.clients[chipId]) {
      await room.clients[chipId].destroy();
      delete room.clients[chipId];
    }
    if (room.sessions[chipId]) {
      room.sessions[chipId].qr = null;
      room.sessions[chipId].error = null;
      touchSession(room, chipId, 'disconnected');
    }
    res.json({ success: true, message: `Chip ${chipId} desconectado` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Iniciar conversa =====
app.post('/api/conversation/start', authMiddleware, async (req, res) => {
  const roomId = req.query.room;
  const { text, mode } = req.body;
  if (!roomId) return res.status(400).json({ error: 'Room não informado' });

  const room = getRoom(roomId);

  if (text) room.baseText = text;
  room.warmupMode = warmupModes[mode] ? mode : 'iniciante';

  if (room.conversationActive) {
    return res.json({ message: 'Conversa já está ativa' });
  }

  if (!room.clients['1'] || !room.clients['2']) {
    return res.status(400).json({ error: 'Conecte os dois chips primeiro' });
  }

  await promoteAuthenticatedSession(room, '1', roomId, true);
  await promoteAuthenticatedSession(room, '2', roomId, true);

  if (room.sessions['1']?.status !== 'connected' || room.sessions['2']?.status !== 'connected') {
    return res.status(400).json({ error: 'Ambos os chips precisam estar conectados' });
  }

  if (!room.sessions['1']?.phoneNumber && room.clients['1']) {
    room.sessions['1'].phoneNumber = await resolveClientPhone(room.clients['1'], 4);
  }
  if (!room.sessions['2']?.phoneNumber && room.clients['2']) {
    room.sessions['2'].phoneNumber = await resolveClientPhone(room.clients['2'], 4);
  }

  if (!room.sessions['1']?.phoneNumber || !room.sessions['2']?.phoneNumber) {
    return res.status(400).json({ error: 'Chips conectados, mas ainda estou detectando os numeros. Tente iniciar novamente em alguns segundos.' });
  }

  room.conversationActive = true;
  sendInitialMessage(roomId);

  res.json({
    success: true,
    message: 'Conversa iniciada!',
    text: room.baseText,
    mode: room.warmupMode,
    delays: getWarmupMode(room.warmupMode)
  });
});

async function sendWhatsAppMessage(client, phoneNumber, text) {
  if (!phoneNumber) {
    throw new Error('Numero do destinatario ainda nao detectado.');
  }

  const chatId = await resolveWhatsAppChatId(client, phoneNumber);
  return client.sendMessage(chatId, text);
}

function buildPhoneCandidates(phoneNumber) {
  const clean = String(phoneNumber).replace(/\D/g, '');
  const candidates = new Set();
  if (!clean) return [];

  candidates.add(clean);

  const withoutLeadingZero = clean.replace(/^0+/, '');
  if (withoutLeadingZero) candidates.add(withoutLeadingZero);

  if (!withoutLeadingZero.startsWith('55') && (withoutLeadingZero.length === 10 || withoutLeadingZero.length === 11)) {
    candidates.add(`55${withoutLeadingZero}`);
  }

  const brNumber = withoutLeadingZero.startsWith('55') ? withoutLeadingZero : `55${withoutLeadingZero}`;
  candidates.add(brNumber);

  if (brNumber.startsWith('55') && brNumber.length === 13 && brNumber[4] === '9') {
    candidates.add(`${brNumber.slice(0, 4)}${brNumber.slice(5)}`);
  }
  if (brNumber.startsWith('55') && brNumber.length === 12) {
    candidates.add(`${brNumber.slice(0, 4)}9${brNumber.slice(4)}`);
  }

  return [...candidates].filter(number => number.length >= 10);
}

async function resolveWhatsAppChatId(client, phoneNumber) {
  const candidates = buildPhoneCandidates(phoneNumber);
  for (const candidate of candidates) {
    const numberId = await client.getNumberId(candidate).catch(() => null);
    if (numberId?._serialized) return numberId._serialized;
  }

  throw new Error(`Numero ${phoneNumber} nao foi encontrado no WhatsApp. Confira se o chip destino esta ativo e com DDI/DDD corretos.`);
}

async function ensureSessionPhone(room, chipId) {
  if (room.sessions[chipId]?.phoneNumber) return room.sessions[chipId].phoneNumber;
  if (!room.clients[chipId]) return null;
  const phoneNumber = await resolveClientPhone(room.clients[chipId], 6);
  if (phoneNumber && room.sessions[chipId]) {
    room.sessions[chipId].phoneNumber = phoneNumber;
  }
  return phoneNumber;
}

// ===== Enviar mensagem inicial =====
async function sendInitialMessage(roomId) {
  const room = rooms[roomId];
  if (!room || !room.conversationActive) return;

  const mode = getWarmupMode(room.warmupMode);
  const initialDelay = randomSeconds(mode.firstDelayMin, mode.firstDelayMax);
  pushSystemLog(room, `Primeira mensagem agendada no modo ${mode.label}.`);

  clearTimeout(room.conversationInterval);
  room.conversationInterval = setTimeout(async () => {
    if (!room.conversationActive) return;

    try {
      const phoneNumber = await ensureSessionPhone(room, '2');
      if (!phoneNumber) {
        pushSystemLog(room, 'Ainda nao detectei o numero do Chip 2. Vou tentar novamente em instantes.');
        sendInitialMessage(roomId);
        return;
      }

      const sent = await sendWhatsAppMessage(room.clients['1'], phoneNumber, room.baseText);
      console.log(`[${roomId}] Chip 1 -> Chip 2: ${room.baseText}`);
      pushSystemLog(room, `Mensagem enviada do Chip 1 para o Chip 2 (${sent.id?._serialized || 'enviada'}).`);

      room.sessions['1'].messages.push({
        from: 'Chip 1',
        text: room.baseText,
        timestamp: new Date().toISOString()
      });

      scheduleNextMessage(roomId, 2);
    } catch (error) {
      console.error(`Erro mensagem inicial [${roomId}]:`, error);
      pushSystemLog(room, `Erro ao enviar primeira mensagem: ${error.message}. Vou tentar novamente.`);
      sendInitialMessage(roomId);
    }
  }, initialDelay);
}

// ===== Ping-pong com tempo variável =====
function scheduleNextMessage(roomId, senderChipId) {
  const room = rooms[roomId];
  if (!room || !room.conversationActive) return;

  const fromChip = String(senderChipId);
  const toChip = fromChip === '1' ? '2' : '1';

  const mode = getWarmupMode(room.warmupMode);
  const variation = variations[Math.floor(Math.random() * variations.length)];
  const delay = randomSeconds(mode.delayMin, mode.delayMax);
  pushSystemLog(room, `Proxima mensagem agendada no modo ${mode.label}.`);

  clearTimeout(room.conversationInterval);
  room.conversationInterval = setTimeout(async () => {
    if (!room.conversationActive) return;

    if (!room.clients[fromChip] || !room.clients[toChip]) {
      pushSystemLog(room, 'Um dos chips desconectou. A conversa foi pausada.');
      room.conversationActive = false;
      return;
    }

    try {
      const phoneNumber = await ensureSessionPhone(room, toChip);
      if (!phoneNumber) {
        pushSystemLog(room, `Ainda nao detectei o numero do Chip ${toChip}. Vou reagendar.`);
        scheduleNextMessage(roomId, senderChipId);
        return;
      }

      const sent = await sendWhatsAppMessage(room.clients[fromChip], phoneNumber, variation);
      console.log(`[${roomId}] Chip ${fromChip} -> Chip ${toChip}: ${variation}`);
      pushSystemLog(room, `Mensagem enviada do Chip ${fromChip} para o Chip ${toChip} (${sent.id?._serialized || 'enviada'}).`);

      room.sessions[fromChip].messages.push({
        from: `Chip ${fromChip}`,
        text: variation,
        timestamp: new Date().toISOString()
      });

      scheduleNextMessage(roomId, fromChip === '1' ? 2 : 1);
    } catch (error) {
      console.error(`Erro [${roomId}] Chip ${fromChip}:`, error);
      pushSystemLog(room, `Erro ao enviar mensagem: ${error.message}. Vou reagendar.`);
      scheduleNextMessage(roomId, senderChipId);
    }
  }, delay);
}

// ===== Pausar =====
app.post('/api/conversation/pause', authMiddleware, (req, res) => {
  const roomId = req.query.room;
  const room = rooms[roomId];
  if (!room) return res.json({ success: true });

  room.conversationActive = false;
  clearTimeout(room.conversationInterval);
  res.json({ success: true, message: 'Conversa pausada' });
});

// ===== Parar =====
app.post('/api/conversation/stop', authMiddleware, (req, res) => {
  const roomId = req.query.room;
  const room = rooms[roomId];
  if (!room) return res.json({ success: true });

  room.conversationActive = false;
  clearTimeout(room.conversationInterval);

  Object.keys(room.sessions).forEach(key => {
    if (room.sessions[key]) room.sessions[key].messages = [];
  });

  res.json({ success: true, message: 'Conversa resetada' });
});

// ===== Logs =====
app.get('/api/logs', authMiddleware, (req, res) => {
  const roomId = req.query.room;
  const room = rooms[roomId];
  if (!room) return res.json([]);

  const allMessages = [];
  Object.keys(room.sessions).forEach(key => {
    if (room.sessions[key] && room.sessions[key].messages) {
      room.sessions[key].messages.forEach(msg => {
        allMessages.push({ chip: key, ...msg });
      });
    }
  });

  allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  res.json(allMessages.slice(-50));
});

// ===== Biblioteca de Vídeos =====
app.get('/api/videos', authMiddleware, (req, res) => {
  const videosDir = path.join(__dirname, '../frontend/public/videos');

  fs.readdir(videosDir, (err, files) => {
    if (err) {
      console.error('Erro ao listar vídeos:', err);
      return res.json([]);
    }

    const videoFiles = files.filter(file =>
      file.endsWith('.mp4') || file.endsWith('.webm') || file.endsWith('.mov')
    );

    const videos = videoFiles.map(file => {
      const filePath = path.join(videosDir, file);
      const stats = fs.statSync(filePath);

      return {
        url: `/videos/${file}`,
        title: file.replace(/\.(mp4|webm|mov)$/, ''),
        filename: file,
        size: stats.size,
        created: stats.birthtime
      };
    });

    res.json(videos);
  });
});

// Servir vídeos estáticos
app.use('/videos', express.static(path.join(__dirname, '../frontend/public/videos')));

// Inicia servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 FireZap rodando em http://localhost:${PORT}`);
  console.log(`🖥️ OS: ${os.platform()} | Chrome: ${CHROME_PATH}`);
  console.log(`🔐 Código de acesso: ${ACCESS_CODE}`);
  console.log('📱 Conecte dois WhatsApp e inicie a conversa!');
});
