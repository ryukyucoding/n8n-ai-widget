# 發布計畫 — 依 Codex 判斷，Dan 於 2026-08-28 核准

> Dan 原話：「請依照 Codex 對 git/deploy 的判斷來做，因為我不是很懂 git，但你們都要負責檔案的安全」

**這份計畫的前提：Dan 不需要懂 git，也不該被要求懂。** 因此每一步都標明由誰執行，
需要 Dan 的地方只有「看說明、決定要不要」，不含任何他得自己判斷正確性的指令。

---

## 分工（不得互換）

| 角色 | 職責 | 明確不做 |
| --- | --- | --- |
| **Dan** | 決定要不要發布、核准要納入的變更清單 | 不需要執行任何 git 指令 |
| **Codex** | **所有 git 寫入與部署的唯一執行者**（Windows 原生環境） | 不從 Linux mount 操作 |
| **Claude** | 寫程式、測試、列出變更清單、說明每項改了什麼 | **完全不碰 git，不碰部署** |

Claude 不執行 git 的理由不是分工偏好，是安全：此 worktree 經 Linux mount 看到約 1500 個
CRLF 假差異，Claude 這側任何 `git add -A` 等級的操作都會摧毀 diff 歷史。

---

## 流程（Codex 的判斷，逐條保留）

1. **A2A 研究期間 `ollama-widget` 保持不動。** 不在研究分支上直接推它。
2. 要發布時，**從 `ollama-widget` 開一條短命 release 分支**。
3. **只 cherry-pick 明確核准的 product commit**，不要合併整條研究分支。
   研究過程的文件、協定、快照都不該進產品分支。
4. **只用 Windows 原生 Git，且只用顯式路徑 staging**（`git add <確切路徑>`）。
   **絕不透過 Linux mount 的 worktree 操作，絕不 `git add -A` / `git add .`。**
5. **`.gitattributes` 在沒有專門稽核前不要動。** 那 1500 個 CRLF 假差異處理錯會比現在更難收拾。
6. **部署腳本必須指定明確的 release worktree 與使用者授權的執行者。**
   `deployBetaChatbotOn44.sh` 預設指向 `runtime-compiler-integration`，不是 release 分支。
7. **A2A 本身不授權任何 git 寫入或部署。** 每一次都要 Dan 明確同意。

---

## 發布前的檢查清單

發布前這些必須全部為真，任一項不成立就不發：

- [ ] Dan 已看過並核准「要納入哪些檔案」的清單
- [ ] `chatbot` 全套測試通過（`node --test src/`），已知的既有失敗已個別說明
- [ ] R3 的 URL 政策已在**真實 n8n runtime** 上驗證過，不只有單元測試
- [ ] 部署腳本的 `BETA_WORKTREE` 已顯式指向 release 分支的 worktree
- [ ] 確認部署的是獨立 beta container，不會取代 `n8n-chatbot-1`
- [ ] 已執行 `a2a.sh --snapshot pre-release` 留下備份

**目前狀態：以上沒有任何一項完成。R1 / R2 / R17 三個 P0 也都還沒實作。**
Claude 的建議是不要現在發布，理由見 `SPEC_REVIEW_v0.3_CLAUDE.md`。

---

## 檔案安全機制（Dan 授權後建立）

Dan 說「你們都要負責檔案的安全」。目前有三層，都不依賴 Dan 操作：

| 機制 | 防什麼 | 指令 |
| --- | --- | --- |
| **鎖**（P11） | 兩個 agent 同時改同一檔案 | `a2a.sh --lock <path> --as <agent> --topic <T>` |
| **快照** | 未進 git 的成果被覆蓋或刪除 | `a2a.sh --snapshot <label>`；`--check` 時自動執行 |
| **git 禁令**（P10） | 誤觸 CRLF 地雷摧毀歷史 | 兩個 agent 都不得執行 git 寫入 |

快照存在 `a2a/snapshots/<時間戳>_<標籤>/`，保留最近 20 份，已加入 `.gitignore`。
**復原方式：直接把檔案從快照目錄複製回原路徑即可，不需要任何 git 知識。**

快照不是版本控制的替代品——它是「東西被毀掉之前的最後一道防線」。
之所以需要它，是因為 2026-08-28 已經真的毀掉過一次：Claude 用 `cat >` 覆蓋了
Codex 未追蹤的 `publicUrlPolicy.js`，內容永久遺失。
