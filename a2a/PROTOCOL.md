# A2A Protocol v1 — Claude ⇄ Codex

**設計者：** Claude（Dan 指派為 A2A 架構規劃者）
**版本：** 1.0 ／ 2026-08-28
**狀態：** 提案中，待 Codex 確認（見 `codex.outbox.jsonl`）

## 如何執行 validator（跨環境）

**不要直接呼叫 `python`。** Codex 於 2026-08-28 實測回報：Windows 環境的 `python` 不在 PATH。改用啟動器，它會依序嘗試 `py -3` / `python` / `python3`，都找不到時讀環境變數 `A2A_PYTHON`：

| 環境 | 指令 |
| --- | --- |
| Windows | `a2a\a2a.cmd --check` |
| Linux / macOS | `./a2a/a2a.sh --check` |
| 直譯器路徑已知 | 設 `A2A_PYTHON` 指向 python.exe 後照上表執行 |

其他子指令：`--digest`（現況摘要）、`--dashboard`（只重建面板）、`--next <agent>`（產生合法訊息 id）。

## 監控面板

`a2a/dashboard.html` —— Dan 用來監看兩個 agent 溝通狀況的頁面。用瀏覽器開啟，每 30 秒自動重新整理。

內容：兩邊的存活狀態與訊息量、**給 Dan 的回報**、待裁決項目、待回應的提問、協定檢查結果、最近 30 則訊息時間軸。

**由 `validate_a2a.py` 在每次 `--check` 時重新產生**，所以只要兩個 agent 有遵守流程第 7 步，面板就是最新的。指令列版本：`python a2a/validate_a2a.py --digest`。

---

## 時區與分工（Dan 2026-08-28 指示）

**所有時間戳為 UTC。Dan 位於 Asia/Taipei (UTC+8)，讀交接簿時請自行 +8。**

**分工：Claude 設計與實作，Codex 執行驗證。** Dan 指出 Claude 的 token 消耗遠高於 Codex 在本機執行，
因此逐檔跑測試這類工作應交給 Codex。Claude 只做最小的 smoke check（模組能否載入、新測試檔本身是否通過），
全套回歸與跨環境驗證交給 Codex。

## 0. 這份協定要解決什麼

現行的 `docs/HANDOFF_CLAUDE_CODEX.md` 是一份「兩個 agent 共同編輯的 Markdown」。它在有人看著的情況下能用，**在 24/7 無人值守下會壞**。已知的失效模式：

| # | 失效模式 | 24/7 下的後果 |
| --- | --- | --- |
| F1 | 兩邊同時 read-modify-write 同一份 Markdown | 後寫的覆蓋先寫的，訊息靜默消失 |
| F2 | 沒有訊息 ID 與消費游標 | 重啟或重讀後重複執行同一件事 |
| F3 | 沒有迴圈煞車 | 兩邊互相回應對方的回應，無限燒 token |
| F4 | 沒有存活偵測 | 對方掛了仍持續寫入虛空 |
| F5 | append-only 無輪替 | 檔案無限增長，每次讀都吃掉大量 context |
| F6 | 沒有人類升級機制 | 意見不合時陷入僵局，或一方片面獲勝 |
| F7 | 約定只寫在文件裡 | 被重新詮釋而漂移（2026-08-28 已實測發生） |
| F8 | 自動 git 操作 | 本 worktree 有 1500 個 CRLF 假差異，一次 `git add -A` 摧毀歷史 |

**F7 是最根本的。** 這與規格審查的 R2 是同一個病：只被「描述」的規矩會被忘記或重新詮釋，只有能被**機器檢查**的規矩才會被遵守。因此本協定附帶 `validate_a2a.py`，**兩邊在每次寫入前後都必須執行它**。

---

## 1. 核心原則

### P1 單一寫者（Single Writer）

**每個檔案只有一個 agent 可以寫。任何情況下都不得寫入對方擁有的檔案。**

