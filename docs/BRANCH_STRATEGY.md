# Branch strategy

**狀態：** 2026-09-01 整理稿。這份文件定義從下一次 branch consolidation 起採用的規則；不重寫既有歷史。

## 目標

Dan 希望 branch 的責任單純且可預測：

- `main` 保存已驗證、可回溯的結果。
- `ollama-widget` 是主要產品開發、上架與實驗 branch。
- `codex/autoresearch-a2a`（未來可簡化為 `a2a`）保存 agent 協作協定、訊息與裁決紀錄。
- `codex/planner-model-probe` 是一次性的隔離量測 branch，不再作為平行產品 branch。

## Branch 職責

| Branch | 唯一主要責任 | 允許內容 | 不應承擔 |
| --- | --- | --- | --- |
| `main` | 已驗證結果與穩定基線 | 經測試、真實 n8n execution evidence 與 Dan 核准的整合結果 | 日常實驗、未驗證 prototype、A2A heartbeat/outbox 噪音 |
| `ollama-widget` | 主要產品／研究實作、部署與雙週實驗 | `chatbot/`、`autoresearch/`、測試、部署腳本、必要產品文件 | Agent heartbeat、純協作往返、尚未選入產品的歷史 probe branch |
| `codex/autoresearch-a2a` | Agent 協作與共享研究紀錄 | `a2a/**`、`AGENTS.md`、協作規格與需要 Dan 裁決的紀錄 | 新產品功能的主要開發位置 |
| `codex/planner-model-probe` | 2026-08-29 planner probe 歷史證據 | 保留既有 commit 供追溯 | 繼續開發、整條 merge 回產品 branch |
| `topic/*`、`fix/*` | 一項可驗證變更 | 單一實驗、修正或能力擴充 | 長期保存多個不相關主題 |
| `release/*` | 從 `ollama-widget` 選出的發布候選 | 明確核准的 commits、發布驗證與回滾資訊 | A2A 全歷史或未驗證研究內容 |

## 正常資料流

```text
短期 topic branch
        │
        ▼
ollama-widget ── 真實端到端驗證 + Dan 核准 ──▶ main
        │
        └── 定期合併到 a2a branch，讓 agents 取得最新程式背景

A2A finding / proposal
        │
        └── 若要改產品，從 ollama-widget 開 topic branch 實作
```

方向性規則：

1. 產品 commit 從 `topic/*` 進 `ollama-widget`，驗證後才進 `main`。
2. `ollama-widget` 可以合併到 A2A branch，提供 agents 最新程式背景。
3. A2A branch 不整條反向合併到 `ollama-widget`；需要的產品變更應在 topic branch 重現並驗證。
4. A2A outbox、state、dashboard、snapshot 與純協作文件不進 release branch。
5. Git push、remote branch 移動、branch 刪除與部署仍需 Dan 明確核准。

## 目前歷史為什麼混在一起

`codex/autoresearch-a2a` 目前直接建立在 `ollama-widget` 的 `a6fe2d4` 之上，後續同時承載產品程式、實驗、規格和 A2A 記錄。這是歷史形成的結果，不代表未來仍要混用。

不建議重寫或 filter 現有 A2A 歷史：成本高、會改變 commit id，也會讓 `.44`、個人電腦與實驗室電腦的既有引用失效。但也不能把 A2A branch 直接 fast-forward 回產品 branch，否則 outbox、heartbeat、tasks 與純協作歷史會被永久灌進 `ollama-widget`，違反本文件的責任分界。

正確做法是保留 A2A 歷史，另外從 `ollama-widget` 建立產品 consolidation candidate，以 squash／明確路徑或經審查的 commit series 移植目前產品與實驗成果，排除 `a2a/**` 與純協作檔案。從 cutoff 之後再遵守單向流。

## Consolidation 建議

1. 在移動 remote branch 前，為目前 tips 建立 archive tag 或 backup ref。
2. 從 `origin/ollama-widget` 建立 product candidate，移植 A2A branch 上已驗證的 `chatbot/**`、`autoresearch/**`、部署腳本、測試與產品／研究規格；不得把 `a2a/**`、outbox、heartbeat、tasks 或 snapshot history 整條帶入。
3. Product candidate 通過完整測試與真實 n8n smoke test 後，才由 Dan 核准更新 remote `ollama-widget`。
4. A2A branch 保留既有完整歷史；cutoff 後只直接接受協作／紀錄 commits，並可定期單向合併 `ollama-widget` 取得最新程式背景。產品變更改在 `ollama-widget` 或 topic branch 完成。
5. `main` 暫時不動。每個雙週週期結束時，將已通過端到端驗證的 `ollama-widget` 範圍提升到 `main`。
6. `codex/planner-model-probe` 不整條 merge。其功能已由目前 planner/corpus 工具取代；原 tip `5d36a66` 已保存為 `archive/planner-model-probe-20260829`，remote probe branch 已依 Dan 核准刪除。

## 為什麼不直接合併 `main` 與研究 branch

兩條 branch 雖然共享早期基線，但 benchmark dataset 曾在不同歷史中加入／整理。實測把 `main` 的三個獨有 benchmark commits cherry-pick 到目前研究 tip，立即產生大量 `add/add` 衝突；`Experiments/benchmark/` 在兩個 tips 之間有數百個路徑差異。因此不能用整條 merge 或「選 theirs」處理，否則可能覆蓋已驗證資料。

`main` 的 benchmark 資料應另做內容級資料集稽核：確認 case 數、正規化後內容、結果檔與 provenance，再決定哪些檔案需要移植。它不應阻擋產品 branch 先完成職責整理。

## Commit provenance

目前所有 2026 年 8 月後的 agent-assisted commits 都沿用工作站的 `dan0203` repo identity，因此只看 `Author`／`Committer` 無法分辨是 Dan 親自撰寫、Terra 執行，還是其他 agent 代為提交。

從 consolidation cutoff 之後，agent 產生內容、由 Dan 或已獲授權的 `brain` 協調角色執行的 commit，必須在 message body 保留：

```text
Agent-Origin: brain | executor | opus5 | terra
A2A-Ref: <message-id 或 task-id；沒有則寫 none>
Co-Authored-By: <該 agent／工具的標準署名>
```

- `Author` 仍可使用 Dan 的 repo identity，避免為每個 agent 改全域 Git 設定。
- Dan 已授權 `brain` 在明確的 topic／review branch 上 commit 與一般 push；force-push、remote branch 刪除、部署及 `main`／`ollama-widget` promotion 仍需逐次授權。
- `Agent-Origin` 記錄實際產生／執行變更的 agent；不可把單純 review 者寫成作者。
- `A2A-Ref` 讓未來能從 commit 回查需求、授權與驗證證據。
- Dan 親自完成、沒有 agent 產生內容的 commit 不需要 `Agent-Origin`。

這項規則無法補回舊歷史，只從新 cutoff 往後適用。

## Promotion gates

### `ollama-widget` → `main`

至少需要：

1. 指定 commit 範圍與變更檔案。
2. 對應單元／整合測試通過。
3. 至少一條相關的真實 n8n end-to-end execution evidence。
4. 沒有把 secret、credential value、未清理的 runtime state 或 A2A 暫存檔帶入。
5. Dan 明確核准 promotion。

### 寫入 A2A branch

必須符合 `a2a/PROTOCOL.md`：單一寫者、合法 id、非空回應、需要時加鎖、寫後 validator 無 ERROR。
