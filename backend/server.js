process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';
process.env.PUPPETEER_CACHE_DIR = '/tmp/puppeteer-cache';

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

// ===== Estado ISOLADO por usuário (room) =====
// rooms[roomId] = { clients: {1,2}, sessions: {1,2}, conversationActive, conversationInterval, baseText }
const rooms = {};

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
    headless: 'new',
    executablePath: CHROME_PATH,
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
      '--disable-features=site-per-process',
      '--single-process'
    ]
  };
}

// Mensagens com tempo variado (rápidas e demoradas)
const variations = [
  { text: 'Estou bem sim, e você?', delayMin: 2, delayMax: 4 },
  { text: 'Tudo ótimo por aqui!', delayMin: 8, delayMax: 15 },
  { text: 'Que bom saber!', delayMin: 1, delayMax: 3 },
  { text: 'Sim, estou muito bem!', delayMin: 10, delayMax: 20 },
  { text: 'Ótimo, obrigado por perguntar!', delayMin: 3, delayMax: 6 },
  { text: 'Tudo certo, e contigo?', delayMin: 5, delayMax: 10 },
  { text: 'Feliz em saber disso!', delayMin: 15, delayMax: 30 },
  { text: 'Que legal!', delayMin: 2, delayMax: 5 },
  { text: 'Estou muito bem, obrigado!', delayMin: 12, delayMax: 25 },
  { text: 'Sim, tudo tranquilo!', delayMin: 4, delayMax: 8 },
  { text: 'Haha verdade!', delayMin: 1, delayMax: 3 },
  { text: 'Ah sério? Conta mais!', delayMin: 6, delayMax: 12 },
  { text: 'Nossa, nem me fale kkk', delayMin: 3, delayMax: 7 },
  { text: 'Concordo totalmente!', delayMin: 10, delayMax: 18 },
  { text: 'É isso mesmo mano!', delayMin: 5, delayMax: 9 },
  { text: 'Top demais!', delayMin: 1, delayMax: 4 },
  { text: 'Daora!', delayMin: 20, delayMax: 40 },
  { text: 'Boa tarde!', delayMin: 30, delayMax: 60 },
  { text: 'Vou mandar foto depois', delayMin: 15, delayMax: 25 },
  { text: 'Fala irmão, beleza?', delayMin: 2, delayMax: 5 },
];

// ===== Middleware de autenticação por código =====
function authMiddleware(req, res, next) {
  const code = req.headers['x-access-code'] || req.query.code;
  if (code !== ACCESS_CODE) {
    return res.status(401).json({ error: 'Código de acesso inválido' });
  }
  next();
}

