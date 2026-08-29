# RUNTIME_AWARE_SYSTEM_SPECIFICATION_ZH v0.3 對抗式審查

**審查者：** Claude (Opus 5)
**審查日期：** 2026-08-28
**審查對象：** `docs/RUNTIME_AWARE_SYSTEM_SPECIFICATION_ZH.md` v0.3
**審查方式：** 規格全文 + `chatbot/src/` 實際程式碼交叉比對 + `codex/autoresearch-a2a` commit 歷史（唯讀）
**此文件不修改任何既有檔案。**

---

## 0. 總評

這份規格在「誠實度設計」上明顯優於同類文件：狀態機把「JSON 產生成功」與「可執行」明確分開、`capability_gap` 被當成一等公民、credential value 的資料流禁令寫得具體、§10 自帶對抗式清單。這些是真正的優點，不要在後續改版中被稀釋。

但以「可據以實作、且能撐過口試提問」的標準來看，有 **3 個 P0 結構性缺陷**會讓規格的核心保證在型別層面無法成立，另有 UX 上 2 個會直接決定產品能不能用的缺口。以下依嚴重度排列。

**分級定義**

| 級別 | 意義 |
| --- | --- |
| P0 | 規格目前的寫法無法支撐它自己宣稱的保證；照現況實作會產生假的安全感 |
| P1 | 規格有明確缺口，會在真實使用或 demo 時暴露 |
| P2 | 品質與可維護性問題，不影響正確性 |

---

## 1. 系統合理性（P0）

### A1 [P0] Plan fingerprint 保護錯了對象：核准的是 plan，編譯的是 IR，兩者沒有綁定

**現況（已從程式碼驗證）**

- `planReviewGate.js` 的 `fingerprint()` 對「人類可讀 plan」取 SHA-256，內容是 `{goal, summary, steps: string[], expectedOutput: string[], setupRequirements: string[]}`。
- `pipelineIr.js` 的 IR schema **完全沒有 `planFingerprint` 欄位**，`validatePipelineIr()` 也不檢查任何 approval。
- 兩個模組互不 import。

**問題**

使用者核准的是「一段文字」，compiler 消費的是「一個 DAG」。中間沒有任何密碼學或型別上的綁定。因此：

> 核准 plan A、送出 IR B 是完全合法的操作。

這讓 §10 對抗清單第 1 題（未核准能否生成 JSON）與第 2 題（舊核准能否編譯新版）的標準答案「不可以」，目前**只是一個承諾，不是一個機制**。而這正是 LLM 系統最典型的失效模式：planner 產生一段好聽的 plan 摘要，同時產生一個做別的事的 IR，兩者都通過各自的驗證。

**建議的規格改寫（§3 + §6.0）**

1. **把因果關係倒過來：IR 是唯一事實，plan 是 IR 的 deterministic rendering。**
   規格目前寫「planner 產生 plan 與 IR」（平行）。應改為：planner 只產生 IR；使用者看到的 plan 由 `renderPlan(ir, skillRegistry)` 這個**純函式**產生。這樣「plan 與實際行為不一致」在結構上不可能發生，而不是靠 planner 自律。
2. fingerprint 的輸入改為 `sha256(canonicalize(IR) || runtimeSchemaRevision || skillRegistryRevision)`。
3. IR 必須攜帶 `planFingerprint` 與 `revision`，`validatePipelineIr()` 必填。
4. Compiler 的唯一入口簽章改為 `compile(ir, approvalToken)`；`approvalToken` 由 review gate 以 HMAC 簽發，內容含 `fingerprint + revision + sessionId + expiresAt`。

**這條同時解掉的另一個洞：** 目前 fingerprint 不含 `runtimeSchemaRevision`。使用者今天核准、三天後編譯，期間 n8n 升級了——這正是整篇規格的核心命題（runtime 漂移），卻沒被 approval 機制涵蓋。加進 fingerprint 後，schema 變更會自動使 approval 失效並要求重審。

---

### A2 [P0] 「Gate」是一個建議函式，不是強制點

**現況（已驗證）**

`canCompileApprovedPlan(review, approval)` 是一個回傳 boolean 的純函式，**在整個 `chatbot/src/` 中沒有任何 caller**（`index.js` 的 require 清單沒有它）。同樣地 `createSetupManifest`、`validatePipelineIr` 也都沒有 caller。

§8 誠實標示「尚未接線」，這點值得肯定。但問題不在「還沒接」，而在**規格沒有規定接法**。一個「呼叫端記得先問一下」的 gate，在四個月後的程式碼裡一定會有某條路徑忘記問。