| 檔案 | 擁有者 | 其他人 |
| --- | --- | --- |
| `a2a/claude.outbox.jsonl` | Claude | 唯讀 |
| `a2a/codex.outbox.jsonl` | Codex | 唯讀 |
| `a2a/claude.state.json` | Claude | 唯讀 |
| `a2a/codex.state.json` | Codex | 唯讀 |
| `a2a/NEEDS_HUMAN.md` | 兩邊都可 append | **誰都不能刪除或標記為已解決** |
| `a2a/dashboard.html` | 衍生檔案，兩邊都可重新產生 | 見下方例外 |

這一條解掉 F1。沒有共享可寫檔案，就沒有覆蓋問題。

**唯一例外：衍生檔案。** `dashboard.html` 由 `validate_a2a.py` 以確定性函式從兩邊的 outbox 重建，同樣的輸入必然產生同樣的輸出，因此兩邊都寫它是安全的——覆蓋不會遺失資訊，最壞情況只是短暫過期。**不要手動編輯衍生檔案**，會被下次重建覆蓋。

### P2 只 append，不重寫

用 `>>` 追加，每則訊息一行 JSON（JSONL）。**永遠不要讀進整個檔案再整份寫回**——那正是 F1 的成因。

### P3 訊息必須有 ID，消費者維護游標

每則訊息有唯一 `id`。消費者把「處理到哪一則」記在**自己的** state 檔的 `lastProcessedId`。重跑時從游標之後開始，因此重複執行是安全的。解 F2。

### P4 不准空回應

訊息必須攜帶新資訊。**禁止只為了確認而寫入**（「收到」「看過了沒問題」「同意」單獨成則）。若你讀完沒有新東西要說，就什麼都不要寫——沉默是合法且正確的狀態。解 F3 的一半。

### P5 迴圈煞車

若最近 6 則訊息在兩個 agent 之間交替，且其中沒有任何一則 `kind` 為 `finding` 或 `decision`，**下一個要寫的人必須改為寫入 `NEEDS_HUMAN.md` 並停止該主題**。validator 會偵測並拒絕。解 F3 的另一半。

### P6 人類閘門

`needsHuman: true` 的訊息會被 validator 導向 `NEEDS_HUMAN.md`。**兩個 agent 都不得清除、覆蓋或代為決定其中的項目。** 只有 Dan 能。解 F6。

**P6a 轉述人類決定（2026-08-28 補，因應實際缺口）。**
原始設計有個洞：**Dan 的決定是透過對話傳達的，不會出現在檔案裡。** 若嚴格禁止 agent 動 NEEDS_HUMAN，Dan 每做一個決定就得自己去改檔案，那不合理。

因此允許 agent 在**同時滿足**以下條件時標記項目為已解決：

1. Dan 在對話中對該項目做了明確決定（不是暗示、不是可推得）。
2. 標記時必須記錄 **Dan 的原話**、**取得管道**（哪個 agent 的對話）與 **轉述者**。
3. 決定內容若與另一個 agent 有關，必須同時寫一則訊息通知對方。

**不滿足就不能動。** 特別是：不得因為「Dan 應該會同意」而代為結案，也不得把沉默當作同意。

**收到轉述的一方應如何反應：** 轉述是二手資訊。Codex 於 2026-08-28 對 cadence 變更的處理是正確示範——他寫了「我不會只依轉述自行提高頻率」，等到能從自己環境確認才動。**對於會改變自身行為的轉述，應先在自己這側確認再執行；對於純資訊性的轉述，記錄即可。**

### P7 存活偵測

每個 agent 每次執行都必須更新自己 state 檔的 `heartbeat`。若對方的 heartbeat 超過其週期的 3 倍未更新，**停止繼續對它送訊息**，寫一則 `status` 記錄，然後正常結束。不要重試、不要連續告警。解 F4。

### P12 第三方參與者與轉述（2026-08-28 補）

系統實際上有**三個** agent，不是兩個：

| Agent | 位置 | Claude 能否直接觸及 |
| --- | --- | --- |
| `claude` | Anthropic 雲端 + Dan 的機器（檔案橋接） | — |
| `codex` | Dan 的 Windows 機器（桌面版） | **能**，透過 `a2a/` 檔案 |
| `codex-44` | `widm-n8n.csie.ncu.edu.tw` = `140.115.54.44`，**與實際運行的 n8n 同一台**（CLI 版） | **不能** |

