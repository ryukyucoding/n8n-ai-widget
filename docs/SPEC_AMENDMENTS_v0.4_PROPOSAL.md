# 規格 v0.4 修訂提案

**提案者：** Claude（`claude-7c`）｜2026-08-28
**覆核者：** Codex（`codex-20260828T1332xxZ`）
**狀態：提案，未修改 `RUNTIME_AWARE_SYSTEM_SPECIFICATION_ZH.md`。** 需 Dan 核准後才併入。

---

## 本文件的結構原則（Codex 覆核後重寫）

初版把「實際已接線」與「目標架構」混在同一張表裡。Codex 指出：

> 先把「實際已接線」與「目標架構」分開寫，才不會再次讓文件比系統本身更像真相。

**他是對的，而且這是結構性批評不只是事實更正。** 混寫正是這個專案要對付的失效模式——
一份讀起來完整、實際上超前現實的文件。Claude 在初版就犯了一次：把 `runtimeSchemaRevision`
標為未接線（實際已接線），把 `pipelineIr` 當成 canonical IR（實際是 `nodewise_step_specification`）。

因此本文件分為兩部分，**不得混寫**：

- **第一部分：現況** —— 只寫已驗證的事實，每條附驗證方式。
- **第二部分：目標架構** —— 提案，每條標明依賴與現況差距。

併入原規格時，第一部分進 §8，第二部分進各對應章節並標為「尚未實作」。

---

# 第一部分：現況（已驗證）

## 1.1 產品路徑上實際運作的是什麼

**canonical IR 是 `nodewise_step_specification`，不是泛用的 `pipelineIr`。**
`pipelineIr.js` 已實作且有測試，但**未接線**——它與 nodewise compiler 消費的是兩種格式。
Codex 刻意不硬接，理由是「假裝接上會做出一個不能用的整合」。**該判斷正確，應寫進規格。**

現行產品路徑：

```
approved nodewise specification
  -> HMAC approval verification（綁 canonical spec + runtime schema revision + skill registry digest）
  -> nodewise compiler
  -> 既有的已驗證 n8n create adapter
```

端點：`POST /beta/plan-review`、`/beta/plan-approve`、`/beta/compile-approved`。

## 1.2 接線狀態（2026-08-28 14:30 UTC 更新，Codex 完成接線後）

| 模組 | 測試 | 已接線 | 驗證方式 |
| --- | :-: | :-: | --- |
| `publicUrlPolicy`（R3） | 42 | **是** | `nodewiseCompiler`、`rssDigestCompiler` 皆 require 並呼叫 |
| `planBinding`（R1） | 22 | **是** | `approvedNodewiseCompiler:158` 呼叫 `assertApprovedForCompilation` |
| `approvedNodewiseCompiler`（R2） | 有 | **是** | 三個 `/beta/*` 端點 |
| `runtimeSchemaRevision`（R17） | 15 | **是** | `approvedNodewiseCompiler:11,33` → `runtimeContext()` |
| `planDiff`（R11） | 17 | **是** | `approvedNodewiseCompiler:20` → `diffNodewisePlans()` 於 `reviewNodewisePlannerResult` |
| `capabilityGap`（R5） | 12 | **是** | `approvedNodewiseCompiler:21,125` → `unsupported_capability` 分支 |
| `pipelineIr` | 有 | 否 | 與 nodewise spec 為兩種格式，**刻意未接** |
| `planReviewGate`、`setupManifest` | 有 | 否 | 無 caller |

**全套測試：35 個測試檔、274 項全數通過**（Claude 於 2026-08-28 逐檔複驗）。
`chatbot/` 已完成 scoped `npm install`，`node --test src/` 現可執行。

**已修正的兩個既有失敗：**
- `candidateWorkflowVerifier.test.js:144` —— Codex 診斷為測試 fixture 問題並修正。
- `chatProgress.test.js:68` —— CRLF 假失敗，已改為跨環境正確的比對。

## 1.2.1 Codex 修正的一個真實 bug（canonical IR 驗證後遺失欄位）

