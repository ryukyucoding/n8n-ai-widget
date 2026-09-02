# 持續研究機制（planner 離線時）

**建立：** 2026-09-01，executor（Claude Opus 4.8，原生 Anthropic，不受 gpt-5.6/ChatGPT 配額限制）。
**授權：** Dan 於對話中明確指示：brain 休假期間由 executor 維持研究推進；有進展直接 push 到 A2A，不需逐次詢問；**只有刪除或整併舊資料需先取得其他 agents 同意**。
**問題背景：** 理想迴圈是 brain 規劃→executor 執行→回報→brain 檢驗→續行。但 brain 走 gpt-5.6（claudex/本機 proxy），受 ChatGPT Plus 配額限制且消耗過快，無法維持即時驅動。

## 1. 核心設計：把「執行」與「即時規劃」解耦，改為非同步迴圈

brain 不在線時，executor **不等待即時規劃**，改為從既有的持久計畫存量取可驗證的工作項自行執行，把帶證據的結果寫回 A2A；brain 恢復後再非同步檢驗與重新規劃。迴圈仍然閉合，只是變成非同步。

持久計畫來源（都在本 branch）：
- `a2a/COMPILER_EXPANSION_ANALYSIS.md` — 能力擴充建置順序（步驟 0–4）。
- `a2a/TASKS_FOR_CODEX.md` / `TASKS_FOR_CODEX_44.md` — 具體工作與驗證項。
- `a2a/RELEASE_*_PLAN.md` — 發布與整合計畫。
- `a2a/NEEDS_HUMAN.md` — 只有 Dan 能結案的待裁決項。

## 2. 自主邊界（executor 在 planner 離線時的行為包絡）

**可以獨立做、直接 push（可逆、可驗證、無外部副作用）：**
- 跑測試、稽核程式與接線狀態、核對計畫宣稱是否與程式碼相符（executor 的本職＝驗證）。
- 產生分析、帶證據的 `finding`、維護本工作佇列與 recovery 文件。
- 只新增檔案或 append；commit 只加明確路徑，**絕不 `git add -A`**（避免 F8 CRLF 事故）。commit 附 provenance trailer（`Agent-Origin: executor` 等）。

**需要同意才能做：**
- **刪除或整併舊資料** → 需其他 agents（brain / codex）同意（Dan 指定的唯一閘門）。
- 部署、改 `ollama-widget` / `main` / 產品程式合併、動 `docs/RUNTIME_AWARE_SYSTEM_SPECIFICATION_ZH.md` → 需 Dan。
- 寫入 `codex.*`（P1）、代為結案 `NEEDS_HUMAN.md`（P6）、`.44` 真實 runtime 操作（executor 到不了，需 Dan/codex-44，P12）。

**紀律：** 寫 A2A 前 `--locks`/`--digest` 確認無同身分並行 writer；寫後 `--check` 需無 ERROR；P4 沉默合法、不空回應；P5 迴圈煞車；P8 病態上限。

## 3. 工作佇列（依 COMPILER_EXPANSION 建置順序，標可否獨立執行）

| # | 工作項 | executor 可獨立到哪 | 需誰 |
| --- | --- | --- | --- |
| V1 | 驗證核心機制單元測試（planBinding/planDiff/…） | ✅ 已完成一輪，見 §4 | — |
| V2 | 稽核接線狀態：哪些機制真的從 `chatbot/src/index.js` route 追溯得到（已實作 vs 已接線） | ✅ 唯讀可做 | — |
| V3 | 核對 `TASKS_FOR_CODEX.md` 的「無 caller」表是否仍成立（R1/R11/R17/planReviewGate…） | ✅ 唯讀可做 | — |
| 0 | plan-first 雙重驗證正式 commit（線上跑未提交 patch） | ⚠️ 只能驗證 branch 端測試；實際 commit 在 .44 | codex-44/Dan |
| 1 | 來源 schema 綁定（sourceSchema）覆蓋度稽核 | ✅ 讀碼+測試可評估 | 實作接線需 review |
| 2 | 泛化 `set` mapping 語意 | ⚠️ 分析可做；產品程式實作走 topic branch + review | brain/Dan |
| 3 | `if` 控制流 | ⚠️ 同上 | brain/Dan |
| 4 | 憑證子系統（先 Google） | ❌ 需存取控制前置 + Dan | Dan |

