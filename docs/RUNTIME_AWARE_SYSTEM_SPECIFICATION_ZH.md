# Runtime-Aware n8n Workflow 系統規格

**版本：** 0.2
**適用分支：** `codex/autoresearch-a2a`  
**最後更新：** 2026-08-25

> 這是一份架構規格，不是宣傳稿。每項能力均標示為「已驗證」、「已有程式骨架」或「尚未實作」。除非寫為已驗證，系統不可對使用者宣稱該能力已可用。

## 1. 問題與前因

本研究的原始做法是以微調後的 Create model，將自然語言直接生成完整 n8n workflow JSON。這條路有明確價值：模型已學到 workflow 的基本結構，能快速產出雛形。然而實測也暴露了根本限制：模型訓練時看到的 n8n 節點型別、版本、參數名稱與連線埠，可能已和目前執行中的 n8n runtime 不一致。

這不是單純 JSON 格式問題。JSON 可以合法，workflow 仍可能因為節點不存在、參數改名、type version 不相容、連線埠不同、credential 未設定，或資料形狀錯誤而無法執行。過去 Easy-100 的 runtime-aware 批次觀察到，大部分候選 workflow 仍被 runtime 靜態檢查阻擋；這表示「重新要求模型輸出一份 JSON」不是可靠的修復策略。

因此本系統把責任拆開：模型處理使用者真正想自動化的事情；由 runtime-aware compiler 根據**目前安裝的 n8n schema**，用受控的 skill 組裝 workflow。目標不是保證每個自然語言需求都能建立，而是讓每個結果都有可理解的狀態：可規劃、需要補問、目前不支援、可建立草稿、可執行，或已由輸出契約驗證。

## 2. 產品承諾與非承諾

### 2.1 產品承諾

1. 不把「看起來合理的 JSON」誤稱為可執行 workflow。
2. 使用者在 JSON 建立前，能先閱讀並修正語意計畫。
3. 已存在的 credential 可直接綁定；不存在的 credential 不阻止建立完整的 inactive draft。
4. API key、OAuth token、密碼與真正的個人敏感資料不會交給 planner 或 compiler。
5. 每次外部寫入或真正執行前，都有可見的確認邊界。
6. 不支援的需求要明講缺少哪個 capability/skill，而不是假裝已建立 workflow。

### 2.2 本版本不承諾

1. 不承諾所有 n8n 節點或社群 template 都可自動遷移。
2. 不承諾靜態驗證通過就代表商業語意、權限或外部服務結果正確。
3. 不承諾 planner 可自行取得 credential、替使用者建立外部帳號，或知道私有 API 的正確欄位。
4. 不承諾目前的 Compiler Beta 是通用自然語言生成器；正式測試版目前只包含少數受驗證 pattern。

## 3. 共同事實與責任分界

整套流程必須共用兩份相連但不同層級的共同事實。第一份是 **Declarative Pipeline IR**：planner 產生的、與 n8n 節點無關的語意中介表示，描述 source、transform、filter、branch、sink、資料形狀與外部副作用；不含 node type、credential value、n8n expression 或 JSON。第二份是 **Canonical Workflow**：compiler 依 IR、已核准 plan 與目前 runtime schema 產生的標準 n8n workflow JSON。靜態驗證、credential binding、建立 draft 與執行證據都必須引用 canonical workflow，而不是各自重建不同 JSON。

這個分層避免 planner 被舊版 n8n schema 綁死，也避免 skill 同時混充巨集 template 和微型 node 指令。巨集 workflow 只能是多個原子 skill 組成的已驗證 recipe；真正可重用的單位是具有明確輸入、輸出、資料形狀與風險的 skill。