**建議：在 §3 責任分界表下方新增「架構不變式（Invariants）」一節**，用可被測試斷言的語言寫，例如：

```
INV-1  compiler 模組不得匯出任何缺少 approvalToken 參數的 compile 函式。
INV-2  n8n workflow create API 的呼叫點必須唯一，且該呼叫點必須先取得 SetupManifest。
INV-3  planner 的 prompt 組裝函式不得接受未經 redaction 標記的字串型別。
```

INV-3 那種寫法（用型別把「未消毒字串」與「已消毒字串」分開，例如 `RawUserText` vs `RedactedText`）是把 §7 的資料流禁令從「文件規定」升級成「編譯期保證」的最低成本做法。強烈建議寫進規格，因為 §7 目前是全文最重要、卻最無強制力的一節。

---

### A3 [P0] `http.public_get` 沒有 allowlist，實作上是 SSRF；且風險分類把它標成 `read_only`

**現況（已驗證）**

`nodewiseCompiler.js` 對 URL 的唯一檢查是：

```js
const url = new URL(value.reference);
assert(url.protocol === 'https:', `${field}.reference must use HTTPS`);
```

**問題**

n8n runtime 跑在使用者的網路內部。這個 URL 由 LLM 產生的 spec 提供。因此以下全部合法通過：

- `https://169.254.169.254/latest/meta-data/` — 雲端 instance metadata（AWS/GCP 憑證竊取的標準路徑）
- `https://192.168.1.1/`、`https://10.0.0.5:8080/` — 內網服務
- `https://internal-jira.corp/rest/api/2/issue/...` — 企業內部系統
- `https://127.0.0.1:5678/api/v1/credentials` — **n8n 自己的 API**

規格 §6.1 把它描述為「固定公開 HTTPS GET」、風險欄位標 `read_only`。但「public」這個語意**沒有任何程式碼在強制**，而 `read_only` 這個標籤掩蓋了「資料會流到哪裡」這個真正的風險維度。

**建議的規格改寫（§6 skill 合約 + §6.1 表格）**

1. **風險模型從二元改為三軸。** 目前只有 `read_only / external_write` 不足以描述現實：

   | 軸 | 值域 | 說明 |
   | --- | --- | --- |
   | `sideEffect` | `none / external_write / destructive` | 是否改變外部狀態 |
   | `networkScope` | `public_internet / user_approved_host / internal` | 連線目標的信任邊界 |
   | `dataEgress` | `none / metadata_only / user_content` | 什麼資料離開使用者環境 |

   `http.public_get` 應為 `{sideEffect: none, networkScope: public_internet, dataEgress: none}`，且 `networkScope: public_internet` 必須由 allowlist 強制。

2. **明訂 URL 驗證規則**：解析 hostname → DNS 解析 → 拒絕 RFC1918 / loopback / link-local (169.254.0.0/16) / CGNAT (100.64.0.0/10) / IPv6 ULA 與 mapped 位址 → 拒絕非標準 port。

3. **明訂雙重檢查點**：compile 時解析的 IP 與執行時可能不同（DNS rebinding）。規格必須說明這一層由誰負責——若 n8n 端無法攔截，規格應誠實記為 residual risk，而不是留白。

4. §5.1 的 plan 摘要必須顯示「會連到哪些網域」（見 B8）。使用者看到 `169.254.169.254` 會知道不對勁，看到「步驟 2：讀取資料」不會。

---

## 2. 系統合理性（P1 / P2）

### A4 [P1] Credential 用人類字串比對，與 n8n 實際資料模型不符，真實環境必然失效

**現況（已驗證）**

```js
// runtimeSkillRegistry.js
credentialRequirements: ['SMTP credential']
// ...
const bindings = requirements.map((r) => ({
  requirement: r,
  status: available.has(r) ? 'resolved' : 'setup_required',
}));
```

比對的是字面字串 `'SMTP credential'`。但 n8n 的 credential 有兩層：**type**（`smtp`、`gmailOAuth2`）與 **使用者自取的 name**（「公司 Gmail」、「測試信箱」），而且**同一個 type 可以有多筆**。

沒有任何使用者會把 credential 命名為 `SMTP credential`。因此目前這條路徑在真實環境的結果是恆為 `setup_required`——而且是靜默失敗，看起來像功能正常運作。

**建議改寫 §5.3：**

