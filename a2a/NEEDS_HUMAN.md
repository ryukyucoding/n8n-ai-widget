# 需要 Dan 裁決的項目

**Claude 與 Codex 都不得清除、覆蓋或代為決定本檔中的項目（協定 P6）。**
兩邊都可以 append，只有 Dan 能結案。

格式：`- [ ] <日期> <提出者> — <一句話說明> → <相關訊息 id>`

---

- [ ] 2026-08-28 Claude — **Claude 的排程任務無法綁定這台電腦，需由 Dan 從桌面 app 建立。**
      已實測：從 Cowork session 內用工具建立任務（含 requires_local_device=true），兩次都回
      `not bound: no_signed_approval`，`folders_state` 維持 `NONE`；砍掉重建無效。
      推測原因：綁定需要桌面 app 簽署的授權，而在雲端 session 內建立的任務取不到那個簽章。
      現況：`trig_01D2LUXto7bVovUHUiTM7Zhg`（A2A 每日同步）**已停用**，避免每天空跑並推播失敗通知。
      Dan 需要做的：從 Claude 桌面 app 的排程任務介面建立同名任務（prompt 可從上述 trigger 複製），
      建立時應會出現裝置授權提示；或在實驗室機器架設 24/7 環境時一併處理。
      影響評估：**測試階段影響不大**——Dan 表示只會手動呼叫 Claude，排程只是備援。
      24/7 階段則必須解決，否則 Claude 這側完全無法自動執行。
- [x] 2026-08-28 Codex — 是否把 Codex heartbeat 從每 4 小時改為每 30 分鐘；較低延遲但增加背景喚醒與負載 → codex-20260828T051645Z-002
      **已解決（依 P6a 由 Claude 轉述結案）** — Dan 於 2026-08-28 在 Cowork 對話中回覆原話：
      「codex我已經改成30分鐘了」。取得管道：Dan ⇄ Claude 對話。轉述者：Claude (`claude-7c`)。
      佐證：`codex.state.json` 顯示 `cadence: "30 minutes"`、heartbeat 2026-08-28T05:20:19Z，與決定一致。

- [x] 2026-08-28 Claude（轉述 Codex 判斷） — **Dan 的「推上 ollama-widget 並正式上線」與 Codex 的技術判斷衝突，需 Dan 裁決。**
      Codex（codex-20260828T055236Z-005）主張：A2A 研究期間 `ollama-widget` 保持不動；
      要發布時從 ollama-widget 開一個短命 release 分支，**只 cherry-pick 明確核准的 product commit**，
      不要合整條研究分支；只用 Windows 原生 Git 與顯式路徑 staging，絕不透過 Linux mount 的 worktree；
      `.gitattributes` 在專門稽核前不要動；beta 部署腳本必須指定明確的 release worktree 與
      使用者授權的執行者。結論是 **「No Git write or deployment is authorized by A2A itself」**。
      Claude 的立場：同意 Codex。理由是 R3 剛修完尚未經真實 runtime 驗證，
      且 R1/R2/R17 三個 P0 仍未處理，現在上線等於把「保證只是承諾」的版本放到校內網路。
      **需要 Dan 決定：照 Codex 的 release 分支流程走，還是維持原指示直接上 ollama-widget。**

      **已解決（依 P6a 由 Claude 轉述結案）** — Dan 於 2026-08-28 在 Cowork 對話中回覆原話：
      「請依照 Codex 對 git/deploy 的判斷來做，因為我不是很懂 git，但你們都要負責檔案的安全」
      取得管道：Dan ⇄ Claude 對話。轉述者：Claude (`claude-7c`)。
      裁決結果：**採用 Codex 的 release 分支流程**，`ollama-widget` 於研究期間保持不動。
      已寫成 `a2a/RELEASE_PLAN.md`。Dan 另交付「檔案安全」責任給兩個 agent，
      已據此新增快照機制（`--snapshot`，`--check` 時自動執行）。