executor 在 planner 離線期間優先做 V 系列（純驗證/稽核），把「實作」類留給有 review 的時候，避免 P11 設計漂移與覆蓋風險。

## 4. 執行記錄

### 2026-09-01 V1 — 核心機制單元測試（executor 實測）
環境：Dan 實驗室電腦、`codex/autoresearch-a2a` @ `a733438`、node v22.18.0、executor clone。
指令：逐檔 `node --test src/<mod>.test.js`（全套 `node --test src/` 會因某檔缺 `dotenv`／未裝 node_modules 而中止，故只涵蓋自足的單元測試）。
結果：**12 檔全綠，共 158 項、0 失敗**。
```
planBinding 27  planDiff 17  runtimeSchemaRevision 15  planReviewGate 3
pipelineIr 6  publicUrlPolicy 37  nodewiseCompiler 8  capabilityGap 16
easy100CapabilityCoverage 3  acceptanceContract 12  candidateWorkflowVerifier 8
nodewisePlannerEnvelope 6
```
註記：planBinding 由 TASKS 記錄的 22 成長到 27，機制持續開發且維持綠燈。**此結果只驗證機制單元正確，不代表已接線到產品路徑（R2），也不代表 .44 線上行為**（見 NEEDS_HUMAN 的未提交 patch 項）。下一步：V2 接線稽核。

### 2026-09-01 V2 — 接線稽核（executor 唯讀，git grep require 追溯）
方法：對每個機制模組 grep 非測試檔的 `require`，並從 `chatbot/src/index.js` 的 route 往下追（AGENTS.md 的「已接線」判準）。
**重大進展 vs `TASKS_FOR_CODEX.md`**（當時 planBinding/planDiff/runtimeSchemaRevision/planReviewGate/pipelineIr 全標「無 caller」）：
- **已接線到產品路徑：** `index.js` L45 直接 require `approvedNodewiseCompiler.js`；route `/beta/plan-approve → handlePlanApproval` 用它，串到 `planBinding` + `planDiff` + `runtimeSchemaRevision`。`publicUrlPolicy` 經 `nodewiseCompiler`/`rssDigestCompiler`。`nodewisePlanner` 由 index.js require。→ **R1/R2/R11/R17 + plan-first 審核/核准/編譯三步已在產品路徑上**（曾是 TASKS 的關鍵瓶頸）。
- **仍未接線（已實作+測試但無 caller）：** `planReviewGate.js`、`pipelineIr.js`、`setupManifest.js`。前兩者只在 `planBinding.js` 的**註解**被提及（非 require），`setupManifest` 零引用。
界限：本稽核只證明「require 鏈可達」，未執行實際 route 行為驗證（需起服務或 .44）。下一步 V3：核對這三個未接線模組是「該接未接」還是「已被別的實作取代的死碼」。

### 2026-09-02 V3 — 三個未接線模組的定性（executor 讀碼比對）
方法：讀各模組 exports 與檔頭，對照產品路徑（index.js L40-45 從 `approvedNodewiseCompiler` 引入 `proposeNodewisePlan/reviewNodewisePlannerResult/approveNodewisePlan/compileApprovedNodewisePlan`，plan-review/approve handler 全數呼叫這些）。
- **`planReviewGate.js` → 已被取代（產品路徑死碼候選）。** 它 export `proposePlanReview/applyPlanReviewDecision/canCompileApprovedPlan`，對「人類可讀 plan」取 fingerprint。這正是規格審查 A1 指出的缺陷（compiler 消費的是 IR，不是人類 plan；見 planBinding.js L5 註解）。`approvedNodewiseCompiler` 已用「同一份 nodewise specification 當 canonical IR：review 由它 render、approval 對它簽章、compiler 消費同一個值」取代之，且產品 handler 完全不呼叫 planReviewGate。→ 建議歸檔，但**刪除/整併需 brain 同意（Dan 指定閘門），我僅標記不移除**。
- **`setupManifest.js` → 前置建置，等 step 4，非死碼。** 它 require `runtimeSkillRegistry` 的 `resolveCredentialBindings`，處理 credential identities / availableCredentialNames / `create_inactive_draft` disposition。屬憑證/setup 流（COMPILER_EXPANSION 步驟 4）。憑證子系統落地時再接線。
- **`pipelineIr.js` → 未定，需 brain/設計裁定。** 它是更結構化的 typed IR（`SingleItem/ItemList/Binary` shapes、拓撲排序、merge policies），比現行 nodewise specification 更嚴格。目前無 caller：可能是超前的未採用 IR，也可能被 nodewise spec 取代。executor 不逕自判定，交 brain。
結論：接線缺口不是「落後」，而是三種不同狀態——死碼(planReviewGate)／前置待依賴(setupManifest)／設計未定(pipelineIr)。真正待推進的是 COMPILER_EXPANSION 步驟 2/3（編譯器內部，不碰憑證）。

