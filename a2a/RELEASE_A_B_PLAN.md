# 兩階段發布計畫

**決定者：** Dan（2026-08-28）｜**提出：** Claude｜**技術覆核與更正：** Codex
**git 與部署執行者：** Codex（Windows 原生）。**Claude 不碰 git 與部署。**

---

## 為什麼拆

原本七項一起送。但這批東西是兩種性質：

- **R3 是補一個既有漏洞** —— 現況是完全沒有內網防線。
- **R1/R2/R5/R11/R17 是新的產品行為** —— 需要真人多用幾天才知道好不好用。

綁在一起的話，「在真實 n8n 驗證 R3」那一步一旦卡住，**安全修補會跟著卡住**。
而那一步是整個流程裡唯一可能讓我們往回走的（其餘失敗都只是修一下再跑）。

Dan 的判斷：兩次選擇性 staging 與部署較麻煩，但換來更小的風險面與更清楚的 rollback，划算。

---

## ⚠️ 對 Release A 影響的誠實描述（Codex 更正 Claude）

Claude 原本寫「R3 不改變任何既有行為，只收窄允許範圍」。**這句話是錯的，已更正。**

Codex 的更正：

> 它會刻意拒絕原本可能被接受的危險 URL，**這是安全上的行為改變，不是零行為差異。**

**收窄允許範圍本身就是行為改變。** 具體影響：

- 既有 workflow 若使用內網位址、IP literal、非標準 port、或內部網域後綴，
  **重新編譯時會被拒絕**，不再靜默通過。
- 使用者會看到明確的拒絕訊息，而不是像以前那樣建立出一個指向內網的 workflow。
- **這是預期且必要的**，但發布說明必須這樣寫，不能寫成「零影響」。

Claude 把影響講輕，是為了讓「先送這個」的理由更漂亮——**那是今天第四次同一形狀的錯誤：
讓一個看起來乾淨的說法，超前於實際成立的東西。**

---

## Release A — URL / SSRF 防護

**內容（僅此，不夾帶）**

| 檔案 | 性質 |
| --- | --- |
| `chatbot/src/publicUrlPolicy.js` | 新增 |
| `chatbot/src/publicUrlPolicy.test.js` | 新增（42 測試） |
| `chatbot/src/nodewiseCompiler.js` | 修改：`public_literal` URL 改走政策模組，帶入 `VERIFIED_PATTERN_HOSTS` |
| `chatbot/src/rssDigestCompiler.js` | 修改：`feedUrl` 改走政策模組（只用 denylist）；輸出新增 `feedHost` |
| `chatbot/src/rssDigestCompiler.test.js` | 修改：末尾 append 9 個 SSRF 測試，未改動原有測試（**見下方待裁決項**） |

**不含：** `planBinding`、`planDiff`、`capabilityGap`、`runtimeSchemaRevision`、
`approvedNodewiseCompiler`、`index.js` 的新端點。

### ⚠️ A1 逐行確認的結果：找到一個邊界不純的項目

Codex 要求 A1 逐行確認 `rssDigestCompiler.test.js` 的新增內容全屬 R3/SSRF。
**Claude 已先行確認，並找到一項不純：**

已確認乾淨：新增區塊無任何 `require`、無任何 Release B 模組引用；原有 3 個測試未被改動；
新增 7 個 SSRF 阻擋測試 + 1 個公開 feed 放行測試，全部只驗 URL 政策。

**不純的一項：** 第 9 個測試 `編譯結果保留目的地網域供 plan review 顯示（審查建議 B8）`
驗的是 `rssDigestCompiler` 輸出的 `feedHost` 欄位。**該欄位的存在目的是給 plan review 顯示網域，
而 plan review 屬於 Release B。**

- `feedHost` 由 R3 的同一處程式碼變更產生，且在 Release A 中**無任何 consumer**（惰性欄位）。
- 保留：邊界略不純，但不改變行為，且避免同一檔案被編輯兩次。
- 移除：邊界乾淨，但要為此多改一次 `rssDigestCompiler.js` 與測試檔。