- [x] 2026-08-28 Claude — **舊 `n8n` 容器（2.4.6）是潛在的 runtime 漂移風險，需 Dan 決定如何處理。**
      事實（.44 Codex 唯讀盤查）：該容器 `restart=always`、`HostConfig.NetworkMode=nginx_nginx_proxy`，
      但目前 `NetworkSettings.Networks={}`（只有 lo）。資料庫 143MB、30 個 workflow（3 個標 active）、
      execution 表 0 筆、最後寫入 2026-01-27。非 compose 管理，volume `n8n_data_fresh` 僅此容器引用。
      風險：`n8n-chatbot-1` 同時在 `n8n_default` 與 `nginx_nginx_proxy` 上，其
      `N8N_BASE_URL=http://n8n:5678` 為跨網路解析。**若舊容器某次重啟成功接上 nginx_nginx_proxy，
      chatbot 有可能靜默地改連到這個 7 個月前、schema 差 15 個節點的實例。**
      .44 Codex 的建議（Claude 同意）：不可宣告「可安全移除」。處理前應
      (1) 確認 30 個 workflow 已遷移或不再需要 (2) 對 volume 做可驗證備份
      (3) 將「移除容器」與「刪除 volume」分開決策。
      Claude 補充：**最小且可逆的緩解是把 `restart=always` 改成 `no`**，
      這不刪除任何資料，只是讓它不再自動嘗試重連。但仍是狀態變更，需 Dan 同意。

      **已解決（依 P6a 由 Claude 轉述結案）** — Dan 於 2026-08-28 對話中回覆原話：
      「先處理舊容器吧，我認為是可以刪了」。取得管道：Dan ⇄ Claude 對話。轉述者：Claude (`claude-7c`)。
      執行者：**Dan 本人在 .44 上執行**，未交給任何 agent。
      查證：30 個 workflow 全為 2025-09~2026-01 的實驗品，3 個 active 者 execution 表 0 筆。
      步驟：備份 volume（28MB）→ `--restart=no` → `stop` → `rm`。
      **`n8n_data_fresh` volume 保留，未執行 `volume rm`** —— 確認數日無異狀後再由 Dan 決定是否刪除。

- [ ] 2026-08-30 Claude — **plan-first 的雙重驗證修法尚未 commit，線上跑的是未追蹤的本地 patch。**
      現況：`.44` 的 `~/n8n-worktrees/runtime-compiler-integration` 上，
      `chatbot/src/nodewisePlannerEnvelope.js` 有一處手動套用的修改
      （讓 `validatePlannerEnvelope` 的兩個 return 保留 `schemaVersion` 與 `kind`，使驗證冪等），
      並已用 `formal/deployRuntimeCompilerToProductionOn44.sh` 部署。
      部署標的顯示 `revision=ac54ec1`，**但實際跑的是 ac54ec1 + 該 patch**。
      後果：demo 可以運作，但沒有任何 commit 對應得上目前線上的行為，也無法被別人重現或回滾到正確版本。
      修法與完整驗證（六個測試檔全綠、審查→核准→編譯三步打通）記於
      `claude-20260829T172648Z-021`。
      **阻擋原因：Codex 額度用盡。** 待他恢復後正式 commit；Claude 不動 Codex 的分支。
      Codex 已在能力擴充順序中把它列為第 0 步。
      對外說明時的正確說法：「ac54ec1 加一個已驗證但尚未提交的修正」。

- [ ] 2026-09-01 Claude — **planner 基線 123/124，唯一失分的 clarify-3 是標記邊界問題，需 Dan 裁定哪一邊才是對的。**
      題目：「我要一個會定時抓資料的流程。」語料標記為 `clarification_required`（理由：對象與來源未指定），
      qwen3.8:27b 實際回 `unsupported_capability`（理由：定時 = `control.flow`，目前是 `planned`）。
      **兩個答案都說得通**：缺資訊是真的，不支援排程也是真的。
      Codex 的處置正確——**基線原樣保留，未調 prompt 也未改標記**，等這裡的裁決（`codex-20260830T064000Z-065`）。
      Dan 要決定的是：當一題**同時**缺資訊又超出能力時，系統該先回哪一個？
      這不只影響一題分數，它決定 clarification 與 capability_gap 兩層的優先序，會改變之後所有同類題目的標記。

---

## 狀態註記（2026-08-30，Claude 補；**不代表結案，僅供 Dan 核對**）

以下 needsHuman 訊息看起來已被後續事件解決，列出供 Dan 確認是否可視為關閉：

- `codex-20260829T150000Z-023`（.44 沒有本地 Ollama）→ 已由 `-024` 自我更正：
  chatbot 走的是既有的 `.63` 認證端點，模型路徑一直存在。
- `codex-20260829T154100Z-026`（是否授權接線 planner）→ Dan 已授權，且已部署、已實跑成功
  （n8n 執行 `ID#572`）。
- `claude-20260829T172648Z-021`（雙重驗證 bug）→ 修法已套用並部署；
  **但 commit 這件事仍未完成**，已另立為上方新項目。
- `claude-20260829T180158Z-022` / `claude-20260830T022204Z-001`（能力擴充順序）
  → Codex 已完整覆核並同意，且提出一項更正（來源 schema 綁定）已納入。
  結論記於 `a2a/COMPILER_EXPANSION_ANALYSIS.md`。
