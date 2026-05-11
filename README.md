# n8n AI Widget

自架 n8n 用的 AI 小工具：浮動 widget → 聊天室。支援兩條路徑：

1. **Agent 模式（預設）**：意圖分解（`decompose`）→ 依序呼叫 **insert / modify / delete** 的 Python pipeline → 將結果 **PUT** 回目前編輯中的 workflow（需帶 `workflowId`）。
2. **快速模式**：單次 `POST /generate`，用自然語言從零產生 workflow JSON 並建立新 workflow（行為與早期版本相同）。

本 repo **已內嵌** agent bundles、`decompose`，以及共用的 **node schema JSON**（`chatbot/schemas/`）。結構說明見 `chatbot/bundles/README.md`、`chatbot/schemas/README.md`。

## Architecture

```
Browser (n8n UI at :5678)
  └─ loads widget.js from :3001  →  floating button appears
       └─ click  →  iframe opens chat UI at :3001/chat?workflowId=…
            ├─ Agent: POST :3001/agent/run  →  Node 編排 + python bridge  →  bundles/modify|delete|insert|decompose
            └─ Quick: POST :3001/generate   →  OpenAI  →  POST n8n workflow
```

Two Docker services:


| Service   | Image                            | Port |
| --------- | -------------------------------- | ---- |
| `n8n`     | `docker.n8n.io/n8nio/n8n:latest` | 5678 |
| `chatbot` | built from `./chatbot`           | 3001 |


## Quick Start

### 1. Copy env file and fill in your keys

```bash
cp chatbot/.env.example .env
```

Edit `.env`:

```
OPENAI_API_KEY=sk-...
N8N_API_KEY=...          # generate this in n8n after first run (see below)
```

### 2. First run — get the n8n API key

Start n8n alone first to set up an account and generate an API key:

```bash
docker compose up n8n
```

Open [http://localhost:5678](http://localhost:5678), create your owner account, then go to:
**Settings → API → Create API Key**

Copy the key into your `.env` as `N8N_API_KEY`.

### 3. Start everything

```bash
docker compose --env-file .env up --build
```

Open [http://localhost:5678](http://localhost:5678) — the orange chat button appears in the bottom-right corner.

## Environment Variables


| Variable            | Required | Description                                                           |
| ------------------- | -------- | --------------------------------------------------------------------- |
| `OPENAI_API_KEY`    | Yes      | From [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `N8N_API_KEY`       | Yes      | Generated in n8n Settings → API                                       |
| `N8N_BASE_URL`      | No       | Defaults to `http://n8n:5678` (docker internal). If you use a **raw IPv6** host, use brackets, e.g. `http://[fd12:b51a:cc66:f0::1]:5678` — the server will also try to auto-fix unbracketed IPv6. |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | No | If set with an IPv6 host, it **must** use brackets (`http://[...]:port`). The server rewrites common mistakes at startup; if you still see `Invalid port: 'b51a:...'`, unset these in your shell or Docker env and try again. |
| `N8N_PUBLIC_URL`    | No       | Browser URL for workflow links after save, default `http://localhost:5678` |
| `OPENAI_MODEL`      | No       | Model for agent pipelines, default `gpt-4o`                          |
| `PORT`              | No       | Chatbot server port, default `3001`                                   |
| `WIDGET_INSERT_DEBUG` / `N8N_INSERT_DEBUG` | No | Set to `1` (or `true`) to print **insert** pipeline traces (planner, phase0/1/2, coercion, splice) from Python to **stderr**. The Node bridge forwards stderr to the chatbot process so it appears in `docker compose logs -f chatbot`. |
| `WIDGET_MODIFY_DEBUG` / `N8N_MODIFY_DEBUG` | No | Same for the **modify** pipeline (resolve + modify LLM inputs/outputs, schema path). Does nothing for insert-only tasks. |
| `N8N_WIDGET_SCHEMA_ROOT` / `WIDGET_NODE_SCHEMA_ROOT` | No | Directory containing `node_schemas/` and `core_nodes_schemas/`. Default: `chatbot/schemas` (in Docker: `/app/schemas`). |


### 除錯：看 Python pipeline 的完整輸入/輸出

Python 端把 trace 寫到 **stderr**；`chatbot` 的 Node 在每次呼叫 `widget_agent_bridge.py` 成功後也會把子行程的 **stderr 原樣 `console.error` 出來**，所以會進 **Docker / 終端機的 chatbot log**（不會出現在瀏覽器裡）。

1. 在專案根目錄 `.env`（或 `docker-compose` 的 `chatbot.environment`）加上例如：
   ```bash
   WIDGET_INSERT_DEBUG=1
   WIDGET_MODIFY_DEBUG=1
   ```
   （只查 insert 可只開第一行；只查 modify 可只開第二行。）

2. 重建並重啟 chatbot：
   ```bash
   docker compose --env-file .env up --build -d chatbot
   ```
   若 compose 沒有把根目錄 `.env` 自動帶進 `chatbot` service，請在 `docker-compose.yml` 的 `chatbot.environment` 裡明寫上述變數，或 `env_file: .env`。

3. 跟著 log：
   ```bash
   docker compose logs -f chatbot
   ```
   搜尋 `[insert-pipeline]`、`[modify-pipeline]` 區塊即可。

本機 `npm run dev` 時同樣設定環境變數後，trace 會出現在跑 `node` 的那個終端機。

```bash
cd chatbot
cp .env.example .env            # or copy from repo root .env
pip3 install -r python/requirements.txt   # macOS 若遇 PEP 668 可加 --break-system-packages
npm install
npm run dev
```

Then run n8n separately (or use the docker service for n8n only):

```bash
docker compose up n8n
```

Add `EXTERNAL_FRONTEND_HOOKS_URLS=http://localhost:3001/widget.js` to your n8n environment.

## Updating After Code Changes

After editing any file in `chatbot/src/`, rebuild and restart the chatbot container:

```bash
cd /Users/yu/Desktop/projects/gss_cai/n8n-ai-widget
docker compose --env-file .env up --build -d chatbot
```

To restart everything from scratch (e.g. after changing `docker-compose.yml`):

```bash
docker compose --env-file .env up --build -d
```

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
    ├── schemas/           # shared node_schemas + core_nodes_schemas JSON
    ├── bundles/
    │   ├── insert/insert_pipeline/
    │   ├── modify/modify_pipeline/
    │   ├── delete/delete_pipeline/
    │   └── decompose/decompose_pipeline/
    ├── python/
    │   ├── widget_agent_bridge.py
    │   ├── insert_runner_widget.py
    │   └── requirements.txt
    └── src/
        ├── index.js       # Express: /generate, /agent/run, static
        ├── n8nAgent.js    # session + task orchestration
        ├── widget.js      # Browser IIFE — floating button + iframe
        └── chat.html      # Chat UI inside iframe
```