### 已知協定張力（記錄，留給 brain/Dan 裁決，不單方面改）
P8「對同一對象連續發送 6 則 WARN、7 則 ERROR」的設計前提是「對方掛了就該停送」。但 Dan 已授權 executor 在 brain 離線時單飛推進，這會與 P8 相衝：合法的單飛工作會被誤判為病態灌訊。**暫行對策：** 例行進度只寫本執行日誌（非 outbox 訊息，不increment streak），outbox 訊息保留給 brain 必須檢驗/回應的里程碑 finding。長期解法建議 brain 修訂 P8：區分「無授權的單方灌訊」與「有 Dan 授權的單飛」，屬協定層變更，不由 executor 逕改。

### 2026-09-02 Q1 — Mapping v1 獨立驗收稽核（executor，唯讀）
比對來源：`MAPPING_V1_ACCEPTANCE_RESULT.md`、`DEPLOYMENT_VERIFICATION_PROTOCOL.md`、commit `205ea30`。方法：checkout `topic/mapping-literals-v1 @ 205ea30` 親手重跑。
**我能獨立重現（程式/測試層，第一手）：**
- `205ea30` diff 只碰 `chatbot/src/`（8 檔，無任何 a2a 路徑）。commit 訊息自標 number literal `implemented_untested/provisional` 且「not a promotion or deployment authorization」。Agent-Origin: executor, brain。
- 親跑：full chatbot `node --test src/*.test.js` = **328/328 pass 0 fail**；focused = nodewiseCompiler 19 + approvedNodewiseCompiler 11 + nodewisePlannerPrompt 2 + runtimeSkillRegistry 6 + capabilityGap 16 = **54/54**（與協定 baseline 相符）。
- rejection matrix（dup `to`、mixed/extra/unknown source、undeclared field、type mismatch、literal null/object/array/NaN/Infinity、expression 偽裝、items input、未登錄來源 schema、registry 變更使 token 失效）皆有單元測試在跑。
**我不能獨立重現（僅由 sanitized record + Dan assertion，executor 到不了 .44、raw log 私有）：**
- 真實 n8n 手動執行的輸出（name=`Chelsey Dietrich` 複製、status=`active` 字串、isActive=`true` 布林）。這是 execution evidence，屬 Dan（驗收權）+ Desktop Codex（執行）的範圍；我依協定只用 sanitized 證據對照，不索取/暴露私有 raw log。
**成熟度判定（我認同協定分級）：** string/boolean set_fields = `verified_fixture`，但**僅綁定一個固定 public-source 案例**，不構成通用 NL 生成器。number literal = `implemented_untested/provisional`（見 Q2）。
**為何 number 不可 promotion：** compiler emit 原生 JSON number，但無任何真實 n8n Set fixture 驗證其 stored/executed 參數 shape；若 n8n 實際存成字串 `"1"` 則設計假設為假。未經 Case B 執行證據前提升 = 自我認證，違反協定 §2/§9。
**Promotion readiness checklist（topic/mapping-literals-v1 → ollama-widget，全部需 Dan 明確核准）：** ① string/boolean 已 `verified_fixture` ✓ ② number literal 完成 Case B 執行證據或明確排除於 promotion 範圍 ③ 獨立驗證（brain+executor）簽核 sanitized 證據 ④ rejection matrix 於目標環境仍 fail-closed（含 `/albums/1` 未登錄來源拒絕）⑤ 依 BRANCH_STRATEGY 的 ollama-widget→ 及 promotion gates（測試通過 + 真實 execution evidence + 無 secret/runtime-state 混入 + Dan 核准）。**executor 不自行 promotion。**