1. 以 `credentialType`（n8n type slug）查詢，回傳 `{id, name, type}` 清單。
2. 0 筆 → `setup_required`；1 筆 → 可綁定，但**必須在 plan review 顯示綁到哪一筆**；≥2 筆 → **必須讓使用者選**，不可自動挑第一筆。
3. **關鍵：「綁定哪一筆 credential」本身就是使用者要核准的語意決策**（它決定信從哪個帳號寄出、檔案上傳到誰的雲端硬碟），所以它必須進入 plan fingerprint。目前規格把 credential 當成「setup 細節」放在 plan 之後，這個歸類是錯的。

---

### A5 [P1] 狀態機不完整，且 §4.1 與 §10 自相矛盾

§10 第 10 題要求「必須標示 session state 已過期」，但 §4.1 狀態表**沒有這個狀態**。其他缺漏：

| 缺少的狀態 | 為什麼需要 |
| --- | --- |
| `session_stale` / `workflow_drifted` | §10.10 明文要求，但表中不存在 |
| `plan_expired` | approval 之後 runtime schema 變更 → approval 應失效（見 A1） |
| `execution_running` | 長時間執行的中間態；沒有它就無法區分「還在跑」與「掛了」 |
| `compiler_error` vs `external_service_error` | §12.5 要求研究記錄能區分五類失敗，但狀態機只提供其中三類 |
| `cancelled_with_cleanup` | 使用者取消時，已建立的 inactive draft 要刪除還是保留？規格未定義 |

**§12 成功標準第 5 條要求「研究記錄可區分：planner 問題、compiler 問題、setup 缺失、runtime 不相容與 execution failure」——但 §4.1 狀態機無法產出這五類的區分。這是規格內部的自我矛盾，應優先修正。**

---

### A6 [P1] IR 的資料形狀檢查是「有名無實的名目型別」，且多上游時完全不檢查

**現況（已驗證）**

`pipelineIr.js`：

```js
const SHAPE_PATTERN = /^(SingleItem|ItemList|Binary)<[A-Za-z][A-Za-z0-9_]*>$|^NoOutput$/;
// ...
if (step.dependsOn.length === 1) {
  assert(upstream.outputShape === step.inputShape, ...);
}
```

**兩個問題：**

1. **`ItemList<Todo>` 裡的 `Todo` 沒有任何定義來源。** 它只是一個通過 regex 的字串，由 planner（LLM）自由填寫。所以型別檢查實際上只能擋住「打錯字」，擋不住語意錯誤——planner 只要上下游都寫 `ItemList<Foo>` 就必然通過。這是名目型別系統但缺少型別宣告，等於沒有型別。

2. **`dependsOn.length > 1` 時完全不檢查 shape**，只要求有 `mergePolicy`。但這正是最危險的情況：`combine_by_index` 套用在 `SingleItem<A>` + `ItemList<B>` 上，是 n8n 執行期最常見的爆點之一（也是規格 §13 自己承認的「Item Array / Paired Items 是實際執行錯誤的重要來源」）。

**建議：**

- IR 頂層新增 `types` 區塊，`ItemList<Todo>` 的 `Todo` 必須在其中宣告欄位；或退回結構化寫法 `{shape: "ItemList", fields: [...]}`。
- 補上 **merge 相容矩陣**並寫進規格（哪個 mergePolicy 接受哪些 shape 組合、輸出什麼 shape）。
- **step 的 `outputShape` 不應由 planner 填寫，而應由 skill registry 宣告後推導。** 見 A8。

---

### A7 [P1] §6.2「已驗證 evidence」的證據強度被高估，這在口試會被打

**現況（已驗證）**

`runtimeCompilerBeta.js` 的兩個「已驗證 pattern」是**完全 hardcode** 的：

```js
url: 'https://jsonplaceholder.typicode.com/users/1'   // userId 寫死
value: 'twitch'                                        // channel 寫死
```

沒有任何參數化。§6.2 把它們列為 evidence，§6.1 又把 `http.public_get` 標為「已實作」——並排閱讀會讓讀者（包含口試委員）推論出「這是一個通用的 HTTP GET 能力」。實際上 nodewise compiler 確實比 beta 更通用，但規格沒有把這兩者的成熟度分開。

**建議：§6.1 表格新增兩欄，並在 §6.2 標註每項 evidence 的參數化程度**

| Skill | 狀態 | 驗證樣本數 | 參數化程度 |
| --- | --- | --- | --- |
| `http.public_get` | 已實作 | 3 | 參數化（URL 由 spec 提供） |
| `workflow.daily_rss_digest` | prototype | 1 | 單一 fixture |

