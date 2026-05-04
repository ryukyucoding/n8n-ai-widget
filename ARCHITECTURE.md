# 系統架構說明

## 專案目標

在自架的 n8n 上加一個 AI Chatbot widget，讓使用者用自然語言描述需求，自動生成並注入 n8n workflow，不需要人工下載/上傳 JSON 檔案。

---

## 整體架構

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser                                  │
│                                                                 │
│  ┌──────────────────────────────────────────────┐              │
│  │  n8n UI  (localhost:5678)                    │              │
│  │                                              │              │
│  │  ┌──────────────────────────────────────┐   │              │
│  │  │  widget.js (injected via hook)       │   │              │
│  │  │  - 右下角浮動圓形按鈕                │   │              │
│  │  │  - 可拖曳、自動靠邊、可調整大小      │   │              │
│  │  │                                      │   │              │
│  │  │  ┌──────────────────────────────┐   │   │              │
│  │  │  │  <iframe> chat.html          │   │   │              │
│  │  │  │  (localhost:3001/chat)        │   │   │              │
│  │  │  │  - 聊天介面                  │   │   │              │
│  │  │  │  - 對話記錄 (localStorage)   │   │   │              │
│  │  │  └──────────────────────────────┘   │   │              │
│  │  └──────────────────────────────────────┘   │              │
│  └──────────────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
         │ POST /generate                  │ n8n API
         ▼                                 ▼
┌────────────────────┐         ┌───────────────────────┐
│  chatbot service   │         │  n8n service           │
│  (localhost:3001)  │────────▶│  (localhost:5678)      │
│                    │  POST   │                        │
│  Node.js + Express │  /api/  │  官方 image，不做任何  │
│                    │  v1/    │  修改                  │
└────────────────────┘  work-  └───────────────────────┘
         │              flows
         │ OpenAI API
         ▼
┌────────────────────┐
│  OpenAI            │
│  (gpt-4o)          │
│  生成 workflow JSON │
└────────────────────┘
```

---

## 兩個 Docker 服務

| 服務       | Image                            | Port | 說明                        |
| ---------- | -------------------------------- | ---- | --------------------------- |
| `n8n`      | `docker.n8n.io/n8nio/n8n:latest` | 5678 | 官方 image，零修改           |
| `chatbot`  | built from `./chatbot`           | 3001 | 自建服務，提供 widget + AI   |

### 網路

兩個 service 都在 `n8n-net` bridge network 內：
- **server-to-server**（chatbot → n8n API）使用 Docker service name：`http://n8n:5678`
- **browser-to-chatbot**（widget、iframe）使用 localhost：`http://localhost:3001`

這個差異很重要：`EXTERNAL_FRONTEND_HOOKS_URLS` 是瀏覽器載入的 URL，所以要用 `localhost`；chatbot 打 n8n REST API 是 container 間通訊，用 service name。

---

## Widget 注入機制

n8n 有一個 `EXTERNAL_FRONTEND_HOOKS_URLS` 環境變數，會讓 n8n 在自己的頁面上自動載入外部 script。

```
docker-compose.yml:
  EXTERNAL_FRONTEND_HOOKS_URLS=http://localhost:3001/widget.js
```

這樣 n8n 每次載入頁面時，都會把 `widget.js` 當成 `<script>` 注入，不需要修改 n8n 原始碼。

---

## Chatbot Service API Endpoints

| Method | Path         | 說明                                           |
| ------ | ------------ | ---------------------------------------------- |
| `GET`  | `/widget.js` | 被 n8n 注入的前端 IIFE script                  |
| `GET`  | `/chat`      | iframe 裡面的聊天室 HTML 頁面                  |
| `POST` | `/generate`  | 接收自然語言，呼叫 OpenAI，注入 n8n workflow    |
| `GET`  | `/health`    | 健康檢查，回傳 `{ status: "ok" }`              |

### POST /generate 流程

```
Request body: { "message": "每天早上 9 點寄提醒信給我" }

1. 驗證 message 不為空
2. 組合 system prompt（含 n8n workflow JSON schema 範例 + 各 node 型別說明）
3. 呼叫 OpenAI gpt-4o API
4. 清理回應（strip markdown code fence，以防模型沒遵守指示）
5. JSON.parse 驗證
6. 若 N8N_API_KEY 未設定：直接回傳 JSON，不注入（開發用）
7. 若有 N8N_API_KEY：POST /api/v1/workflows 建立 workflow
8. 回傳 workflowId、workflowUrl、workflow JSON

Response (success):
{
  "message": "Workflow 'Daily Reminder' created successfully!",
  "workflowId": "abc123",
  "workflowName": "Daily Reminder",
  "workflowUrl": "http://localhost:5678/workflow/abc123",
  "workflow": { ... }
}
```