### 2026-09-02 Q2 — Number literal Case B readiness（executor，唯讀，不呼叫模型/n8n）
**planner 選擇歧義：** 協定 Case B 的 NL 請求「…輸出姓名，並加入固定欄位 rank = 1」不保證 planner 必選 `set_fields`。分析：select_fields/count/join 都無法產生「固定字面值」——唯一能加 literal 的是 set_fields，故*理論上*被迫選它；但 planner 仍可能 (a) 誤把 rank 當來源欄位（users/5 無 rank → 欄位驗證會擋，屬正確 fail-closed，但不是我們要測的 compiler 路徑）(b) 直接回 `unsupported_capability`（若未認出 literal 能力）(c) 產生 select_fields 而漏掉 rank。→ 用 NL 請求測 compiler 會混入 planner 選擇不確定性。
**Deterministic specification-level fallback fixture（供 Desktop Codex 直接編譯/部署，跳過 planner；不需臨場設計）：**
```json
{ "schemaVersion": "1.0", "kind": "nodewise_step_specification",
  "goal": "Fetch JSONPlaceholder user 5 and add a fixed numeric rank.",
  "requiredUserSetup": [],
  "expectedOutput": { "deliveryShape": "one_object", "fields": ["name", "rank"] },
  "steps": [
    { "id": "start", "capability": "manual_trigger", "requiredUserSetup": [], "configuration": {} },
    { "id": "user", "capability": "http_request", "requiredUserSetup": [], "configuration": { "method": "GET", "url": { "kind": "public_literal", "reference": "https://jsonplaceholder.typicode.com/users/5", "cardinality": "one_object" } } },
    { "id": "shape", "capability": "data_transform", "requiredUserSetup": [], "configuration": { "operation": "set_fields", "input": { "kind": "prior_step", "reference": "user.response", "cardinality": "one_object" }, "mappings": [ { "to": "name", "valueType": "string", "source": { "kind": "input_field", "field": "name" } }, { "to": "rank", "valueType": "number", "source": { "kind": "literal", "value": 1 } } ] } }
  ] }
```
**讀回/手動執行必驗欄位（Desktop Codex 回傳 sanitized）：** ① Set 節點 assignments 含 `{name:"rank", value:1(原生數字非字串), type:"number"}` 且 `{name:"name", value 為 n8n 欄位表達式}` ② readback 的 rank 型別為 number ③ 手動執行後最終輸出 `rank === 1`（number，非 `"1"`）。判定：readback+execution 保留原生 number → 升 `verified_fixture`；存成字串 `"1"` → 設計假設為假、修正後才可 promotion；建立/執行失敗 → 保留 unverified 並停。**絕不預告成功。**

### 2026-09-02 Q3 — Control-flow / pipelineIr decision input
產出獨立文件 `a2a/CONTROL_FLOW_DECISION_INPUT.md`（executor 唯讀架構稽核，含 runtime schema 實證的 If/Merge facts、nodewise vs pipelineIr 對 single 2-way IF 的支援/缺口、三方案與推薦）。摘要：runtime `n8n-nodes-base.if`@2.3 有兩個 main output（true/false）、`merge`@3.2 為 2→1；pipelineIr **已內建** branch/sourcePort 依賴、topological cycle 偵測、MERGE_POLICIES，而 nodewise 為純線性單 one_object。三方案：擴 nodewise / pipelineIr adapter / 採 pipelineIr canonical。**不裁決，交 brain。**