// Rota para validar o código de acesso
app.post('/api/auth', (req, res) => {
  const { code } = req.body;
  if (code === ACCESS_CODE) {
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
    if (room.clients[chipId]) {
      return res.status(400).json({ error: 'Chip já conectado' });
    }

    room.sessions[chipId] = {
      phoneNumber: null,
      qr: null,
      status: 'connecting',
      messages: [],
      error: null
    };

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: `room_${roomId}_chip_${chipId}`,
        dataPath: path.resolve(__dirname, '../sessions')
      }),
      puppeteer: buildPuppeteerConfig(),
      qrMaxRetries: 5,
      restartOnAuthFail: true
    });

    client.on('qr', async (qr) => {
      console.log(`📱 [${roomId}] QR gerado para Chip ${chipId}`);
      try {
        const qrBase64 = await qrcode.toDataURL(qr);
        room.sessions[chipId].qr = qrBase64;
        room.sessions[chipId].status = 'awaiting_scan';
      } catch (err) {
        console.error(`❌ Erro ao gerar QR:`, err.message);
      }
    });

    client.on('ready', async () => {
      console.log(`✅ [${roomId}] Chip ${chipId} conectado!`);
      try {
        const info = await client.info;
        if (info && info.wid) {
          room.sessions[chipId].phoneNumber = info.wid.user;
          console.log(`📱 [${roomId}] Número Chip ${chipId}: ${info.wid.user}`);
        }
      } catch (err) {
        console.log(`⚠️ Erro ao pegar número:`, err.message);
      }
      room.sessions[chipId].status = 'connected';
      room.sessions[chipId].qr = null;
    });

    client.on('authenticated', () => {
      console.log(`🔐 [${roomId}] Chip ${chipId} autenticado`);
    });

    client.on('auth_failure', (msg) => {
      console.log(`❌ [${roomId}] Falha auth Chip ${chipId}:`, msg);
      room.sessions[chipId].status = 'auth_failed';
    });

    client.on('disconnected', (reason) => {
      console.log(`⚠️ [${roomId}] Chip ${chipId} desconectado:`, reason);
      room.sessions[chipId].status = 'disconnected';
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

    room.clients[chipId] = client;
    client.initialize().catch((error) => {
      console.error(`Erro ao inicializar Chip ${chipId}:`, error);
      if (room.sessions[chipId]) {
        room.sessions[chipId].status = 'error';
        room.sessions[chipId].error = error.message;
      }
      delete room.clients[chipId];
    });

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
app.get('/api/status/:chipId', authMiddleware, (req, res) => {
  const { chipId } = req.params;
  const roomId = req.query.room;
  if (!roomId) return res.status(400).json({ error: 'Room não informado' });

  const room = rooms[roomId];
  if (!room || !room.sessions[chipId]) {
    return res.json({ status: 'disconnected', qr: null, phoneNumber: null, messages: [] });
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
      room.sessions[chipId].status = 'disconnected';
    }
    res.json({ success: true, message: `Chip ${chipId} desconectado` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== Iniciar conversa =====
app.post('/api/conversation/start', authMiddleware, (req, res) => {
  const roomId = req.query.room;
  const { text } = req.body;
  if (!roomId) return res.status(400).json({ error: 'Room não informado' });

  const room = getRoom(roomId);

  if (text) room.baseText = text;

  if (room.conversationActive) {
    return res.json({ message: 'Conversa já está ativa' });
  }

  if (!room.clients['1'] || !room.clients['2']) {
    return res.status(400).json({ error: 'Conecte os dois chips primeiro' });
  }

  if (room.sessions['1']?.status !== 'connected' || room.sessions['2']?.status !== 'connected') {
    return res.status(400).json({ error: 'Ambos os chips precisam estar conectados' });
  }

  if (!room.sessions['1']?.phoneNumber || !room.sessions['2']?.phoneNumber) {
    return res.status(400).json({ error: 'Aguardando detectar números. Tente novamente em alguns segundos.' });
  }

  room.conversationActive = true;
  sendInitialMessage(roomId);

  res.json({
    success: true,
    message: 'Conversa iniciada!',
    text: room.baseText
  });
});

// ===== Enviar mensagem inicial =====
async function sendInitialMessage(roomId) {
  const room = rooms[roomId];
  if (!room || !room.conversationActive) return;

  try {
    const phoneNumber = room.sessions['2']?.phoneNumber;
    if (!phoneNumber) return;

    await room.clients['1'].sendMessage(`${phoneNumber}@c.us`, room.baseText);
    console.log(`📤 [${roomId}] Chip 1 → Chip 2: ${room.baseText}`);

    room.sessions['1'].messages.push({
      from: 'Chip 1',
      text: room.baseText,
      timestamp: new Date().toISOString()
    });

    scheduleNextMessage(roomId, 2);
  } catch (error) {
    console.error(`Erro mensagem inicial [${roomId}]:`, error);
    room.conversationActive = false;
  }
}

// ===== Ping-pong com tempo variável =====
function scheduleNextMessage(roomId, senderChipId) {
  const room = rooms[roomId];
  if (!room || !room.conversationActive) return;

  const fromChip = String(senderChipId);
  const toChip = fromChip === '1' ? '2' : '1';

  const variation = variations[Math.floor(Math.random() * variations.length)];
  const delay = (variation.delayMin + Math.random() * (variation.delayMax - variation.delayMin)) * 1000;

  clearTimeout(room.conversationInterval);
  room.conversationInterval = setTimeout(async () => {
    if (!room.conversationActive) return;

    if (!room.clients[fromChip] || !room.clients[toChip]) {
      console.log(`❌ [${roomId}] Chip desconectou`);
      room.conversationActive = false;
      return;
    }

    try {
      const phoneNumber = room.sessions[toChip]?.phoneNumber;
      if (!phoneNumber) return;

      await room.clients[fromChip].sendMessage(`${phoneNumber}@c.us`, variation.text);
      console.log(`📤 [${roomId}] Chip ${fromChip} → Chip ${toChip}: ${variation.text}`);

      room.sessions[fromChip].messages.push({
        from: `Chip ${fromChip}`,
        text: variation.text,
        timestamp: new Date().toISOString()
      });

      scheduleNextMessage(roomId, fromChip === '1' ? 2 : 1);
    } catch (error) {
      console.error(`Erro [${roomId}] Chip ${fromChip}:`, error);
      room.conversationActive = false;
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