並定義成熟度詞彙：`verified_fixture`（單一固定輸入跑過）/ `verified_parameterized`（≥N 個不同輸入跑過）/ `implemented_untested`。

**這一條對論文的影響大於對產品的影響。** 你的核心論點是「compiler 比 fine-tuned model 可靠」，審查者第一個問題必然是「你的 compiler 測了幾個案例？」——規格現在的寫法讓這個問題變得難回答。

---

### A8 [P2] Skill 合約在規格中定義完整，在程式中幾乎不存在，導致 IR validator 與 registry 沒有交集

§6 要求每個 atomic skill 宣告 `inputShape`、`outputShape`、欄位 schema、side effect、runtime mapping、verification contract。

但 `runtimeSkillRegistry.js` 的每個 entry 只有：
`{id, label, maturity, compiler, requiresUserSetup, credentialRequirements, configurationRequirements, risk}`

**沒有任何 shape、沒有 verification contract。**

後果：`validatePipelineIr()` 檢查 shape 時，完全不知道 `source.http_get` *應該* 輸出什麼形狀，只能相信 planner 自己寫的。這讓 §10 第 5 題（「節點存在不代表 compiler 支援」）的保證在 IR 層被繞過——planner 可以寫 `kind: "source.google_drive_upload"`，validator 不會拒絕，因為它只檢查 kind 是否符合 `/^[a-z][a-z0-9_.-]+$/`。

**建議在 §6 明訂：**

1. `IR.steps[].kind` **必須**是 skill registry 中 `maturity !== 'planned'` 的 skill id，validator 必須查表拒絕。
2. `outputShape` 由 registry 宣告推導，planner 不得自由填寫（planner 只填參數）。
3. registry entry 補上 `inputShape` / `outputShape` / `verificationContract` 三個必填欄位。

---

### A9 [P2] 缺少「Runtime schema 從哪來、何時失效」的規範——這是全篇的立論基礎卻沒有專節

整份規格的立論是「模型看到的 schema 與 runtime 不一致」，`runtime_node_schemas.json` 也確實存在。但規格沒有任何一節說明：

- schema 從哪裡取得？即時查 n8n API 還是快照檔？
- 快照多久重抓一次？過期的判定標準是什麼？
- 使用者升級 n8n 之後，既有的 draft、evidence、approval 是否失效？（接 A1）
- 多個 n8n 實例（開發/正式）schema 不同時怎麼辦？

**建議新增 §6.3「Runtime schema 取得與失效」。** 這是這份研究相對於 fine-tuned baseline 的唯一結構性優勢，規格反而沒有規範它，是明顯的缺口。

---

### A10 [P2] Auto-repair 的邊界只有形容詞，沒有白名單

`auto_repair_requested` 狀態存在，§9.5 說「分類為 deterministic repair 或 semantic replan」，但**沒有定義什麼算 deterministic**。

沒有白名單的話，實作時必然漂移成「LLM 看到 error message 就改 JSON 再試一次」——也就是這整份規格開頭 §1 要淘汰的做法。

**建議明訂封閉白名單**，例如：typeVersion 降版至 runtime 支援的最高版本、必填參數補 schema 預設值、node name 衝突自動改名、position 重疊調整。**白名單以外一律 replan，不得例外。**

---

## 3. 使用者體驗

### B1 [P0] 沒有定義「使用者答不出澄清問題」的路徑——這是本產品最可能的流失點

`clarification_required` 隱含假設使用者答得出來。但真實使用者：

- 不知道自己需要 SMTP 還是 Gmail OAuth2
- 不知道 RSS URL 在哪
- 不知道「每 30 秒輪詢」跟「每 5 分鐘排程」的差別

而這正是他們來用自然語言介面的原因。**如果澄清問題需要 n8n 知識才能回答，這個產品就退化成一個更慢的節點編輯器。**

**建議在 §5 新增 5.2.1「澄清問題的設計規則」：**

1. 每個問題必須附 **建議預設值** + 一句白話說明「這會影響什麼」。
2. 必須提供「用預設值繼續」的選項——預設值會出現在 plan 上，使用者可在 review 階段改。
3. **一次最多 3 題。** 超過 3 個未知數，代表 planner 應該直接提出一份帶明確假設的 plan 讓使用者修改，而不是連環拷問。（把不確定性推到 plan review 比推到 chat 問答便宜得多，因為 plan 是可視的、可比較的。）
4. 只問「答案會改變拓樸」的問題——這條 §5.2 已經有了，但沒有跟問題數量上限連在一起。

