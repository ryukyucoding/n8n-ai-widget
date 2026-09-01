# AGENTS.md

本 branch 是 n8n AI Widget 的產品／實驗工作區。Agent 協作訊息與 outbox 不存放在這裡；A2A 傳輸層位於 `codex/autoresearch-a2a` 的獨立 checkout。

## Branch 職責

完整策略見 `docs/BRANCH_STRATEGY.md`。

| Branch | 用途 |
| --- | --- |
| `main` | 已通過測試、真實 n8n execution evidence 與 Dan 核准的穩定結果 |
| `ollama-widget` | 主要產品開發、上架與雙週實驗 branch |
| `codex/autoresearch-a2a` | Agent 協作、outbox、協定、證據交接與 Dan 裁決紀錄 |
| `topic/*`、`integration/*` | 有界功能、修正與 consolidation 候選 |

正常流向：`topic/*` → `ollama-widget` → 真實端到端驗證與 Dan 核准 → `main`。

## 開工前

1. 確認自己位於 Dan 指派的 `topic/*` 或 review branch；不要直接修改已部署的 checkout。
2. 先讀 `docs/RUNTIME_AWARE_SYSTEM_SPECIFICATION_ZH.md` 與任務直接涉及的程式／測試。
3. 實作狀態以程式、測試與真實 execution evidence 為準，不以文件宣稱為準。
4. 不要假設工作區中所有變更都是自己造成的；保留使用者與其他 agent 的改動。
5. 不要把 A2A outbox、state、dashboard、snapshot、heartbeat 或純協作 handoff 複製進本 branch。

## Git 與發布邊界

- `brain` 可在 Dan 明確指派的有界 topic／review branch 執行 commit 與一般 push；必須使用精確路徑 staging，並在 commit body 記錄 `Agent-Origin`、`A2A-Ref` 與 `Co-Authored-By`。
- 其他 agents 除非 Dan 對該次動作另行授權，不得 commit 或 push。
- 所有 agents 都不得自行 force-push、刪除 remote branch、移動 `main`／`ollama-widget`、部署或 promotion。
- 絕不使用 `git add -A`、`git add .`、`git commit -a`、`git checkout -- .` 或 `git stash`。Windows／Linux mount 的換行符差異可能製造大量假變更；只 stage 明確檔案。
- Push、merge 或部署前，忠實回報測試結果；失敗或未執行的步驟不可寫成通過。

## 共同架構與成熟度詞彙

- 架構依據：`docs/RUNTIME_AWARE_SYSTEM_SPECIFICATION_ZH.md`
- Branch promotion：`docs/BRANCH_STRATEGY.md`

實作成熟度必須分開記錄：

1. **設計已定**：規格與介面已明確。
2. **已實作且有測試**：有程式碼與自動化測試。
3. **已接線到產品路徑**：可從 `chatbot/src/index.js` 的 route 追到該模組。

驗證強度：

- `verified_fixture`：單一固定輸入已驗證。
- `verified_parameterized`：多輸入已驗證。
- `implemented_untested`：已有程式但無執行證據。

## 安全與資料邊界

- 不得把 credential value、API key、token、password、cookie 或未遮罩個資寫入 repo、prompt、測試輸出或 log。
- Planner 不產生 raw n8n workflow JSON 或任意 JavaScript；compiler 擁有 deterministic workflow 組裝。
- Static verification 不等於 execution success；宣稱可執行必須有相符的 n8n execution evidence。
- 外部寫入、credential 綁定、部署與 branch promotion 必須保留人類確認邊界。

## 測試

產品變更至少執行直接相關測試。準備整合或 promotion 時，執行完整 source tests：

```bash
node --test chatbot/src/*.test.js
```

影響 `autoresearch/` 時，再執行相應 `autoresearch/**/*.test.js`；影響 Python repair／verifier 時，執行相應 Python tests。每兩週報告前，還必須跑至少一條相關的真實 n8n end-to-end 路徑。
