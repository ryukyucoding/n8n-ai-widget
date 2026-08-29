# 給 .44 Codex 的工作單

**主機：** `widm-n8n.csie.ncu.edu.tw` = `140.115.54.44`
**執行者：** .44 上的 Codex CLI（`/data/daniel/.local/bin/codex`）
**出單者：** Claude（`claude-7c`）｜2026-08-28 更新

---

## 為什麼是你做

Claude 兩邊環境都連不到 .44（實測：device_bash 無網路、雲端容器被出口政策擋掉）。
**你是唯一能直接觀察這台機器的參與者。**

## 回報規則

> **貼原始輸出，不要摘要。** 指令原文 + 完整 stdout/stderr + exit code。
> 這條鏈上沒有人能重跑你的指令來驗證你的摘要，所以摘要在這裡不構成證據。

若沙箱阻擋了某個指令（例如 docker socket），**明講被擋了**，不要略過也不要猜測結果。

---

## ~~T1 / T2（已作廢）~~

原本要求重新匯出 schema 並重跑測試。**已作廢** —— Claude 先前判斷「schema 來自錯的容器」是**錯的**，
已撤回。實測 `getent hosts` 顯示 `n8n` 與 `n8n-n8n-1` 都解析到 `172.19.0.3`，
`n8n` 只是 compose 的網路別名。**repo 內 554 節點的 schema 是正確的，不需更換。**
`/data/daniel/runtime_node_schemas_2_4_6.json` 是錯誤產物，勿用。

---

## T4 — n8n 容器盤點（現行任務）

**背景：** 這台機器上有多個 n8n 相關容器，來歷與用途不明，已經害 Claude 誤判過一次。
Dan 表示 n8n 相關的都是他的（`coolen-*`、`etl-*` 是別人的，不要碰）。

**目標容器：** `n8n`、`n8n-n8n-1`、`n8n-mcp`、`n8n-chatbot-1`、`n8n-chatbot-beta`、`autoresearch-a2a-broker`

### 要回答的問題

1. **每個容器的身分**：image、建立時間、n8n 版本、網路、ports、掛載的 volume 與主機路徑。

2. **資料在哪裡。** 每個 n8n 實例的資料庫檔案（通常是 `~/.n8n/database.sqlite`）位置、大小、最後修改時間。
   **各自有幾個 workflow？** SQLite 可用：
   `docker exec <c> sh -c 'ls -la ~/.n8n/ 2>/dev/null'`
   查詢筆數請優先用 n8n 自己的 API 或唯讀開啟 sqlite，**不要寫入資料庫**。

3. **`n8n`（2.4.6）這個容器到底是什麼。**
   - 它 7 個月前建立、沒有 ports、`.NetworkSettings.Networks` 為空，但狀態是 Up 3 weeks。
   - 確認它的 `NetworkMode`（`docker inspect n8n --format '{{.HostConfig.NetworkMode}}'`）。
   - **它的資料還在嗎？裡面有 workflow 嗎？**
   - **它可以安全移除嗎？** 只給判斷與理由，**不要移除**。

4. **公開網址的路由。** `https://widm-n8n.csie.ncu.edu.tw` 經 `nginx-proxy`
   （nginx-proxy-manager）指向哪個 upstream？請從 proxy 的設定確認，不要從容器名推測。

5. **`n8n-n8n-1` 為何同時映射 `5678` 與 `5679`**（兩者都轉到容器內 5678）？是刻意還是殘留？

6. **`n8n-mcp` 連的是哪一個 n8n？** 看它的環境變數。

7. **`autoresearch-a2a-broker` 用的 image 是 `n8n-chatbot:latest`** —— 這是刻意重用 chatbot image，
   還是誤用？它跑的是什麼程序？

### 硬性限制

- **全程唯讀。** 不得 stop / rm / restart / 修改任何容器，不得寫入任何資料庫。
- **不要碰 `coolen-*`、`etl-*`、`nginx-proxy`、`coolen-mysql`** —— 那些不是 Dan 的。
  （附註：`etl-mongo` 與 `etl-rabbit` 目前在 restart 迴圈中，僅供 Dan 參考，不要處理。）
- **不要部署、不要 git 寫入**（見 `a2a/PROTOCOL.md` P10、`a2a/RELEASE_PLAN.md`）。

### 輸出格式

一份表格式盤點 + 每個問題的明確回答。**不確定的地方標「未確認」，不要填推測。**
若某項需要非唯讀操作才能確認，說明需要什麼操作與風險，交由 Dan 決定。

---

## T5 — 驗證一個 Claude 的預測（順手做）

Claude 診斷 `chatProgress.test.js:68` 的失敗是 CRLF 假象：測試用 LF 換行的字串字面值比對
`chat.html`，而 Dan 的 Windows checkout 是 CRLF。**預測它在 .44 的 Linux checkout 會通過。**

```sh
cd /data/daniel/n8n-worktrees/runtime-compiler-integration/chatbot
node --test src/chatProgress.test.js 2>&1 | tail -20
```

**若它在 .44 仍然失敗，代表 Claude 的診斷錯了，請直接指出。**
（注意：該 worktree 可能沒有 Claude 今天的 R3/R17 變更，這條只驗 chatProgress 這一個既有測試。）

---

## 回報去向

交給 Dan 或桌面 Codex 寫進 `a2a/codex.outbox.jsonl`，`topic` 用 `codex44-T4` / `codex44-T5`，
body 開頭標明 **「以下為 .44 原始輸出，轉述者：<誰>」**（協定 P12b：資料來源與信差要分清）。
