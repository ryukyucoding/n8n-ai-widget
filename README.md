# n8n AI Widget

AI Chatbot widget for self-hosted n8n. Describe a workflow in natural language → Claude generates the JSON → it gets injected into n8n automatically.

## Architecture

```
Browser (n8n UI at :5678)
  └─ loads widget.js from :3000  →  floating button appears
       └─ click  →  iframe opens chat UI at :3000/chat
            └─ submit message  →  POST :3000/generate
                 ├─ Claude API  →  workflow JSON
                 └─ n8n REST API  →  workflow created in n8n
```

Two Docker services:
| Service | Image | Port |
|---------|-------|------|
| `n8n` | `docker.n8n.io/n8nio/n8n:latest` | 5678 |
| `chatbot` | built from `./chatbot` | 3000 |

## Quick Start

### 1. Copy env file and fill in your keys

```bash
cp chatbot/.env.example .env
```

Edit `.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
N8N_API_KEY=...          # generate this in n8n after first run (see below)
```

### 2. First run — get the n8n API key

Start n8n alone first to set up an account and generate an API key:

```bash
docker compose up n8n
```

Open http://localhost:5678, create your owner account, then go to:
**Settings → API → Create API Key**

Copy the key into your `.env` as `N8N_API_KEY`.

### 3. Start everything

```bash
docker compose --env-file .env up --build
```

Open http://localhost:5678 — the orange chat button appears in the bottom-right corner.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | From https://console.anthropic.com/ |
| `N8N_API_KEY` | Yes | Generated in n8n Settings → API |
| `N8N_BASE_URL` | No | Defaults to `http://n8n:5678` (docker internal) |
| `PORT` | No | Chatbot server port, default `3000` |

## Local Dev (without Docker)

```bash
cd chatbot
cp ../.env.example .env.local   # edit with your keys + N8N_BASE_URL=http://localhost:5678
npm install
npm run dev
```

Then run n8n separately (or use the docker service for n8n only):
```bash
docker compose up n8n
```

Add `EXTERNAL_FRONTEND_HOOKS_URLS=http://localhost:3000/widget.js` to your n8n environment.

## File Structure

```
n8n-ai-widget/
├── docker-compose.yml
├── .env                   # created by you (not committed)
├── README.md
└── chatbot/
    ├── Dockerfile
    ├── package.json
    ├── .env.example
    └── src/
        ├── index.js       # Express server
        ├── widget.js      # Browser IIFE — floating button + iframe
        └── chat.html      # Chat UI inside iframe
```