---

### B2 [P0] `capability_gap` 目前是死路，是 UX 上最傷的狀態

現況：§5 對 capability gap 只提供「說明缺少哪個 skill」+「儲存需求 / 換模式 / 降級草稿」。

從使用者視角，這是：「系統告訴你它不行，然後結束對話。」

以規格自己的案例 C（影片生成 + 每 30 秒輪詢 + Drive 上傳 + 失敗通知）為例，系統會列出 7~8 個 capability gap。**沒有任何使用者會讀完那個清單。** 他們會關掉視窗，並且不會再回來。

**建議：§4.1 與 §5 明訂 `capability_gap` 的回覆必須包含三段**

1. **最接近的可行替代方案（必填）**
   「我還不能做『每 30 秒輪詢』，但可以做成『每 5 分鐘檢查一次狀態』的排程版本。要用這個方式嗎？」
   ——實務上這能救回大部分需求。缺 `Wait` node 不代表使用者的目標達不到，只代表最直覺的做法達不到。

2. **部分交付（Partial delivery）**
   明確切分「這三步現在就能做」與「這兩步需要你手動接」。這與 §5.1.1 的降級草稿是同一個機制，但目前規格把降級草稿寫成「使用者要主動要求」的例外路徑，應該升格為 capability_gap 的**預設**選項之一。

3. **需求登記 + 上線通知**
   一鍵把需求存進 backlog，該 skill 上線時通知。這對產品是留存，**對你的研究是最有價值的真實需求分佈資料**——比任何合成 benchmark 都準。建議在 §12 成功標準加上這一項。

---

### B3 [P1] Plan Diff 的「快速核准」規則可被繞過，因為分類權在 planner 手上

§5.1 寫：「若只改不改變風險的常數或格式，仍需明確核准新版，但只需對差異快速核准。」

**問題：誰判定「不改變風險」？** 如果是 planner（LLM）自己標記，那麼幻覺或惡意 prompt 只要把變更標成 low-risk，就能讓使用者用「快速核准」通過一個高風險變更。而「常數」可以是：

- `recipient: team@company.com` → `recipient: attacker@evil.com`（只是一個字串常數）
- `limit: 10` → `limit: 100000`（只是一個數字）
- Drive folder ID 換一個（只是一個 ID）

**建議改寫 §5.1：**

> 風險分級**必須**是 verifier 對兩版 IR 做結構性比對的結果，不得由 planner 宣告。

並明訂**永遠是 high-risk、永遠需要完整重審**的變更類別：

- 任何 sink 的目的地（email 收件人、URL host、folder ID、channel）
- 任何 credential 綁定的變更
- 任何 `networkScope` 或 `sideEffect` 的提升
- 任何數量級變化超過 10 倍的 limit / 頻率
- 任何新增的 step

---

### B4 [P1] 沒有定義多筆 credential 的選擇 UX，而這是使用者唯一真正在意的事

接 A4。使用者有三個 Gmail credential 時，plan review 要顯示哪一個？

**§5.1 的 plan 範例缺的正是這一行。** 現在寫「需要設定：SMTP credential、寄件人、收件人」，但使用者真正想知道的是「這封信會從**哪個帳號**寄出去」。

**建議：plan 摘要中的 credential 必須顯示可辨識名稱**，例如「公司 Gmail (daniel@company.com)」而非「SMTP credential」。並在多筆時提供選擇器（在 review 階段，不是 setup 階段）。

---

### B5 [P1] 缺少等待期與進度感的規範——而這裡藏著本產品最好的行銷句

從送出需求到看到 plan，中間要跑：DLP → planner LLM → skill resolution → 可能的重試。這在本地模型上是數十秒等級。規格完全沒提 latency 預算或中間狀態。

**建議新增 §5.4「回應時間與進度揭露」：**

- 每個狀態轉換的目標回應時間上限。
- 超過 N 秒必須顯示**具體**正在做什麼，而不是 spinner。

而且——「**正在對照你目前安裝的 n8n 節點版本…**」這句話本身就是這個系統相對於 fine-tuned baseline 的差異化賣點。使用者看不到它，就不會知道自己為什麼要等，也不會知道這個產品好在哪。**把它顯示出來，等待時間就從成本變成價值證明。**

---