Codex 於接線過程發現：canonical IR 在驗證後會遺失欄位。
**若 approval 簽的是正規化後的縮減版、而 compiler 消費的是原版（或反之），
fingerprint 就無法涵蓋所有實際影響編譯輸出的欄位** —— 那會在 R1 的保證上開一個洞。

**現況已修正並經 Claude 獨立對抗驗證。** 現行設計：
`compileApprovedNodewisePlan` 簽章、驗證與編譯用的是**同一個原始 specification 物件**，
而 `canonicalizeIr()` 涵蓋整份內容（僅剔除綁定欄位）。

深層欄位竄改測試（Claude 執行，基準 fingerprint `5eafeb82060c`）：

| 竄改 | 結果 |
| --- | --- |
| 改 `configuration.mappings[0].valueType` | 擋下 |
| 改 `expectedOutput.fields` 順序 | 擋下 |
| 新增一個看似無害的欄位 `note` | 擋下 |
| 改 step id 大小寫 | 擋下 |

**注意：`nodewiseSpecificationForDiff()` 的投影只用於 diff 顯示，不參與 fingerprint。**
這個區分必須寫進規格——否則未來有人擴充該投影時，可能誤以為它是 canonical 形式。

## 1.3 已驗證的強制邊界

`/beta/compile-approved` 的對抗測試（Claude 以 `tests/nodewiseSpecs/sol-user2-todo-summary.json` 直接呼叫模組 API）：

| 情境 | 結果 |
| --- | --- |
| 無 approval token | 拒絕編譯：approval token 缺失 |
| 核准 A、送出 B | 拒絕編譯：這份核准不屬於當前的計畫或執行環境 |
| 以別的 secret 偽造簽章 | 拒絕編譯：簽章無效 |
| 正常路徑 | 通過 |

**這是規格 §10 第 1、2 題第一次在真實產品路徑上被強制。**

## 1.4 已知的具名例外

`compileRuntimeBeta`（`index.js:277-286`）可在無 approval 下編譯。
**這是刻意保留的例外，不是漏洞**——經 Codex 確認措辭：

> 僅能接受兩個固定、已驗證的 pattern，且**絕不接受 Planner 輸入**；非該 pattern 一律 422 拒絕。

**必須明寫進規格。** Claude 覆核時一度誤判它為 INV-1 違反，下一個讀者也會。

## 1.5 已驗證的環境事實

| 事實 | 驗證方式 |
| --- | --- |
| runtime schema 快照 `generatedAt` 2026-07-22、**無 `n8nVersion` 欄位** | 直接讀檔；`schemaRevision()` 回傳前綴 `unknown+` |
| 快照來源正確（來自 `n8n-n8n-1` 2.18.7，即 chatbot 實際連線者） | `getent hosts n8n` → `172.19.0.3`；`n8n` 為 compose 網路別名 |
| 全套 `node --test src/` **從未成功執行** | `node_modules` 在 Windows 端與 .44 皆不存在 |
| 逐檔跑：257 passed / 2 failed | Claude 於連線資料夾逐檔執行 |
| `chatProgress.test.js:68` 為 CRLF 環境假象 | .44 Linux checkout 4/4 通過；證據 `a2a/tasks44/c7_direct_run.md` |
| `candidateWorkflowVerifier.test.js:144` 失敗原因未知 | 尚未診斷（Codex 已 lock，進行中） |

---

# 第二部分：目標架構（提案）

**以下皆為提案。標「已部分實現」者，其現況見第一部分。**

## A. §3 責任分界 — IR 是唯一事實

**現況問題：** 規格寫「Planner 產生人可讀 plan 與 Declarative Pipeline IR」，兩者是**平行**產物。
這讓 planner 有可能產出「說得好聽的 plan」配「做別的事的 IR」，而兩者各自通過驗證。

**提案改為：**

> Planner 只產生 IR。使用者看到的 plan 是 `renderPlan(ir, skillRegistry)` 這個**純函式**的輸出。
> 同一份 IR 必然得到同一份 plan；plan 與實際行為不一致在結構上不可能發生。

**依據：** `chatbot/src/planBinding.js` 的 `renderPlan()`，22 個測試含「純函式」與
「改 IR 則 plan 與 fingerprint 同步改變」。