| 元件 | 負責什麼 | 明確禁止什麼 |
| --- | --- | --- |
| Planner | 理解目標、提出澄清問題、產生人可讀 plan 與 Declarative Pipeline IR | 產生 raw n8n JSON、讀取 secret、任意 JavaScript |
| Plan Review Gate | 建立 plan fingerprint、保證只有使用者核准的同一版計畫可編譯 | 讓舊核准通過新版計畫 |
| Skill Registry | 宣告 compiler 真正擁有的 capability、風險、credential/configuration 要求 | 把「n8n 裝了某節點」誤記為系統已支援 |
| Compiler | 使用當前 runtime schema，將 IR 組裝為節點/參數/連線與受控程式碼模板 | 猜測未宣告的商業語意或任意修補 |
| Static Verifier | 檢查節點型別、版本、條件參數、連線、資料形狀、policy 與輸出契約 | 宣稱 workflow 已在真實服務成功執行 |
| Setup Manifest | 列出 credential 身分與使用者要填的 configuration；決定草稿是否 inactive | 保存 API key、token、密碼或把它們送給模型 |
| n8n Setup UI | 選擇/建立 credential、填寫 private configuration、執行 workflow | 透過聊天把 secret 回傳模型 |
| Execution Verifier | 根據明確 output contract 蒐集執行證據 | 無證據地標示 success |

## 4. 端到端流程

```mermaid
flowchart TD
  U[使用者自然語言需求] --> I[Intent intake]
  I --> P[Planner: 語意計畫]
  P --> Q{是否需要補問?}
  Q -- 是 --> U
  Q -- 不支援 --> G[Capability gap: 說明缺少 skill]
  Q -- 可規劃 --> R[Plan review: 使用者閱讀]
  R --> D{使用者決定}
  D -- 修正 --> P
  D -- 取消 --> X[不建立 workflow]
  D -- 核准 --> S[Declarative Pipeline IR]
  S --> K[Skill registry + runtime schema]
  K --> C[Compiler: canonical workflow]
  C --> V{Static verification}
  V -- 失敗 --> F[回傳 findings / 重新規劃]
  V -- 通過 --> M[Setup Manifest]
  M --> B{既有 credential 與設定是否完整?}
  B -- 否 --> W[建立 inactive draft]
  W --> N[n8n setup: 建立或選擇 credential]
  B -- 是 --> E{包含外部寫入?}
  N --> E
  E -- 是 --> H[顯示動作與目的地，等待確認]
  E -- 否 --> T[可受控執行]
  H --> T
  T --> O[Output-contract evidence]
  O --> Z[執行通過 / 失敗]
```

### 4.1 狀態機

| 狀態 | 進入條件 | 使用者能做什麼 | 系統禁止什麼 |
| --- | --- | --- | --- |
| `intake` | 收到需求 | 描述或補充目標 | 直接編譯 |
| `clarification_required` | 關鍵語意不足 | 回答具體問題 | 猜測會改變流程的資訊 |
| `capability_gap` | 需要的 skill 不存在 | 儲存需求、換模式，或明確要求降級草稿 | 偽造骨架為完成結果 |
| `plan_review_required` | planner 可提出可讀計畫 | 核准、修正、取消 | 尚未核准就輸出 JSON |
| `plan_revision_requested` | 使用者提出修正 | 等待新版 plan | 以舊 plan 的核准編譯新版 |
| `plan_approved` | fingerprint 對應的 plan 被核准 | 進入編譯 | 改動 plan 而不重新核准 |
| `degraded_draft_approved` | 使用者接受明確 placeholder | 建立標示不完整的 inactive draft | 標示為可執行或自動啟用 |
| `static_validation_failed` | canonical workflow 不相容 runtime | 看 findings、修正計畫 | 建立為 ready workflow |
| `ready_to_create_draft` | 靜態通過但 setup 尚缺 | 建立 inactive draft | 自動執行 |
| `setup_required` | draft 已建立且仍缺 credential/config | 到 n8n 完成 setup | 在聊天索取 secret |
| `confirm_external_write` | workflow 會寄信、上傳、刪除或寫外部系統 | 確認或取消 | 默默執行外部寫入 |
| `ready_to_run` | setup 完整、必要確認已完成 | 在 n8n 執行 | 宣稱已有結果 |
| `execution_passed/failed` | 有輸出契約與執行證據 | 啟用、保存、修改或除錯 | 用靜態結果取代執行證據 |
| `auto_repair_requested` | 執行錯誤完成脫敏且在允許修復範圍 | 閱讀修復 plan 或取消 | 直接改寫有外部副作用的 workflow |