**實測（2026-08-28）：** Claude 的 device_bash 無網路（DNS 解不到、curl 回 000）；
雲端容器解得到 `140.115.54.44` 但連線被出口政策擋掉。**Claude 到不了 .44。**
到 .44 的路徑只有：Dan 的機器（可建 SSH tunnel）→ 桌面 Codex 或 Dan 轉述。

`codex-44` 是唯一能對**真實 n8n runtime** 操作的參與者，因此以下事情只有它能做：
重跑 `export_runtime_node_schemas.js` 取得當前 schema、對真實 schema 跑測試、部署。

**P12a 轉述必須帶原始證據。**
經第三方轉述的結果**必須包含指令原文與完整輸出**，不得只給摘要。
理由：這條鏈上沒有人能重跑那些指令來驗證摘要，摘要即不可查證。
「跑過了沒問題」不構成證據，收到這種回報時應要求原始輸出，而不是採信。

**P12b 保留 provenance。**
訊息必須分清**資料來源**（誰實際執行）與**信差**（誰帶回來）。
格式：在 body 開頭寫「以下為 .44 原始輸出，轉述者：<誰>」。
`from` 欄位填信差（因為 outbox 有單一寫者限制），來源寫在 body。

**P12c 對轉述的處置沿用 P6a 的原則。**
會改變自身行為的轉述，先在自己這側確認再執行；純資訊性的，記錄即可。
Codex 於 2026-08-28 對 cadence 轉述的處理是正確示範。

### P11 原始碼檔案所有權（2026-08-28 補，因應實際事故）

**協定原本只規範 `a2a/` 下的訊息檔，完全沒有規範原始碼。結果 30 分鐘內就發生一次覆蓋事故。**

事故經過：Codex 在 `chatbot/src/` 實作 R3，建立了 `publicUrlPolicy.js` 並在 `nodewiseCompiler.js`
加入 `require`。Claude 同時在做 R3，用 `cat >` 建立同名檔案，**覆蓋掉 Codex 的版本**（該檔未追蹤，
git 無備份，內容已無法復原）。更糟的是兩人用了不同的函式名（`validatePublicHttpsUrl` vs
`assertPublicHttpsUrl`），使 `nodewiseCompiler.js` 的 require 取到 `undefined`——
**檔案照樣載入成功，一直到執行到那一行才 TypeError。** 一個看起來完好、實際上壞掉的模組。

這正是 F1（靜默覆蓋）在原始碼層的版本。P1 只保護了訊息，沒保護工作成果。

**規則：**

1. **開工前先宣告。** 要動某個檔案或建立新模組前，先寫一則 `kind: "decision"`，
   `topic` 用工作項 ID（例如 `R3`），`artifacts` 列出你打算建立或修改的**完整檔案路徑清單**。
2. **檢查對方是否已宣告。** 寫入前讀對方 outbox 中同 topic 的 decision。
   路徑有重疊就**停下來協調**，不要「我的比較好所以先寫」。
3. **絕不用 `cat >` / `>` 覆蓋你沒有先讀過的既有檔案。** 用 `>>` 追加，或先讀再改。
   檔案已存在而你沒宣告過它，**一律先讀再決定**。
4. **不要單方面改對方的呼叫端或測試。** 介面名稱不合時，加相容別名並寫訊息議定，
   不要改對方的程式碼去遷就自己的命名。
5. **對方的測試失敗時，先假設是自己的問題。** 特別是只有訊息措辭不合、行為其實正確的情況——
   那代表雙方對設計的理解有差異，值得討論，不是把測試改掉了事。

### P8 病態上限（2026-08-28 修訂）

**修訂前：** 每個 agent 每日最多 20 則。**在一場由人主導的密集工作階段中誤報**——
Claude 27 則、Codex 12 則，交錯模式顯示是真實往返（最長連續 4 則）而非失控。

**修訂理由不是「規則擋到我」，而是原規則量錯了東西。** 這一點必須寫清楚，因為
「agent 因為規則不方便而放寬規則」正是最該被懷疑的動作，Claude 也才剛寫了 planDiff
來防止「自己宣告自己沒問題」。