### A2. 新增「架構不變式」小節

規格目前只用敘述語言描述保證。**只被描述的規矩會被忘記**——`canCompileApprovedPlan()`
曾經存在卻沒有任何 caller，就是實例。建議新增可被測試斷言的不變式：

```
INV-1  compiler 不得提供任何缺少 approvalToken 即可編譯的入口。
       具名例外：legacy compileRuntimeBeta（僅接受兩個已驗證的固定 pattern，
       不接受任何 planner 產生的內容，非該 pattern 一律 422 拒絕）。
INV-2  n8n workflow create API 的呼叫點必須唯一，且必須先取得 SetupManifest。
INV-3  planner 的 prompt 組裝函式不得接受未經 redaction 標記的字串型別。
```

**INV-1 的具名例外必須寫進規格**——Claude 覆核時一度誤判該路徑為漏洞，
下一個讀者也會。例外要有名字與條件，不能靠讀程式碼推得。

**依據：** `approvedNodewiseCompiler.compileApprovedNodewisePlan()` 呼叫
`assertApprovedForCompilation()`；對抗測試四案例全數擋下（無 token／核准 A 送 B／
偽造簽章／過期）。INV-2、INV-3 目前**尚未實作**，列為提案。

---

## B. §4.1 狀態機補齊

**現況問題：規格內部自相矛盾。** §12 成功標準第 5 條要求「研究記錄可區分：planner 問題、
compiler 問題、setup 缺失、runtime 不相容與 execution failure」，但 §4.1 的狀態機
只提供其中三類，無法產出這五類的區分。§10 第 10 題要求標示 session 過期，
但狀態表裡沒有那個狀態。

**提案補上：**

| 新增狀態 | 進入條件 | 為什麼需要 |
| --- | --- | --- |
| `session_stale` | 使用者在 n8n 手動改過畫布 | §10 第 10 題明文要求，但表中不存在 |
| `plan_expired` | approval 後 runtime schema revision 改變 | 這是規格的核心命題，原本沒被 approval 機制涵蓋 |
| `execution_running` | 已觸發、尚未有結果 | 沒有它就無法區分「還在跑」與「掛了」 |
| `compiler_error` | 編譯期失敗 | §12.5 要求的五類區分之一 |
| `external_service_error` | 外部服務回應失敗 | 同上；與 compiler 問題必須分開 |
| `cancelled` | 使用者取消 | 需明訂已建立的 inactive draft 保留或刪除 |

**依據：** `runtimeSchemaRevision.approvalStillValid()` 已提供 `plan_expired` 的判定機制
（15 個測試）。其餘為提案。

---

## C. §5 使用者體驗規則

### C1. 澄清問題的設計規則（新增 §5.2.1）

**問題：** `clarification_required` 隱含假設使用者答得出來。但真實使用者不知道自己需要
SMTP 還是 OAuth、不知道 RSS URL 在哪——**而那正是他們來用自然語言介面的原因。
如果澄清問題需要 n8n 知識才能回答，這個產品就退化成一個更慢的節點編輯器。**

**提案：**
1. 每個問題必須附**建議預設值**與一句白話說明「這會影響什麼」。
2. 必須提供「用預設值繼續」；預設值會出現在 plan 上，使用者可在 review 階段改。
3. **一次最多 3 題。** 超過 3 個未知數，代表 planner 應直接提出一份帶明確假設的 plan
   讓使用者修改，而不是連環拷問。把不確定性推到 plan review 比推到 chat 問答便宜得多，
   因為 plan 是可視、可比較的。

**依據：無實作。純提案。**

### C2. `capability_gap` 的三段式回覆（改寫 §5）

**問題：** 目前只提供「說明缺少哪個 skill」+「儲存需求／換模式／降級草稿」。
以規格案例 C 為例會列出七八個 gap ——**沒有使用者會讀完那個清單。**

**核心洞察：缺某個 skill 不代表使用者的目標達不到，只代表最直覺的做法達不到。**
缺 Wait node 不等於「無法定期檢查狀態」，只等於「無法用輪詢實作它」。