## 5. 使用者體驗規則

### 5.1 先規劃，再建立

使用者看到的是短 plan，而不是 JSON。例如：

```text
目標：每天彙整指定 RSS 的十篇新文章並寄給團隊。
步驟：排程 -> 讀取 RSS -> 篩選與去重 -> 限制十篇 -> 產生 Markdown -> 寄送 email。
需要設定：SMTP credential、寄件人、收件人。
預期輸出：一封含十篇文章的 Markdown digest。

[核准建立草稿] [修改計畫] [取消]
```

使用者若說「改成只保留 12 小時內的文章」，系統必須把整份 plan 作為新版，產生新 fingerprint。系統會顯示 **Plan Diff**：變更若涉及拓樸、credential、外部寫入、資料目的地或權限，使用者必須完整重審；若只改不改變風險的常數或格式，仍需明確核准新版，但只需對差異快速核准。fingerprint 永遠不重用，差異式審核只降低閱讀摩擦，不降低一致性要求。

### 5.2 何時詢問 configuration

採混合策略：

- **會改變 workflow 拓樸或語意**的值在 planning 前或 review 時詢問。例如：要寄 Email 還是 Slack、每 30 秒還是每日、成功後上傳還是刪除。
- **不會改變拓樸、且不敏感**的值應在 review 階段以結構化 Form Card 收集，直接寫入 draft。例如：RSS URL、篩選關鍵字、每日執行時間、最多處理筆數。
- **不會改變拓樸、但屬敏感資料**的值可在 draft 後由 Setup Manifest 收集。例如：寄件人、收件人、特定 private folder ID；它們不得放入 planner context。
- **secret 或高度敏感資料**不進聊天。使用者只在 n8n credential UI 或受隔離的 setup form 設定。

### 5.3 Credential 行為

1. 系統只查 credential 的可選名稱、服務類型與可用狀態。
2. 若已有對應 credential：綁定名稱/ID，compiler 與 planner 都不會看到 value。
3. 若沒有：仍建立包含該節點的 inactive draft，回覆「需建立 A、B、C credential」與跳轉 n8n 的 setup 指引。
4. 若 workflow 有外部寫入，即使 credential 已就緒，也要在執行前確認目的地與動作。

## 6. Skill 與 compiler

Skill 不是單純 prompt，也不是任意的 rule-based function。它是一份明確能力契約：說明可接受什麼語意輸入、需要什麼 setup、允許 compiler 組裝什麼 runtime node、資料形狀、可能的風險、驗證方式與拒絕條件。模型可選擇與排列 skill；compiler 則必須照 skill 合約產生 runtime JSON。

每個原子 skill 必須宣告 `inputShape`、`outputShape`、欄位 schema、credential/configuration 要求、side effect、runtime mapping 與 verification contract。資料形狀至少區分 `SingleItem<T>`、`ItemList<T>`、`Binary<T>`、`NoOutput`。如果上游與下游資料形狀不相容，IR 必須明示 aggregate、select-first、split 或 batch 策略；compiler 不得猜測 n8n 隱式迴圈是否合理。

### 6.0 Declarative Pipeline IR v1

IR 是 planner 與 compiler 的唯一協議，不是 n8n JSON 的縮寫。最小例子：

```json
{
  "version": "1.0",
  "goal": "取得 user 2 的 todos 並輸出統計",
  "steps": [
    {"id": "start", "kind": "trigger.manual", "outputShape": "SingleItem<Empty>"},
    {"id": "todos", "kind": "source.http_get", "urlRef": "public:jsonplaceholder/todos?userId=2", "outputShape": "ItemList<Todo>"},
    {"id": "summary", "kind": "transform.count_false_boolean", "input": "todos", "field": "completed", "outputShape": "SingleItem<TodoSummary>"}
  ],
  "expectedOutput": {"shape": "SingleItem<TodoSummary>", "fields": ["totalTodos", "incompleteTodos"]}
}
```