---

## Widget 前端行為（widget.js）

`widget.js` 是一個 IIFE（Immediately Invoked Function Expression），避免污染全域命名空間。

### 功能
- **浮動按鈕**：右下角固定圓形按鈕（56x56px，橘紅色 `#ff6d5a`）
- **點擊開關**：點擊展開/收起 iframe 聊天視窗（預設 380x520px）
- **可拖曳**：按住按鈕可拖曳到畫面任意位置
- **自動靠邊**：放開後自動 snap 到左側或右側
- **可調整大小**：panel 角落有 resize handle，可拖曳調整大小
- **狀態持久化**：位置、尺寸、靠邊方向都存在 `localStorage`
- **背景遮罩**：開啟時有透明 backdrop，點擊關閉 panel

### localStorage 鍵值

| Key                  | 說明                |
| -------------------- | ------------------- |
| `n8n-widget-side`    | `"left"` 或 `"right"` |
| `n8n-widget-top`     | 按鈕垂直位置 (px)   |
| `n8n-widget-w`       | panel 寬度 (px)     |
| `n8n-widget-h`       | panel 高度 (px)     |

---

## Chat UI（chat.html）

### 功能
- 聊天氣泡介面（使用者訊息右對齊，bot 訊息左對齊）
- 打字中動畫（三點跳動）
- Workflow JSON preview（深色背景 monospace，成功/失敗都顯示）
- 成功時顯示「在 n8n 中開啟 workflow」連結（`target="_parent"`）
- **對話記錄持久化**：用 `localStorage` 保存，重新整理或 iframe 重建後恢復
- **清空按鈕**：清除所有對話記錄

### localStorage 鍵值

| Key                    | 說明             |
| ---------------------- | ---------------- |
| `n8n-widget-history`   | 對話記錄 JSON 陣列 |

---

## AI Prompt 設計

System prompt 告訴 OpenAI：
1. 只回傳純 JSON，不要 prose 或 markdown fence
2. 完整的 n8n workflow JSON schema 範例
3. 常見 node 型別、版本號、參數格式（包含 scheduleTrigger 的 interval 必須是陣列等細節）
4. Position 規則：從 `[240, 300]` 開始，每個 node +220 x 軸
5. 連線規則：connections key 是 source node 的 `name` 欄位

---

## 環境變數

| 變數              | 必要 | 預設值              | 說明                              |
| ----------------- | ---- | ------------------- | --------------------------------- |
| `OPENAI_API_KEY`  | 是   | —                   | OpenAI API 金鑰                   |
| `N8N_API_KEY`     | 是*  | —                   | n8n Settings → API 產生的金鑰     |
| `N8N_BASE_URL`    | 否   | `http://n8n:5678`   | server-to-server URL              |
| `PORT`            | 否   | `3001`              | chatbot server 監聽 port          |

\* `N8N_API_KEY` 未設定時，generate endpoint 仍可用，只是不會注入 n8n（回傳 JSON 供手動匯入）。

---

## 檔案結構

```
n8n-ai-widget/
├── docker-compose.yml         # 兩個 service 的編排設定
├── .env                       # 實際金鑰（不進版控）
├── README.md                  # 快速啟動說明
├── ARCHITECTURE.md            # 本文件
├── example-workflow.json      # workflow JSON 範例
└── chatbot/
    ├── Dockerfile             # Node.js 18 alpine image
    ├── package.json           # express, cors, dotenv, openai
    ├── .env.example           # 環境變數範本
    └── src/
        ├── index.js           # Express server（所有 API 邏輯）
        ├── widget.js          # 瀏覽器端 IIFE（浮動按鈕 + iframe）
        └── chat.html          # iframe 內的聊天室 UI
```

---

## 技術選型理由

| 決策                               | 理由                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| n8n 官方 image 零修改              | 避免 upstream 升級問題；用 hook URL 機制無需 fork              |
| EXTERNAL_FRONTEND_HOOKS_URLS       | n8n 內建機制，專為此用途設計                                   |
| IIFE widget.js                     | 避免污染 n8n 全域命名空間；瀏覽器相容性好                      |
| iframe 聊天室                      | 完全隔離 CSS/JS，不干擾 n8n 自身 UI                            |
| Docker bridge network              | server-to-server 用 service name，外部用 localhost，清楚分離   |
| localStorage 持久化                | widget 切換 n8n 分頁或 workflow 時 iframe 可能重建，需要保存狀態 |