**提案：`capability_gap` 的回覆必須包含三段：**
1. **最接近的可行替代方案（必填）**，且**必須寫明取捨**——只講好處會讓使用者
   在不知情下接受一個不同的東西。替代方案所需的 skill 若本身未實作，不得列出。
2. **部分交付**——哪幾步現在能做、哪幾步留給手動。
3. **需求登記**——該 skill 上線時通知。

**依據：** `chatbot/src/capabilityGap.js`，12 個測試含「每個替代方案必須有取捨」與
「不列出前置未實作的替代方案」的強制檢查。**尚未接線。**

### C3. Plan Diff 的風險分級（改寫 §5.1）

**問題：** 規格允許「不改變風險的常數變更」走快速核准，但**沒有規定誰判定**。
若由 planner 宣告，幻覺或惡意輸入只要標成 low-risk 就能繞過完整重審。
而「常數」可以是收件人 email、Drive folder ID、或 `limit: 10 → 100000`。

**提案明訂：**

> 風險分級**必須**是 verifier 對兩版 IR 做結構性比對的結果，**不得由 planner 宣告**。
> 系統不得讀取 IR 中任何 `riskLevel` / `severity` / `requiresReview` 類欄位。

永遠 HIGH：任何 sink 目的地、credential 綁定、URL host、`sideEffect` 或 `networkScope` 提升、
新增或移除步驟、拓樸或資料形狀變更、預期輸出變更、數量級變化超過 10 倍。

**即使 LOW 也仍需明確核准新版本**——差異式審核只降低閱讀摩擦，不降低一致性要求。

**依據：** `chatbot/src/planDiff.js`，17 個測試。關鍵測試：把收件人換成攻擊者信箱、
同時把 `riskLevel` 標為 `low`——結果仍判定 HIGH。**尚未接線。**

### C4. 錯誤呈現同受「不顯示 JSON」約束

**問題：** §5 只規範成功路徑的呈現，**沒有規範失敗時該顯示什麼**。
現行 `chat.html` 錯誤路徑會把 `JSON.stringify(data.workflow)` 顯示給使用者。

**提案：** 錯誤呈現同樣受「不向一般使用者顯示 JSON」約束。使用者該看到的是
Semantic 層級的失敗說明（哪一步、為什麼、能怎麼辦），raw JSON 只出現在進階除錯畫面。

### C5. Plan 摘要必須顯示的三項

§5.1 的 plan 範例缺少使用者最在意的資訊。**提案補上：**

| 補充項 | 為什麼 |
| --- | --- |
| **會連到哪些外部網域** | 信任邊界；也是 SSRF 的使用者側防線——使用者看到 `169.254.169.254` 會知道不對勁，看到「步驟 2：讀取資料」不會 |
| **執行頻率與預估次數** | 「每天一次」vs「每 30 秒 = 每天 2880 次」對成本與 rate limit 意義完全不同 |
| **失敗時會怎樣** | 使用者對自動化最大的恐懼不是「不會動」，而是「半夜自己動了 2880 次」 |

**依據：** `planBinding.renderPlan()` 已輸出 `externalDomains`、`sideEffects`、`schedule`；
`rssDigestCompiler` 已輸出 `feedHost`。**UI 尚未顯示這些欄位。**

---

## D. §6 Skill 與 compiler

### D1. 三軸風險模型（取代二元 `read_only` / `external_write`）

**問題：** 二元分類不足以描述現實。`http.public_get` 原本標為 `read_only`，
但「對外部公開 API read」與「對內網服務 read」的風險完全不同——後者是 SSRF。

**提案：**

| 軸 | 值域 |
| --- | --- |
| `sideEffect` | `none` / `external_write` / `destructive` |
| `networkScope` | `public_internet` / `user_approved_host` / `internal` |
| `dataEgress` | `none` / `metadata_only` / `user_content` |

`networkScope: public_internet` **必須由 allowlist/denylist 強制，不能只是標籤**。

**依據：** `chatbot/src/publicUrlPolicy.js` 已實作 denylist 與可選 allowlist（42 測試），
兩個 compiler 已接線。**但 registry 尚未改為三軸，仍是單一 `risk` 欄位。**

### D2. 新增 §6.3 Runtime schema 取得與失效

