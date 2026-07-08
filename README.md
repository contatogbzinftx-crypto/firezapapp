# 🔥 FireZap

Aquecedor de WhatsApp com 2 chips conversando em ping-pong automaticamente. Suporta **múltiplos usuários** isolados, cada um com seus próprios chips, protegido por **código de acesso secreto**.

## ✨ Funcionalidades

- 🔐 **Código secreto de acesso** — só quem tem o código entra
- 👥 **Multi-usuário** — cada pessoa usa em sala isolada, sem conflito
- 📱 **2 WhatsApps por usuário** — conecta via QR Code
- 💬 **Ping-pong automático** — os chips trocam mensagens sozinhos
- ⏱️ **Tempos variados** — mensagens rápidas (1-3s) e demoradas (até 60s)
- 🎨 **Interface dark moderna** com Tailwind CSS

## 🚀 Como rodar localmente

```bash
cd backend
npm install
npm start
```

Abra `http://localhost:3000`, digite o código secreto e seu nome.

## ⚙️ Variáveis de Ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `ACCESS_CODE` | `1234` | Código secreto de acesso |
| `CHROME_PATH` | auto-detected | Caminho do Chrome/Chromium |

## ☁️ Deploy no Railway

1. Conecte este repositório no Railway
2. Adicione as variáveis de ambiente:
   ```
   PORT=3000
   ACCESS_CODE=seu_codigo_secreto_aqui
   CHROME_PATH=/usr/bin/chromium
   ```
3. Adicione um **Volume** montado em `/app/sessions` (para persistir sessões)
4. Deploy!

## 📁 Estrutura

```
firezap/
├── Procfile              ← Railway: comando de start
├── nixpacks.toml         ← Railway: instala Chromium + Node
├── backend/
│   ├── server.js         ← API + WebSocket WhatsApp
│   ├── package.json
│   └── .env              ← configurações locais
├── frontend/
│   └── index.html        ← interface completa
└── sessions/             ← sessões do WhatsApp (persistir no Railway)
```