原規則的缺陷：
- P8 想防的是 F3 失控往返，但 **P5（迴圈煞車）已經直接處理往返**——
  6 則交替且無 finding/decision 就強制升級給人。P8 在重複 P5 的工作。
- 失控在檔案上真正的形狀是**單方面灌訊息**：一方持續發送而對方毫無回音
  （對方掛了、或訊息根本沒被讀到）。單純的每日計數看不出這個形狀，它同時
  **放過**「對死掉的對象發 19 則」也**擋下**「健康往返 21 則」。

**修訂後：**
- 每日 60 則 —— 純粹的病態 backstop，不是工作量限制。
- **新增：對同一對象連續發送 6 則而對方毫無回音 → WARN，7 則 → ERROR。**
  觸發時應停止發送，改寫一則 `to: "human"` 告知 Dan。

**在它真正要防的維度上，新規則比舊規則嚴格。** 這一條上線當天就抓到 Claude
連發 7 則而 Codex 在頻道內未回應（Codex 有回應，但是透過 Dan 口頭轉述，
未寫入 outbox——從檔案的角度他是沉默的）。Claude 依規則停止發送並改寫給 Dan。

**衍生問題（待議）：** 若 agent 的回應只經人口頭轉述而未寫入 outbox，
頻道記錄會與實際協作狀態脫節，dashboard 也會顯示錯誤的存活狀態。
建議：**經人轉述的對方意見，由收到的一方代為記錄，並依 P12b 標明來源與信差。**

### P9 輪替

`*.outbox.jsonl` 超過 500 行時，搬到 `a2a/archive/YYYY-MM/` 並開新檔。**只搬自己的檔案。** 解 F5。

### P10 絕不自動 git

**任何 agent 都不得執行 `git add` / `git commit` / `git push` / `git checkout` / `git stash`。**
本 worktree 是 Windows checkout 經 Linux mount 存取，`git status` 有約 1500 個 CRLF 假差異；一次 `git add -A` 會提交全部並摧毀 diff 歷史。commit 一律由 Dan 手動執行。解 F8。

---

## 2. 訊息格式

一行一個 JSON 物件：

```json
{
  "id": "claude-20260828T050000Z-001",
  "ts": "2026-08-28T05:00:00Z",
  "from": "claude",
  "to": "codex",
  "kind": "proposal",
  "topic": "a2a-protocol",
  "replyTo": null,
  "needsHuman": false,
  "body": "訊息內容。要能被單獨理解，不要依賴對方記得上下文。",
  "artifacts": ["a2a/PROTOCOL.md"]
}
```

| 欄位 | 規則 |
| --- | --- |
| `id` | `<from>-<UTC basic timestamp>-<3 位序號>`，全域唯一 |
| `ts` | ISO 8601 UTC，結尾 `Z` |
| `from` / `to` | `claude` \| `codex` \| `human` |
| `kind` | 見下表 |
| `topic` | 短 slug，用來串同一條討論（例如 `R3`、`schema-digest`） |
| `replyTo` | 對方訊息的 `id`，或 `null` |
| `needsHuman` | `true` 時必須同步 append 到 `NEEDS_HUMAN.md` |
| `body` | 純文字。**不要放 secret、credential、API key。** |
| `artifacts` | 相關檔案路徑（repo 相對路徑），可為空陣列 |

### kind 的語意

| kind | 意義 | 對方必須回應？ |
| --- | --- | --- |
| `question` | 需要對方回答才能繼續 | 是 |
| `proposal` | 提議做某事，需要同意或反對 | 是 |
| `finding` | **已驗證**的新資訊，必須在 `body` 註明驗證方式 | 否 |
| `decision` | 我要做 X，理由 Y | 否 |
| `handoff` | 我做完 X，接下來歸你 | 否 |
| `status` | 進度或存活記錄 | 否 |

### 給 Dan 回報（重要）

**Dan 只會呼叫 Claude，不會逐一檢查兩邊的 outbox。** 因此凡是 Dan 需要知道的事，必須明確標記，否則他看不到：

- 設 `"to": "human"` —— 這則會出現在 dashboard 最上方的「給 Dan 的回報」區。
- 或設 `"needsHuman": true` —— 同時要 append 到 `NEEDS_HUMAN.md`（P6）。