### B6 [P1] DLP 誤判的 UX 成本被低估；且 §8 實作狀態表遺漏 DLP 這一列

**現況（已驗證）**：`chatbot/src/` 中沒有任何 redaction / DLP 實作。§10.3 誠實承認「尚未實作」，但 **§8「現在實作到哪裡」表格完全沒有 DLP 這一列**——一個被列為「高優先實作項目」（§13）的功能，不應該在實作狀態表中消失。請補上。

**UX 面：**使用者第一次貼上帶 query token 的 RSS URL、或貼 webhook URL 被擋下來，如果訊息只說「偵測到疑似機密資訊」，他們會直接放棄。

**建議 §7.1 補充呈現規則：**

1. 阻擋訊息必須指出**是哪一段字串**被判定（遮罩後顯示，例如 `...token=sk-••••••••`），以及**正確做法是什麼**——最好是一鍵跳到 n8n credential 建立頁。
2. 低確定性覆寫要有摩擦但不能太重（一個確認按鈕即可，不要求打字重述）。
3. 明訂**允許清單**：常見的非機密高熵字串（UUID、n8n workflow ID、Base64 圖片前綴、git SHA）應直接放行，不進入警告流程。

---

### B7 [P2] 降級草稿的 Sticky Note 規格很好，但缺「回到聊天」的路徑

§5.1.1 對 Sticky Note 的四項內容要求（缺失能力 / 上游輸出形狀 / 下游輸入形狀 / 手動步驟）寫得具體且實用，是全篇 UX 設計最好的一段。

**但缺一個閉環**：使用者在 n8n 畫布補完手動步驟後，聊天 session 已經 stale（§10.10）。目前規格沒有定義他怎麼回來。

**建議：** Sticky Note 內含 session / plan 的 deep link，使用者補完後可回到聊天觸發 readback，讓系統重新對齊狀態。否則降級草稿是單向丟出去的，使用者再也不會回到這個產品。

---

### B8 [P2] §5.1 的 plan 範例缺三項使用者最在意的資訊

現有範例有：目標 / 步驟 / 需要設定 / 預期輸出。建議補上：

| 補充項 | 為什麼 |
| --- | --- |
| **會連到哪些外部網域** | 信任邊界；也是 A3 SSRF 的使用者側防線 |
| **執行頻率與預估次數** | 「每天一次」vs「每 30 秒 = 每天 2880 次」對成本與 rate limit 的意義完全不同 |
| **失敗時會怎樣** | 不通知？重試幾次？資料會不會重複寄送？ |

第三項尤其重要：使用者對自動化最大的恐懼不是「不會動」，而是「半夜自己動了 2880 次」。

---

## 4. 其他面向

### C1 [P0 for 論文] 規格沒有評估設計，但這是論文的主體

這份文件通篇是架構規格，完全沒有評估方法論。但你的研究命題是「runtime-aware compiler 優於 fine-tuned create model」。

**更關鍵的是：你現有的指標無法衡量這個系統的賣點。**

Node F1 / Connection F1 衡量的是「產出的 JSON 有多像參考答案」。但這個系統的核心價值是**誠實地拒絕**——一個永遠回 `capability_gap` 的系統，F1 是 0，但 false-ready rate 是 0，而後者才是使用者真正在意的。

**建議新增 §14「評估設計」，並定義以下指標：**

| 指標 | 定義 | 為什麼需要 |
| --- | --- | --- |
| **False Ready Rate** | 系統宣稱 `ready_to_run` 但實際執行失敗的比例 | **這是你最強的論點**，目前完全沒被定義出來 |
| Honest Gap Rate | 需求不受支援時，正確回 `capability_gap` 的比例 | 衡量誠實度的正面指標 |
| Over-refusal Rate | 需求其實受支援卻回 `capability_gap` 的比例 | 誠實度的代價，必須一起報告 |
| 狀態分佈 | 一組任務在 13 個終端狀態上的分佈 | 取代單一 F1，資訊量高得多 |
| End-to-end Success | 從 NL 到 `execution_passed` 的完整通過率 | 唯一與使用者體感一致的指標 |

**建議的實驗設計：** 同一組任務（Easy-100 已經是現成 benchmark）跑四個系統——FT-Original / FT-Analysis / FT-Human / Runtime-aware Compiler——比較上述指標。預期結果會是「compiler 的 F1 較低但 False Ready Rate 遠低」，**而這個 trade-off 本身就是論文的核心貢獻**。規格應該把這個假設明確寫出來，因為它決定了你要蒐集什麼資料。