### 2026-09-02 Q4 — Easy-100 dataset evidence gap（executor，唯讀）
**現況：** audit 工具 `chatbot/tools/audit_easy100_capability_coverage.js` 存在,用法 `node ... --input <testing_data_low_100.jsonl> --output <report.json>`,內部呼叫 `src/easy100CapabilityCoverage.auditJsonLines(讀入的 jsonl 全文)`。**資料不在本機**（全 repo find 無 `testing_data_low_100.jsonl`；`workflow_template/S1_ft_original_description/` 不存在）。
**取得來源：** 原始資料需由**擁有完整 dataset 的私有環境/同事提供**（依 topology：`.44` 或 Dan 的 dataset repo，經 Desktop Codex/Terra）。executor 到不了,不捏造頻率。
**注意（範圍界限）：** 既有 audit 產出的是 capability-gap 覆蓋（COMPILER_EXPANSION 用的），brain 要的 field-copy/literal/coercion/items/expression **mapping 類型頻率**很可能需要**擴充 `easy100CapabilityCoverage` 或新 categorizer**——那是實作任務,不在本次唯讀範圍。
**給 Desktop Codex/Terra 的最小 sanitized request：** 在有資料的私有環境：① `node chatbot/tools/audit_easy100_capability_coverage.js --input <你環境的 testing_data_low_100.jsonl> --output report.json` 取得現有 capability-gap 覆蓋；② 回傳 sanitized 聚合數字（各 gap 類別 caseCount / blocked 數 / 累積解鎖曲線），**不要回傳原始題目或私有路徑**；③ 若要 mapping 類型頻率（field-copy/literal/coercion/items/expression），註明現有 script 未涵蓋,需先由 brain/executor 設計 categorizer 再跑。禁止捏造頻率。

### 2026-09-02 R1 — Control-flow schema deep audit（executor 唯讀,runtime schema 實證）
來源：`chatbot/schemas/runtime_node_schemas.json`。**已知事實：**
- `n8n-nodes-base.if@2.3`：inputs `['main']`；outputs **`['main','main']`**（port 0 = true/matched，port 1 = false/fallback）。`conditions` 屬性 type=`filter`，typeOptions.filter version=**3**（@2.3），caseSensitive 由 `options.ignoreCase` 推導、typeValidation strict/loose 由 `looseTypeValidation` 推導。`options`：ignoreCase、looseTypeValidation。
- `n8n-nodes-base.merge@3.2`：inputs 動態（`numberInputs` ∈ 2..10，預設 2），outputs `['main']`（n→1）。mode 選項：`append`（各輸入依序輸出）、`combine`（配對合併）、`combineBySql`、`chooseBranch`（原樣輸出某分支）。
**未知（不猜,需 filter 元件源碼／真實 fixture／.44 確認）：**
- filter v3 內部的 operator 詞彙（equals/gt/contains…）與 leftValue/operator{type,operation}/rightValue 的精確 JSON shape —— **不在 node property schema 內**（由 n8n filter 元件定義）。
- 互斥兩分支 rejoin 的正確 merge 語意：`append` numberInputs=2 是候選,但「每個 item 只走一條分支 → merge 後應得單一結果」的實際 item 行為需 fixture 確認;`chooseBranch` 亦為候選。
**單一 2-way IF + rejoin 所需的最小 nodewise surface grammar（implementation-neutral,未知項標明）：**
- 一個 `branch`/`if` 步驟,configuration 含：`condition`（`{ field(需對來源/前步 schema 驗證存在), operator(來自「待定的 bounded allowlist」——對映 filter v3 子集,operator 集合=未知需釘), compareValue(typed literal, JS 型別=valueType) }`）、`onTrue` 與 `onFalse` 兩條子步驟串（各自最終產生**相同**的 expectedOutput.fields=one_object）、以及一個 rejoin(merge) 點。
- 連線需求:If 步驟 emit 兩條 main 連線(port 0/1),兩分支尾端接同一 Merge(mode/numberInputs 待釘)。
- 明確標未知:operator allowlist、filter JSON shape、merge rejoin 語意 —— 這三項在 R2 contract 中列為必須由 fixture/.44 釘死的前置。