IR v1 不含任意 expression 或 code。日期、字串、數學與欄位引用未來應採受限且型別化的 expression AST，再由 compiler 映射為 n8n expression；禁止將使用者文字直接串進 JavaScript。這個 AST compiler 是第二階段，在完成前只能用既有 transform skill 或回報 capability gap。

### 6.1 目前 registry 中的能力

| Skill | 狀態 | 風險 | 說明 |
| --- | --- | --- | --- |
| `trigger.manual` | 已實作 | read only | 手動觸發 |
| `http.public_get` | 已實作 | read only | 固定公開 HTTPS GET |
| `transform.select_fields` | 已實作 | read only | 單一物件選欄位 |
| `transform.count_false_boolean` | 已實作 | read only | 統計布林 false |
| `transform.join_object_and_count` | 已實作 | read only | 合併物件與 items 統計 |
| `output.one_object` | 已實作 | read only | 明確單一物件輸出 |
| `workflow.daily_rss_digest` | 已驗證 prototype | read only | 排程、RSS、篩選、限制與 Markdown digest |
| `delivery.smtp_email_draft` | 已驗證 draft prototype | external write | 可建立 email draft；需 SMTP、寄件人與收件人 |
| `http.authenticated_request` | 尚未實作 | external write | 需設計 credential binding 與允許的請求 schema |
| `control.flow` | 尚未實作 | read only | 通用 IF/Wait/Retry/迴圈 |

### 6.2 已驗證 evidence

- Public selection workflow：建立、readback、手動執行皆成功。
- Todo aggregation / C07：建立、readback、手動執行成功，輸出 `name`、`email`、`totalTodos`、`incompleteTodos`。
- Twitch status：建立、readback、手動執行成功。
- RSS digest：建立並手動執行成功，產出 10 筆 Markdown digest。
- RSS email draft：workflow 建立與 readback 成功；尚未以 SMTP credential 進行真實寄送驗證。

這些是受限 pattern 的 evidence，不可外推為「能生成任意 n8n workflow」。

## 7. 資料與隱私模型

### 7.1 Pre-LLM 防線

聊天 UI 與 gateway 都必須在任何 planner 呼叫前執行 DLP/redaction。UI 先以 API key/token/password 常見格式、JWT、私鑰區塊與 entropy heuristic 偵測，命中時阻止送出或替換為 `{{SECRET_PLACEHOLDER}}`；gateway 再執行一次以防繞過 UI。系統要引導使用者到 n8n Credentials 或隔離 setup form 輸入 secret。

Regex 與 entropy 偵測並非完美 DLP；它是降低意外外洩的防線，不可作為傳送或儲存 secret 的正當理由。被遮罩的內容也不得寫進 analytics、chat history 或 debug logs。

### 7.2 可進 planner 的資料

- 使用者的非敏感目標、限制、期望輸出。
- 抽象 capability，例如「需要 Google Drive 上傳」。
- runtime skill ID、schema revision、是否存在符合服務類型的 credential。
- placeholder，例如 `{{recipient_email}}`；不可使用真正 email。

### 7.3 不可進 planner/compiler/log 的資料

- API key、token、password、OAuth client secret、authorization header。
- 真實 credential value。
- 未經遮罩的私人地址、個資或使用者上傳的敏感內容。

### 7.4 Setup Manifest v1

此 manifest 是 planning/compile 後、n8n setup 前的交接契約。範例：

```json
{
  "schemaVersion": "1.0",
  "kind": "runtime_setup_manifest",
  "planFingerprint": "sha256...",
  "skillIds": ["delivery.smtp_email_draft"],
  "workflowDisposition": "create_inactive_draft",
  "items": [
    {
      "kind": "credential",
      "key": "SMTP credential",
      "status": "setup_required",
      "bindStrategy": "create_or_select_in_n8n",
      "modelVisibility": "never",
      "sensitive": true
    },
    {
      "kind": "configuration",
      "key": "recipient email",
      "status": "setup_required",
      "modelVisibility": "placeholder_only",
      "sensitive": true
    }
  ]
}
```

