# AGENTS.md

本 repo 由三方共同開發：**Dan（使用者）、Codex（Terra）、Claude**。
實際的參與者不只三個實例——見 `a2a/PROTOCOL.md` 的 P12（第三方參與者）與下方「你是誰」。

## 你是誰？開工前先確認

這個 repo 現在可能同時被**多個 agent 實例**開啟（Dan 的家用機、實驗室電腦、`.44` 上的 CLI）。
單一寫者原則（P1）以**身分**為單位，不是以機器為單位：

| 你的身分 | 你唯一可以寫的檔案 |
| --- | --- |
| Claude（任何實例） | `a2a/claude.outbox.jsonl`、`a2a/claude.state.json` |
| Codex（任何實例） | `a2a/codex.outbox.jsonl`、`a2a/codex.state.json` |

**同一身分的多個實例共用同一份 outbox 與 state。**協定目前**沒有**解決這件事
（見 `a2a/PROTOCOL.md` 第 7 節第 4 項）。在有解之前的規矩是：
**同一身分、同一時間，只能有一個實例在寫。**

不確定另一個實例在不在跑，先做兩件事，不要直接動手：

```
./a2a/a2a.sh --locks      # 有沒有人正持有檔案鎖
./a2a/a2a.sh --digest     # 兩邊的 heartbeat 與最近訊息
```

## 開工前

1. 讀 `a2a/PROTOCOL.md` — **agent 之間的溝通協定**。這是規範，不是參考。
2. 依協定第 3 節的標準流程執行：讀對方 outbox → 檢查 heartbeat → 處理 → 有新資訊才寫 → 更新 state → 跑 validator。
3. 每次寫入後執行 validator：Windows 用 `a2a\a2a.cmd --check`，Linux/macOS 用 `./a2a/a2a.sh --check`。
   **不要直接呼叫 `python`**——Windows 環境的 `python` 不在 PATH（2026-08-28 實測），啟動器會自動找直譯器。
   **有 ERROR 必須修正後才能結束。**
4. **不要假設工作區的變更都是自己或使用者做的。**
5. Session／UI／provider 異常時先讀 `a2a/recovery/README.md` 與對應角色文件；不要在沒有 handoff 的情況下直接開同名第二實例。
6. 部署或 `.44` 操作前讀 `a2a/OPERATIONS_RUNBOOK.md`；A2A branch 只保存操作程序，不代表它是可部署的產品來源。

`docs/HANDOFF_CLAUDE_CODEX.md` 已降級為人類閱讀用的現況摘要，**不再是 agent 之間的傳輸層**——除非 Dan 要求，否則不要寫它（兩邊共同編輯同一份 Markdown 會靜默覆蓋彼此）。

## ⚠️ 變更偵測：不要用 git

**這個 worktree 是 Windows checkout，透過 Linux mount 存取時，`git status` 會顯示約 1500 個檔案為 modified——全部是 CRLF/LF 換行符的假差異**（例：`README.md` 顯示 199 insertions / 199 deletions，等於整份檔案每一行都變了）。因此：

- **`git status` / `git diff` 不能當作「對方有沒有動東西」的偵測訊號。**
- **絕對不要執行 `git add -A`、`git commit -a`、`git checkout -- .`、`git stash`**。這會把 1500 個檔案的換行符變更提交進去，摧毀整個 diff 歷史。
- 需要 commit 時，只 `git add <明確的檔案路徑>`，且優先在 Windows 原生環境操作（Claude 的 device_bash 也無法刪除 `index.lock`，git 寫入操作會留下 stale lock）。

**正確的偵測訊號是 `docs/HANDOFF_CLAUDE_CODEX.md` 的「最後更新」欄位與第 5 節變更日誌的最後一列。** 對方有事要說，一定會寫在那裡；那裡沒動，就是沒有新事情。

## 分支

完整策略與 promotion gates 見 `docs/BRANCH_STRATEGY.md`。從下一次 branch consolidation 起採用以下責任分界，不重寫既有歷史：

| 分支 | 用途 |
| --- | --- |
| `main` | 已通過測試、真實 n8n execution evidence 與 Dan 核准的穩定結果；不做日常實驗 |
| `ollama-widget` | 主要產品開發、上架與雙週實驗 branch；產品變更先在這裡整合與驗證 |
| `codex/autoresearch-a2a` | Agent 協作、outbox、協定與裁決紀錄；新產品功能改在 `ollama-widget` 或短期 topic branch |
| `codex/planner-model-probe` | 歷史 planner probe branch；不再繼續開發，也不整條 merge 回產品 branch |

正常流向：`topic/*` → `ollama-widget` → 經端到端驗證後 → `main`。`ollama-widget` 可定期合併到 A2A branch 供 agents 取得最新背景；A2A branch 不整條反向合併進產品 branch。

## 共同依據

- 架構決策：`docs/RUNTIME_AWARE_SYSTEM_SPECIFICATION_ZH.md`
- 實作進度：以程式與測試為準，不以文件宣稱為準

## 詞彙（三方必須一致）

實作成熟度分三層，勿混用：**設計已定** / **已實作且有測試** / **已接線到產品路徑**。
判斷「已接線」的標準是：能從 `chatbot/src/index.js` 的 route 追溯到該模組。

驗證強度分三層：`verified_fixture`（單一固定輸入）/ `verified_parameterized`（多輸入）/ `implemented_untested`。

## 溝通規則

**全部以 `a2a/PROTOCOL.md` 為準**，以下是最容易被違反的四條：

1. **單一寫者（P1）**：你只能寫**你自己身分**的 `a2a/<你>.outbox.jsonl` 與 `a2a/<你>.state.json`（對照上方「你是誰」）。**絕對不要寫入對方擁有的檔案。**
2. **不准空回應（P4）**：讀完沒有新資訊就不要寫。「收到」「看過了沒問題」單獨成則會被 validator 判為 ERROR。沉默是合法且正確的狀態。
3. **迴圈煞車（P5）**：最近 6 則若在兩邊交替且無 `finding`/`decision`，下一個寫的人必須改為 `needsHuman:true` 並停止該主題。
4. **人類閘門（P6）**：`a2a/NEEDS_HUMAN.md` 的項目**只有 Dan 能結案**，兩個 agent 都不得清除或代為決定。

分歧處理：不要覆蓋對方的結論，寫一則 `proposal`/`question` 說明你實際驗證到的證據；第二次往返仍無共識就升級給 Dan。**不要為了讓流程繼續而讓步**——被說服而非被證據改變的結論，在 24/7 下會擴散成系統性錯誤。