**兩個 agent 都有主動回報的義務**，不能假設「Dan 會自己去看」。每次執行若有以下情形之一，必須寫一則 `to: "human"`：

1. 完成了一件 Dan 交辦的事
2. 發現對方的陳述與實際程式碼不符
3. 連續 3 次執行都沒有任何進展（代表卡住了）
4. 協定 validator 出現 ERROR 且你無法自行修正

`finding` 沒有附驗證方式的，validator 會警告。這是把「實作進度以程式與測試為準」寫成可檢查的規則。

---

## 3. 每次執行的標準流程

```
1. 讀自己的 state.json → 取得 lastProcessedId、自己的 heartbeat
2. 讀對方的 outbox.jsonl → 只取 lastProcessedId 之後的訊息
3. 讀對方的 state.json → 檢查 heartbeat 是否過期（P7）
4. 處理訊息。凡是對方關於程式碼現況的陳述，一律實際讀檔驗證，不照單全收
5. 有新資訊才寫：append 到自己的 outbox.jsonl（P2、P4）
6. 更新自己的 state.json：lastProcessedId、heartbeat、今日訊息計數
7. 執行 validator（見下方「如何執行 validator」）
   → 有 ERROR 就修正後重跑；有 WARN 就在下一則訊息說明
   → 這一步會同時重新產生 a2a/dashboard.html（Dan 的監控面板），所以不可省略
8. 需要人類決定的，同步 append 到 NEEDS_HUMAN.md（P6）
```

**沉默是合法的。** 讀完沒有新東西要說，就只更新 heartbeat 然後結束。

---

## 4. 權限邊界（24/7 無人值守時特別重要）

無人值守時，**兩個 agent 都不得**：

1. 執行 git 寫入操作（P10）
2. 修改 `ollama-widget` 分支相關檔案
3. 執行會產生外部副作用的腳本（部署、寄信、呼叫外部 API、`run_evaluation.py`）
4. 刪除對方建立的檔案
5. 修改 `docs/RUNTIME_AWARE_SYSTEM_SPECIFICATION_ZH.md`，除非 Dan 明確指派該項
6. 代替 Dan 決定 `NEEDS_HUMAN.md` 中的項目

遇到上述任一情況，寫 `needsHuman: true` 的訊息並停止該主題。

---

## 5. 分歧處理

不同意對方的判斷時：

1. **不要覆蓋對方的結論**（P1 在檔案層面已經保證做不到，這裡是語意層面的重申）。
2. 寫一則 `kind: "proposal"` 或 `question`，在 `body` 說明你的理由與**你實際驗證到的證據**。
3. 對方若堅持，第二次往返仍無共識 → 第三則必須 `needsHuman: true`，交給 Dan。
4. **不要為了讓流程繼續而讓步。** 一個被說服而非被證據改變的結論，在 24/7 下會擴散成系統性錯誤。

---

## 6. 與現有檔案的關係

- `docs/HANDOFF_CLAUDE_CODEX.md` **降級為人類閱讀用的現況摘要**，不再是 agent 之間的傳輸層。Dan 想快速了解狀況時看它。agent 之間的實際往來走 `a2a/`。
- 誰更新 HANDOFF？**只有在 Dan 要求時才更新**，避免它變回共享可寫檔案（F1）。
- `AGENTS.md` 指向本協定。

---

## 7. 尚未解決的問題（誠實記錄）

1. **仍然只有輪詢，沒有事件觸發。** 對方寫入時我不會被喚醒。24/7 下這代表延遲等於輪詢週期。若 Dan 的實驗室機器能跑檔案監看（inotify / ReadDirectoryChangesW），這一層可以改善——但那需要一個常駐 process，超出目前架構。
2. **作者身分仍無法在檔案內證明。** 兩邊都有寫入權限。要真正證明需要各自持有對方沒有的秘密並簽章。目前靠 P1 的紀律與 validator 的檢查，這是紀律不是保證。
3. **JSONL 的 append 在極端併發下仍可能交錯。** 單行小於 4KB 時 POSIX `O_APPEND` 實務上安全，但跨 Windows/Linux mount 未經驗證。若實測發現交錯，改為每則訊息一個檔案（`outbox/<id>.json`）。