此契約目前已有可測函式與單元測試；尚未接上 production chat UI 與 n8n credential API。

## 8. 現在實作到哪裡

| 層次 | 狀態 | 位置或證據 |
| --- | --- | --- |
| Fine-tuned Create 路線 | 已有舊系統/比較基線 | `ollama-widget` 部署測試分支 |
| Compiler Beta 固定 patterns | 已部署測試 | `ollama-widget` 的 deployed revision |
| Nodewise compiler | 已驗證多個受限 pattern | A2A autoresearch evidence |
| Skill registry | 已有程式與測試 | `chatbot/src/runtimeSkillRegistry.js` |
| Plan review fingerprint gate | 已有程式與測試 | `chatbot/src/planReviewGate.js` |
| Setup Manifest | 已有程式與測試 | `chatbot/src/setupManifest.js` |
| Planner model 選型 | 研究中 | Sol 表現較強；尚無正式 API integration |
| Declarative Pipeline IR | 規格已定義，尚未接線 | 必須取代 planner 直接輸出 nodewise step spec |
| 通用 planner session/chat UI | 尚未接線 | 必須建立 session persistence、Plan Diff 與 review controls |
| 真實 credential lookup/binding | 尚未接線 | 只完成 privacy/data contract |
| 高風險 workflow compilation | 尚未實作 | authenticated HTTP、Wait/IF/Retry、Drive、通知等 |
| 畫布回同步 | 尚未實作 | Phase 2 先做 readback/diff，不承諾完整 decompiler |
| 自動執行驗證與錯誤回饋 | 尚未通用實作 | 已有手動 n8n execution evidence |

## 9. 下一個實作順序

1. **Planner Session + IR v1**：將 review gate 接到聊天 endpoint/UI，保存 `planFingerprint`、revision、Plan Diff 與使用者決定；核准後只產生 IR。
2. **Draft handoff v1**：將 approved IR -> compiler -> static verifier -> Setup Manifest -> inactive draft 串成單一路徑。
3. **Credential binding + configuration adapter**：讀取 n8n credential metadata，讓使用者在 native UI 選擇；non-secret Form Cards 在 review 期收集，敏感值走隔離 setup。
4. **擴充高覆蓋 skill**：優先 authenticated HTTP、資料映射、IF/Wait/Retry，並為每個 skill 加上資料形狀、條件參數與可執行 fixture。
5. **Execution evidence + sanitized repair loop**：將執行錯誤脫敏、分類為 deterministic repair 或 semantic replan；任何會新增外部副作用的修復都須重新 plan review。
6. **Phase 2 canvas resync**：先從 n8n workflow readback 建立差異報告；只有在 IR 覆蓋足夠時才做受限 decompiler。

## 10. 對抗式審查清單

另一個 AI 或測試者可以用這些問題挑戰系統：

1. 使用者未核准 plan，系統是否仍可能生成 workflow JSON？答案必須是「不可以」。
2. 使用者要求新版 plan，但按了舊版的核准按鈕，是否能編譯？答案必須是「不可以」。
3. 使用者把 API key 打進聊天，系統能否保證它不進 planner history？正確回答是「v0.2 已規定 UI/gateway 雙層防線，但尚未實作，不應宣稱已保證」。
4. 找不到 Google Drive credential 時，系統是否拒絕建立全部 workflow？答案必須是「不應拒絕；應建立 inactive draft 與 setup checklist」，前提是該 Google Drive skill 已被實作。
5. 一個 n8n 節點存在，是否代表 compiler 支援它？答案必須是「不代表」。
6. 靜態驗證通過是否代表寄信成功？答案必須是「不代表；需 execution evidence」。
7. Planner 能否任意輸出 JavaScript 或 node type？答案必須是「不可以；只可輸出 typed specification，compiler 擁有 JSON」。
8. 系統遇到不支援的影片生成 + 輪詢 + Drive 上傳需求時，是否應產生假 workflow？答案必須是「不可以；要列 capability gaps，或只在使用者明確同意下建立可辨識的未完成 draft」。
9. 上游輸出 20 個 items、下游只接受一個 object 時，compiler 可否自行猜測？答案必須是「不可以；IR 必須聲明 aggregate/select/split 策略」。
10. 使用者手動修改 n8n 畫布後，聊天 session 可否繼續假裝它仍掌握 workflow？答案必須是「不可以；在 readback/diff 實作前，必須標示 session state 已過期」。