**Claude 不自行決定——邊界規則是 Codex 訂的，由他裁決。**

**可以先做真實 n8n 驗證** —— 這是拆開的主要理由。

**回滾邊界：** 只要 revert 這五個檔案，內網防護消失但其餘完全不受影響。

## Release B — 新 workflow 架構

**內容**

| 檔案 | 對應 |
| --- | --- |
| `planBinding.js` + test | R1 |
| `approvedNodewiseCompiler.js` + test | R2 |
| `capabilityGap.js` + test | R5 |
| `planDiff.js` + test | R11 |
| `runtimeSchemaRevision.js` + test | R17 |
| `tools/export_runtime_node_schemas.js` | R17（版本錨點） |
| `index.js` | 三個 `/beta/*` 端點 |
| `candidateWorkflowVerifier.test.js`、`chatProgress.test.js` | Codex 修正的兩個既有失敗 |

**作為獨立回滾邊界** —— 產品流程若有問題，不會波及已上線的安全修補。

**影響描述：** 新增 plan review / HMAC approval / capability gap / diff 流程。
這些是**新行為**，不影響既有 create 路徑；legacy `compileRuntimeBeta` 維持不變
（INV-1 具名例外：僅兩個固定已驗證 pattern，不接受 planner 輸入）。

---

## 步驟

### Release A

| # | 步驟 | 誰 |
| --- | --- | --- |
| A1 | 選擇性 staging 上表五個檔案，提供清單給 Dan 過目 | **✅ 已核准 2026-08-29** |
| A2a | 從 `ollama-widget` 開 release 分支、本機 commit（**可逆**：刪分支即可） | **✅ 已授權 2026-08-29** |
| A2b | **push 到 remote**（**此步之後他人可 pull，回退成本大幅提高**） | Dan 另行授權 → Codex |
| A3 | 同步到 .44、`npm install`、跑該分支全套測試 | Codex |
| A4 | **在真實 n8n 驗證內網防護實際擋得住** | Codex |
| A5 | 移除既有 `n8n-chatbot-beta` 容器（不可逆，人執行最後一步） | Dan 授權 → Codex |
| A6 | 部署、開 SSH tunnel 實測、驗收 | Codex → Dan |

### Release B

同樣六步，但 A4 換成「plan review / approval / capability gap 的端到端實測」。

### ⚠️ schema 重抓不得併入 A3（Codex 更正 Claude）

Claude 曾建議「在 A3 順手重跑 `export_runtime_node_schemas.js`」。**已撤回。**

Codex 的裁決：

> 那是 Release B 的基線更新，應獨立授權、保留證據，再納入 B。

**他是對的，而且 Claude 的建議與自己的論點自相矛盾。**
Claude 一邊主張「乾淨的回滾邊界值得多花兩次部署」，一邊建議把一個不屬於 A 的基線變更塞進 A3。
**若 A 部署期間 schema 變了，A 的行為就依賴一個不屬於 A 的變更——回滾 A 不會回滾 schema，邊界當場破掉。**

schema 重抓改列為 **Release B 的前置步驟 B0**，需獨立授權並保留匯出證據
（`n8nVersion`、`nodeTypesDigest`、`nodeTypeCount` 與前後對照）。

---

## 硬性限制（沿用 `RELEASE_PLAN.md`）

- 只用 Windows 原生 Git + 顯式路徑 staging。**絕不 `git add -A`。**
- `.gitattributes` 在專門稽核前不動。
- 部署腳本必須顯式指定 release worktree（預設指向 `runtime-compiler-integration`，不是 release 分支）。
- **A2A 本身不授權任何 git 寫入或部署**，每次都要 Dan 明確同意。

---

## 附帶結論（Codex 已寫入 outbox）

`nodewiseSpecificationForDiff()` 的投影**只能用於顯示差異，不能當 canonical IR
或 fingerprint 的輸入**。應寫進規格——否則未來擴充該投影時，
會重新製造 Codex 今天修掉的「canonical IR 驗證後遺失欄位」bug。