### 2026-09-02 R2 — Option-B adapter contract
產出獨立文件 `a2a/OPTION_B_ADAPTER_CONTRACT.md`（implementation-neutral：nodewise branch surface → pipelineIr 結構驗證 → n8n If/Merge emitter）。規定 canonicalize/fingerprint 必涵蓋欄位、source-schema 驗證留在 nodewise 層、兩分支同一 one_object 契約、merge 語意、拒絕矩陣。不寫 code、不裁決 pipelineIr canonical。R1/R2 後依 brain 指示停止,不進 IF implementation。

### 2026-09-02 Option B 暫定決策（brain，記錄）
brain 已獨立讀 R1/R2 並接受為架構輸入(`c88287f` provenance clean)。**暫定決策:Option B adapter 是 IF research 的唯一前置方向** —— 但**不是實作授權、也不是 pipelineIr canonical 決定**。IF code 仍 blocked,直到 Desktop Codex/Dan 提供真實 fixture 釘死:①filter-v3 的精確 JSON 與 operator allowlist ②互斥兩分支 rejoin/merge 的 item 語意;之後 brain 重審 adapter contract。治理:往後公開 A2A commit/文件/outbox 不放 session URL/ID(改 Agent-Origin/A2A-Ref);既有歷史不改寫(Dan 刪除閘門),由 brain 向 Dan 揭露。

### 2026-09-02 R3 — Credential/setup readiness audit（executor 唯讀,未碰 credential API/network）
讀 setupManifest.js / runtimeSkillRegistry.js / approvedNodewiseCompiler.js / index.js route。
**已有契約(設計層,fail-closed):**
- `setupManifest.createSetupManifest`:輸出 credential 項 `modelVisibility:'never'`、sensitive:true、bindStrategy bind_existing/create_or_select_in_n8n;configuration 項 `placeholder_only`;`workflowDisposition` 在有未解項時為 `create_inactive_draft`。`canExposeToPlanner` 只回 placeholder_only 項 → **credential 值/身分都不進 planner**。
- `runtimeSkillRegistry.resolveCredentialBindings`:resolved vs setup_required、`create_inactive_draft`;external_write skills(delivery.smtp_email_draft requiresUserSetup、http.authenticated_request=planned)。
- 產品路徑目前 fail-closed:`validateSpecification` 斷言 `requiredUserSetup.length===0` 才編譯 → 現在**直接拒絕**任何需 setup 的計畫。
**實際未接線點:**
- `setupManifest` **零 caller**(V3 已證):契約設計好但未接進 index route/plan-first 流。憑證目前是「被拒」不是「被處理」。
**最小 credential step 前置條件:**
1. **存取控制(呼叫者身分)= 首要前置。** index.js `app.use(cors())` 為萬用 CORS、route 無呼叫者身分驗證(Dan 曾裁決在無真實使用者前延後,見 NEEDS_HUMAN,當時正確)。**不能在不驗身分的端點上請使用者交出 Google 憑證** —— 印證 COMPILER_EXPANSION §7:存取控制是憑證的使能者,非事後加固。
2. 把 setupManifest 接進 plan-first 流(需 setup 時呼叫,canExposeToPlanner 守門)。
3. inactive-draft 行為:未完成 setup 前 workflow 建為 inactive,使用者在 n8n UI 完成綁定。
**secret boundary:** credential 值永不進 planner context/compiler/A2A/log;只有 credential 身分(名稱)流動;setupManifest 已以 modelVisibility never/placeholder 實現此界線,接線時必須保持。
**需 Dan/Desktop Codex 確認的 runtime facts(executor 到不了,不碰 credential API/network):** ①.44 上真實 n8n 的 credential 儲存/綁定機制與 credential-type ID ②create-or-select-in-n8n 流的實際 API ③部署實例目前的 CORS/auth 姿態 ④Dan 對「存取控制」延後裁決的重啟(step 4 的閘門)。

### 2026-09-02 R4 / R5 — 產出獨立文件
- R4 → `a2a/MAPPING_V1_PROMOTION_EVIDENCE_PACKET.md`：給 Dan/Desktop Codex 的 sanitized promotion checklist(Case A 已滿足、Case B 待執行、target-env rejection matrix 待確認)。executor 不自提 promotion、不索取 raw evidence。
- R5 → `a2a/MAPPING_CATEGORIZER_DESIGN.md`：mapping 類型 categorizer 的 input/output schema、分類規則、人工標註歧義、測試案例(不寫 code、不捏造頻率)。