## 11. 使用者角色測試腳本

### 案例 A：已支援、無 credential

「從公開 JSONPlaceholder 取 user 2 和 todos，輸出姓名、email、待辦總數與未完成數。」

預期：plan review -> 核准 -> 建立 workflow -> 手動執行 -> 四個欄位符合 output contract。

### 案例 B：已支援結構、缺 SMTP credential

「每天讀取 RSS，整理十篇新文章並寄給我的團隊。」

預期：plan 明示 SMTP/寄收件設定 -> 核准 -> 建 inactive email draft -> Setup Manifest 指向 n8n credential UI；不可要求使用者在聊天貼 SMTP password。

### 案例 C：高複雜且尚未支援

「提交影片生成任務後，每 30 秒輪詢；完成就上傳 Drive，失敗通知我。」

預期：系統列出 POST、authenticated request、Wait、動態 task ID、分支、binary download、Drive upload、notification 等 capability gaps；不可假裝已產生可跑流程。

## 12. 成功標準

本架構達成第一階段成功，至少要同時滿足：

1. 使用者可在 UI 完成「plan -> 修正 -> 核准 -> draft -> setup -> execution evidence」的一條完整受限路徑。
2. 全路徑不將 credential value 傳給 model。
3. 每個支援 skill 有 runtime schema、靜態檢查與至少一個真實 n8n execution fixture。
4. 每個不支援需求回傳的是明確 capability gap，不是看似完整卻無法執行的 JSON。
5. 研究記錄可區分：planner 問題、compiler 問題、setup 缺失、runtime 不相容與 execution failure。

## 13. v0.2 審查回饋處置紀錄

| 審查議題 | 處置 | 理由 |
| --- | --- | --- |
| 巨集/原子 skill 混雜 | 接受，納入 IR 與 recipe/skill 分層 | 沒有 IR 時，擴充會退化成 template selector 或不可控 DAG 猜測 |
| Item Array / Paired Items | 接受，資料形狀列為 skill 與 verifier 必填契約 | 這是 n8n 實際執行錯誤的重要來源 |
| Safe expression AST | 接受為 Phase 2 | 必要但不可草率把任意 JS 重新放回系統 |
| Canvas round-tripping | 接受為 Phase 2，先做 readback/diff | 完整 decompiler 風險與範圍太大；先停止狀態漂移更務實 |
| `displayOptions` 條件參數 | 接受 | verifier 必須讀 runtime schema 的條件依賴；未完全對齊 n8n UI 前，不得宣稱等價 |
| Degraded Draft Mode | 有條件接受 | 僅能建立 inactive、清楚標示 placeholder 的草稿，且使用者明確選擇；高風險寫入不可自動補假節點 |
| Diff-based review | 接受 | 保留新版 fingerprint 與明確同意，只縮短使用者閱讀範圍 |
| Chat Form Cards | 接受 | 只處理非敏感 configuration；敏感值仍不進 planner |
| Pre-LLM DLP | 接受為高優先實作項目 | 規格上的 secret 禁令沒有輸入端防線就不完整 |
| 自動錯誤修復 | 有條件接受 | 先脫敏、分類；只對 compiler 已知的 deterministic repair 自動提出修復，語意與外部寫入仍需重新核准 |