**問題：規格的立論是「模型看到的 schema 與 runtime 不一致」，卻沒有任何一節規範
schema 怎麼取得、何時失效。** 這是本研究相對 fine-tuned baseline 的唯一結構性優勢。

**實測（2026-08-28）：** 快照 `generatedAt` 為 2026-07-22（37 天）、**且沒有任何版本欄位**。
時間戳只能說明「多久沒抓」，不能說明「runtime 是否真的變了」；反過來一次無實質變更的
重抓也會產生新時間戳。**「來自哪個 runtime」無法從檔案本身判斷**——
這個歧義曾導致 Claude 誤判 schema 來源，並讓 Dan 匯出了一份錯誤的快照。

**提案：**
1. export 工具輸出 `n8nVersion`、`nodeTypesDigest`（正規化後 SHA-256）、`exportToolFormat`。
2. `runtimeSchemaRevision = <n8nVersion>+<digest 前 16 碼>`。
3. **approval 綁 revision 而非時間戳**——內容沒變的重抓不使 approval 失效。
4. freshness 判定為三值 `fresh` / `stale` / `unknown`；**缺欄位、無法解析、時間戳在未來
   一律回 `unknown` 而非 `fresh`**。「不知道」與「沒過期」在安全判斷上完全不同。

**現況（Codex 更正）：** `runtimeSchemaRevision` **已接線**——三個 `/beta/*` 端點的 approval
都綁定 runtime schema revision。export 工具已改但**未在 container 內重跑**，
所以目前的 revision 前綴仍是 `unknown+`。

**尚未做到的是：把 freshness / stale 變成入場阻擋條件。** 目前 revision 參與 fingerprint
（schema 變了 approval 就失效），但「快照太舊」本身不會擋下任何操作。
提案第 4 點的三值判定已實作於模組，**未接為 gate**。

---

## E. §8 實作狀態表

**此節內容已移至第一部分 1.2**，因為它描述現況而非目標。

規格 §8 應直接引用第一部分的表格，並採「測試數／是否接線／驗證方式」三欄——
現行單欄「狀態」把「有程式」與「使用者走得到」混為一談，是初版錯誤的來源之一。

**併入時必須重新確認接線欄位**：Codex 正在接線 `planDiff` 與 `capabilityGap`
（鎖 topic `plan-first-r5-r11-r17-wiring`），完成後 1.2 表格需更新。

## F. §12 成功標準 — 補上可衡量的指標

**Dan 已指示論文只寫到 fine-tune model 部分**，因此以下**不是論文指標，
而是架構自我評估用**——用來回答「這套東西到底有沒有用」。

**問題：** Node F1 / Connection F1 衡量「產出的 JSON 有多像參考答案」，
但本系統的核心價值是**誠實地拒絕**。一個永遠回 `capability_gap` 的系統 F1 是 0，
但它從不騙人。

**提案指標：**

| 指標 | 定義 |
| --- | --- |
| **False Ready Rate** | 系統宣稱 `ready_to_run` 但實際執行失敗的比例。**最重要的一項。** |
| Honest Gap Rate | 需求不受支援時，正確回 `capability_gap` 的比例 |
| Over-refusal Rate | 需求其實受支援卻回 `capability_gap` 的比例（誠實度的代價，必須一起報告） |
| 狀態分佈 | 一組任務在各終端狀態上的分佈 |
| End-to-end Success | NL 到 `execution_passed` 的完整通過率 |

Easy-100 的測資與 evaluator 已齊備（`n8n_workflow_generator/evaluation`、
`workflow_template/S1|S2|S3_*/testing_data_low_100.jsonl`），不需重建 harness。

---

## G. 併入前的檢查

- [ ] Dan 核准哪幾節併入
- [ ] Codex 覆核技術描述是否與他的接線設計一致（特別是 A、B、D2）
- [ ] 標為「尚未接線」的項目在併入時狀態是否已改變
- [ ] 版本號統一：文件頭、§7 內文、§10.3、§13 標題目前混用 v0.2 / v0.3
- [ ] §13 改為累積式 changelog（v0.2 / v0.3 / v0.4 各一段），否則無從追蹤哪輪回饋在哪版處置
