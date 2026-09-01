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

不建議重寫或 filter 現有歷史：成本高、會改變 commit id，也會讓 `.44`、個人電腦與實驗室電腦的既有引用失效。正確做法是在一個共同 cutoff 讓 `ollama-widget` 與 A2A branch 對齊，然後從 cutoff 之後開始遵守新的單向流。

## Consolidation 建議

1. 在移動 remote branch 前，為目前 tips 建立 archive tag 或 backup ref。
2. `origin/ollama-widget` 是 `origin/codex/autoresearch-a2a` 的祖先，因此可 fast-forward；先在候選 branch 跑完整測試與真實 n8n smoke test，再由 Dan 核准更新 remote `ollama-widget`。
3. 讓 A2A branch 以同一個 cutoff 為起點；之後只直接接受協作／紀錄 commits。產品變更改在 `ollama-widget` 或 topic branch 完成。
4. `main` 暫時不動。每個雙週週期結束時，將已通過端到端驗證的 `ollama-widget` 範圍提升到 `main`。
5. `codex/planner-model-probe` 不整條 merge。其 public URL、approval、prompt 與 final-output 保證已被後續研究實作取代；若仍需要 standalone probe 的 authenticated endpoint 支援，只把那一個需求以新 topic commit 移植到目前程式。完成核對後，可先加 archive tag，再由 Dan 決定是否刪除 remote branch。

## 為什麼不直接合併 `main` 與研究 branch

兩條 branch 雖然共享早期基線，但 benchmark dataset 曾在不同歷史中加入／整理。實測把 `main` 的三個獨有 benchmark commits cherry-pick 到目前研究 tip，立即產生大量 `add/add` 衝突；`Experiments/benchmark/` 在兩個 tips 之間有數百個路徑差異。因此不能用整條 merge 或「選 theirs」處理，否則可能覆蓋已驗證資料。

`main` 的 benchmark 資料應另做內容級資料集稽核：確認 case 數、正規化後內容、結果檔與 provenance，再決定哪些檔案需要移植。它不應阻擋產品 branch 先完成職責整理。

## Commit provenance

目前所有 2026 年 8 月後的 agent-assisted commits 都沿用工作站的 `dan0203` repo identity，因此只看 `Author`／`Committer` 無法分辨是 Dan 親自撰寫、Terra 執行，還是其他 agent 代為提交。

從 consolidation cutoff 之後，agent 產生或代為執行的 commit 必須在 message body 保留：

```text
Agent-Origin: brain | executor | opus5 | terra
A2A-Ref: <message-id 或 task-id；沒有則寫 none>
Co-Authored-By: <該 agent／工具的標準署名>
```

- `Author` 仍可使用 Dan 的 repo identity，避免為每個 agent 改全域 Git 設定。
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