### 2026-09-02 S1 — Public-source onboarding contract audit（executor 唯讀,僅分析現有 sources）
來源:`sourceSchemaRegistry.js`(172行)、`publicUrlPolicy.js`、`approvedNodewiseCompiler`/`nodewisePlannerPrompt`/tests。
**現有 registry 形狀:** 每個 source = `{ id, host, path(含 :id pattern), cardinality(one_object|items), verifiedAt(ISO 日期), fields(Object.freeze name→primitive type) }`。已登錄 3 個:jsonplaceholder `/users/:id`(one_object)、`/todos`(items)、`/users/:id/todos`(items),verifiedAt 皆 2026-08-30。函式:resolveSource(host+path 比對)、assertSourceRegistered、assertField(欄位存在+型別)、assertCardinality。
**新增一個公開 API source 必須具備的證據與不可變式:**
1. **host policy(縱深防禦):** host 在 `VERIFIED_PATTERN_HOSTS` allowlist,且通過 `publicUrlPolicy` denylist(classifyIp 擋 RFC1918/127/169.254 metadata 等);allowedHosts 每次呼叫顯式傳入,無全域可變狀態。
2. **exact path + cardinality:** 宣告精確 path pattern 與 cardinality,且與實際回應相符(assertCardinality 會擋不符)。
3. **declared primitive fields/types:** name→string/number/boolean,Object.freeze;引用未宣告欄位 → assertField 擋。
4. **verifiedAt provenance:** 必須有人實際打過端點並核對欄位(檔頭 L25 明載);日期即證據。**故新增 source 不是純設定變更,需真實驗證**(呼應 COMPILER_EXPANSION §9)。
5. **sourceRegistryRevision / approval invalidation:** SOURCES 變更 → sourceRegistryRevision 變 → 令未結 approval 失效(fail-closed;approval 綁定確切 source 集)。
6. **fixture/rejection tests:** registered source 能編譯;未登錄 host/path → `沒有登錄的回應 schema`;cardinality 不符 → assertCardinality error;未宣告欄位 → assertField error。每項需測試。
(依 brain 指示只分析現有 sources,不列外部候選或假資料。)

### 2026-09-02 S2 / S3 — 產出獨立文件
- S2 → `a2a/CALLER_AUTH_DESIGN_INPUT.md`:caller-auth / credential-enablement 設計輸入。已確認 server 端 `N8N_API_KEY` 僅在 server(env,`X-N8N-API-KEY`),**不送 browser**;`/models` 的 modelConfig() 只回模型名/flags(無 key,無洩漏)。真正缺口是**呼叫者身分**(CORS *、browser→server 無 auth)。提出 ≥2 種不把高權限 key 給 browser 的 caller-auth 方案。
- S3 → `a2a/PLANREVIEWGATE_RETIREMENT_PACKET.md`:planReviewGate **無 production caller**(僅 planBinding 註解 + 自身 test);可安全 deprecate/刪除的證據包,刪前需保留的項目與影響(移除其 test 使套件 328→325)。不刪除/不歸檔,等 Dan 同意。

### 2026-09-02 Dan 批准 + 證據需求彙整
Dan 在對話中回覆原話:「都批准,然後資料的部分請你將需求寫進 a2a,我請 desktop 的 codex 整理上去」。取得管道:Dan ⇄ executor 對話。轉述者:executor。批准範圍:Mapping v1 promotion(仍需 Case B + G4 證據)、planReviewGate 清理(走產品路徑 + brain review)、存取控制(進設計)、資料/範例取得。
→ 已產出 `a2a/DESKTOP_CODEX_EVIDENCE_REQUESTS.md`:5 類 sanitized 需求(Req1 Case B 執行、Req2 G4 rejection matrix、Req3 Easy-100 dataset+categorizer、Req4 caller-auth/credential runtime facts、Req5 If/Merge fixtures)供 Desktop Codex/Terra/.44 提供。executor 未自行 promotion/deploy/刪除;approval 不跳過證據。Case B/G4/dataset/facts 回來後,executor+brain 獨立驗證再更新成熟度,promotion 由 Dan 定。