---

### C2 [P1] 降級草稿的 placeholder 必須是「會主動失敗」的節點

§5.1.1 規定降級草稿保持 inactive、有 Sticky Note 標示。方向正確，但缺一條硬性規則：

> **placeholder 節點必須是會主動報錯的節點（例如 `Stop and Error`），不得是空的 NoOp 或空 Set。**

否則使用者手動啟用後，workflow 會「執行成功但什麼都沒做」。**這比明確報錯糟糕得多**，也直接違反 §2.1 產品承諾第 1 條的精神——一個跑完顯示綠燈但沒送出任何郵件的 workflow，正是「看起來合理但不可執行」的最壞形式。

---

### C3 [P1] 沒有併發與失敗恢復模型——這些在 demo 一定會出現

規格未定義：

- 同一使用者兩個分頁同時核准兩份 plan 會怎樣？
- Approval token 的有效期多長？
- Plan 核准後、n8n create API 失敗（服務掛掉、429、逾時），狀態是什麼？重試安全嗎（idempotency key）？
- 使用者中途關閉瀏覽器，session 如何恢復？

這些在單人測試不會出現，在口試 live demo 會。建議至少在 §4 補一段「失敗與恢復」，並為 workflow create 定義 idempotency key（用 planFingerprint 即可）。

---

### C4 [P2] 版本標示前後不一致

- 文件頭：`版本：0.3`、`最後更新：2026-08-25`（但檔案 mtime 是 08-28，內容已更新過）
- §7 內文：「v0.2 已規定 UI/gateway 雙層防線」
- §10.3 標準答案：仍寫「v0.2 已規定…」
- §13 標題：「v0.2 審查回饋處置紀錄」

**建議：** 統一版號；§13 改為累積式 changelog（分 v0.2 / v0.3 兩段），否則下一輪審查無法追蹤哪些回饋在哪一版被處置。

---

### C5 [P2] 規格與程式碼已經開始漂移——建議加自動化斷言

**已發現的實際漂移（唯讀驗證）：**

| 位置 | 規格 / registry | 實際程式碼 |
| --- | --- | --- |
| transform skill id | `transform.join_object_and_count`（§6.1 表 + registry） | `join_object_and_count_false_boolean`（`nodewiseCompiler.js` 的 `TRANSFORMS`） |
| DLP 實作狀態 | §13 列為「高優先實作項目」 | §8 狀態表**完全沒有這一列** |
| Plan review UI | §5.1「先規劃，再建立」 | `chat.html` 現行流程為「訊息 → 直接建立 workflow」，**沒有 plan review 階段**；失敗時於 `L552-553` 直接顯示 `JSON.stringify(data.workflow)` |

第三項的精確描述（我第一次寫得過重，已修正）：現行 UI 的成功路徑是給 n8n 連結而非 JSON，這點沒問題；問題在於**整個 plan review 階段不存在**，以及**錯誤路徑會把 raw workflow JSON 丟給使用者**。後者在規格中沒有被涵蓋——§5 只規範了成功路徑的呈現，沒有規範失敗時該顯示什麼。

**建議 §5 新增一條：** 錯誤呈現同樣受「不向一般使用者顯示 JSON」約束。使用者該看到的是 Semantic 層級的失敗說明（哪一步、為什麼、能怎麼辦），raw JSON 只出現在進階除錯畫面——這與 §5.1 對 Plan Diff 的處理原則一致，應該一併套用到錯誤呈現。

**建議：**

1. §6.1 的 skill 表格由 `runtimeSkillRegistry.js` 產生，並加一個測試斷言文件與 registry 一致。
2. §8 表格改為三欄：`設計已定 / 已實作且有測試 / 已接線到產品路徑`——這正好對應 Terra 提的三層區分，把它變成表格結構而不是文字描述。

---

### C6 [P2] 建議在 §1 之前加 5 行摘要

361 行、13 節，第一句是「這是一份架構規格，不是宣傳稿」。給口試委員或新合作者看時，建議加一個 5 行的 TL;DR：問題 / 做法 / **現在能做什麼（一句）** / **現在不能做什麼（一句）** / 這份文件怎麼讀。

第三、四行尤其重要——它們正是這份規格的精神，應該出現在第一屏而不是第 6 節。

---

## 5. 建議的修改優先順序

| 順序 | 項目 | 為什麼排這個位置 |
| --- | --- | --- |
| 1 | **A1** IR 攜帶 fingerprint + plan 改為 IR 的 rendering | 它讓 §10 前兩題的保證從承諾變成機制；也順帶解掉 schema 漂移使 approval 失效的問題 |
| 2 | **A3** URL allowlist + 三軸風險模型 | 唯一的實際安全漏洞；且風險模型會影響 skill 合約，越晚改越貴 |
| 3 | **A2** 架構不變式（INV-1~3） | 決定 A1/A3 能不能被強制，必須在接線前寫定 |
| 4 | **C1** 評估設計（§14） | 影響你現在該蒐集什麼資料；晚一天定義就少一天資料 |
| 5 | **B1 + B2** 澄清上限與 capability gap 三段式 | 決定產品能不能用；也是最容易改的（純規格文字） |
| 6 | **A4 + B4** credential 用 type 查詢並納入 plan | 真實環境必然失效，但可在接線時一起改 |
| 7 | **A5** 補齊狀態機 + 解決 §12.5 矛盾 | 純規格修改，但需要 A1/A3 定案後才知道要加哪些狀態 |
| 8 | 其餘 P1 / P2 | — |

---

## 6. 給 Codex Terra 的確認問題

以下幾點我從 repo 讀不出來，結論可能因答案而變。標 ⚠️ 者會影響上面的分級。

1. ⚠️ **`runtime_node_schemas.json` 是即時查詢 n8n API 產生的快照，還是手動維護的？** 更新頻率與觸發條件是什麼？（影響 A9 的嚴重度，也影響 A1 建議的 `runtimeSchemaRevision` 該怎麼取）

2. ⚠️ **`planReviewGate` / `setupManifest` / `pipelineIr` 三個模組目前刻意不接線，是因為在等 §9 第 1 項（Planner Session + IR v1），還是有其他阻塞？** 若已有接線設計，A1/A2 的建議應該併進那個設計而不是另開。

3. **`nodewiseCompiler` 的 `public_literal` URL 目前無 allowlist，是刻意留待後續，還是漏掉的？** 若是刻意（因為目前只在受控環境測試），建議至少在規格記為 known gap，我可以幫忙草擬 allowlist 規則。

4. **`transform.join_object_and_count`（registry）vs `join_object_and_count_false_boolean`（compiler TRANSFORMS）** 這組命名不一致是重構殘留還是刻意的兩層命名？

5. **`chat.html` 目前直接顯示 workflow JSON（line 553），與 §5.1「不給使用者看 JSON」衝突。** 這是舊 create 路徑的殘留、預計整個被 planner UI 取代嗎？還是要保留成進階模式？

6. **Easy-100 是否已有完整的 ground truth 與跑分腳本？** 若有，C1 的評估設計可以直接掛上去，不需另建 harness。

7. **論文的口試/投稿時程？** 這會決定 C1（評估設計）該排在 A2 前面還是後面——如果時程近，資料蒐集要先啟動，架構重構可以晚一點。

---

## 7. 附錄：本次審查的驗證方式

| 結論 | 驗證來源 |
| --- | --- |
| IR 無 `planFingerprint` 欄位 | `chatbot/src/pipelineIr.js` 全文 |
| 三個模組無 caller | `grep -rn "planFingerprint\|canCompileApprovedPlan\|validatePipelineIr" --include=*.js`（排除測試）僅命中定義處 |
| `index.js` 未 require 三者 | `grep -n "^const.*require('\./" index.js` 完整清單 |
| URL 僅檢查 protocol | `nodewiseCompiler.js` L33-35 |
| credential 用字面字串比對 | `runtimeSkillRegistry.js` `resolveCredentialBindings()` |
| Beta pattern 為 hardcode | `runtimeCompilerBeta.js` `todoSummaryWorkflow()` / `twitchStatusWorkflow()` |
| 無 DLP 實作 | `grep -ni "redact\|dlp\|entropy" index.js` 無相關命中 |
| chat.html 無 plan review 階段；錯誤路徑顯示 raw JSON | `chat.html` L547-577（成功路徑給 n8n 連結，錯誤路徑 L552-553 顯示 JSON） |
| skill id 命名漂移 | `runtimeSkillRegistry.js` vs `nodewiseCompiler.js` L7 `TRANSFORMS` |
| 分支狀態 | `codex/autoresearch-a2a` @ `303078c feat(autoresearch): validate declarative pipeline DAGs` |

**未驗證項目：** n8n runtime 實際行為、Easy-100 資料集內容、外部服務整合、論文時程。上述結論若與這些相關，已在第 6 節標為待確認。