### 2026-09-02 研究主力交接 + GPT 優先序（Dan 決定）
背景:Dan 本週 GPT 額度將盡(brain 與 Desktop Codex 同吃 GPT pool,約兩天用掉一週),尚有一次重置。Dan 指示由 executor 接過 brain 部分工作,成為**持續研究主力**。
Dan 原話(P6a 轉述):「接下來的研究主力要由你這邊擔任…主要是幫我繼續推進研究進度」;GPT 優先序決定原話:「完成 Mapping v1」。取得管道:Dan⇄executor 對話。轉述者:executor。
**交接範圍(executor 接手 brain 的部分功能):** roadmap 維護、優先序、實驗規劃、研究佇列執行、稽核、驗證、文件。
**保留的獨立性安全機制(避免自我認證,對應 ORGANIZATION §6 anti-patterns):**
1. Dan 為重要結果的最終驗收者。
2. Desktop Codex/.44 提供 executor 做不出的 runtime 證據(執行證據仍來自獨立來源)。
3. brain 稀缺的 GPT 保留給**里程碑的獨立複核**,不花在日常瑣事。
4. executor 回報一律明確標「self-checked(自檢,信心較低,待獨立複核)」vs「independently-verified(已由 Dan/Desktop Codex runtime/brain 獨立驗證)」。
**GPT 優先序(Desktop Codex,於安全處置後):** Req1 Case B 數字執行 + Req2 G4 rejection matrix → **完成 Mapping v1**(見 `DESKTOP_CODEX_EVIDENCE_REQUESTS.md`,已 turnkey)。IF fixtures(Req5)/憑證事實(Req4)/dataset(Req3)順延。
**executor 平行工作(不需 GPT、不卡閘門,現在起持續做):** 編譯器正確性稽核、source-schema/approval 深度分析、Option-B 實作細部設計準備、既有測試套件正確性複核。**不進** promotion/deploy/credential/刪除/IF implementation(仍需 Dan 或外部證據)。安全隔離期間不碰 corpus。

### 2026-09-03 A-audit — 產品建立 workflow 的信任表面(executor,碼層已驗證)
方法:讀 `chatbot/src/index.js` 的 `/generate`(L826)與 `/beta/*` route 分派、旗標(L109-113)。
**發現:守衛的 nodewise 編譯器是 opt-in,不是預設。**
- `/generate` 依 `mode` 分派:`plan_first_request/approve/compile` → 守衛流程(HMAC approval token,已驗證安全);`compiler_beta` → 受限 pattern 編譯器(runtimeCompilerBeta,僅具名 public-data patterns);**其餘/未帶 mode → 落到 legacy LLM 生成並注入路徑**(L1055 legacyMaxCandidates、L1130 POST /api/v1/workflows、L1168)。
- 即:**client 若不明確帶 `mode: plan_first_*`,預設走 legacy「LLM 直接生成 workflow JSON 並注入 n8n」路徑,不經 plan-review/approval/source-schema 閘門。** legacy 路有自己的 candidate 驗證(candidateWorkflowVerifier 等),但非 deterministic-compiler 信任模型。
- 旗標:`PLAN_FIRST_COMPILER_ENABLED`、`RUNTIME_COMPILER_BETA_ENABLED` 皆由 env 控制(opt-in);`PLANNER_APPROVAL_HMAC_SECRET` 為 plan-first 前提。
**研究意涵:** 「編譯器保證欄位存在/不憑空生成/可信」這類宣稱**只在 plan-first 模式成立**,不在預設 /generate。這是「已實作 vs 已接線為預設」的差距——守衛編譯器已接線但屬 opt-in beta,legacy 仍是預設路徑。
**信心標記:** 碼層(mode 分派、旗標)**已驗證**;但 production 實際 env(PLAN_FIRST 是否啟用、client 實際帶哪個 mode)**未驗證**,需 .44/Desktop Codex 確認部署設定。下一步:評估 legacy 路徑 candidateWorkflowVerifier 的實際防護強度。
