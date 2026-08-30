# Release C — 整合受控 beta 發布計畫

> ## ⚠ 優先順序修正（Dan 裁決，2026-08-29）
>
> Dan：「安全的問題從來沒想過，反正也沒有真的使用者在用，我們不能等把東西做出來再去檢查安全方面的問題嗎？
> 我感覺你的重要性順序排錯了。」
>
> **他是對的。** 這是一個研究原型，使用者只有他一人，而它**該做的事還沒做到**——
> 部署上跑的是兩個 pattern 的查表，真正的 compiler 路徑從未被接上任何路由。
> 我今天花整天保護一條沒人走、而且還不會動的路。
>
> 更難堪的是：**這個判斷我今天自己講過**——「真正的產品路徑從來沒有被接到任何 HTTP 路由上，
> 那比這兩個發布加起來都大」——講完之後我繼續做安全，沒有照自己的結論走。
>
> **本計畫的目標因此改寫：**
> ~~讓 nodewise 路徑安全地第一次可達~~ → **讓 nodewise 路徑第一次真的跑出一個能執行的 workflow。**
>
> 分類原則改成：**「這件事是讓它會動，還是讓它安全？」**
> 讓它會動的留下；讓它安全的，除非成本是一行，否則延到有真實使用者之前再處理。
>
> 逐項重新分類見第 2 節開頭的表。


取代 `RELEASE_A_B_PLAN.md`。A/B 拆分的理由（「R3 補一個線上既有漏洞」）已證實為假，
見 `claude-20260829T060427Z-008` / `-010`。Codex 已撤回「從 3363f37 做 Release A」的建議。

---

## 0. 取代掉的前提

| 舊前提 | 實測結果 |
|---|---|
| nodewise/rss 的 SSRF 是線上活漏洞 | **不可觸發。** 從 `c0bf786:chatbot/src/index.js` 出發的 require 圖遍歷，14 個可達模組中不含 `nodewiseCompiler.js`、`rssDigestCompiler.js`、`nodewisePlannerEnvelope.js`、`rssEmailDraftCompiler.js` |
| 唯一上線的 compiler 也可能有同樣的洞 | **沒有 SSRF 面。** `runtimeCompilerBeta.js` 的 URL 全部寫死在原始碼，`compileBetaRequest` 是兩個 pattern 的 regex 比對 |
| Release A 是「五個檔案的安全修補」 | 這個邊界是人造的。它切開了必須原子綁定的東西 |

## 1. 取代它的原則

> **發布單位 = 路由 + compiler + 全部護欄，原子綁定。**
> 不允許任何順序讓「可達」先於「護欄」出現。

R3 的正確定位：**nodewise/RSS 正式接線前的必要護欄**，不是熱修補。
其他五個模組（R1 planBinding、R5 capabilityGap、R11 planDiff、R17 runtimeSchemaRevision、
R2 approvedNodewiseCompiler）同理，全部屬於同一個發布單位。

---

## 2. C0 — 重新分類後的前置項

| 項目 | 原本的理由 | 重新分類 | 去留 |
|---|---|---|---|
| **C0-1** schema 重跑 | R17 護欄失效 | **這是正確性問題，不是安全問題。** schema 是五週前的快照，compiler 依它產生 workflow；n8n 的 node schema 若已改變，產出的 workflow 根本跑不起來 | **保留，升為第一優先** |
| **C0-2** 獨立 flag | 部署即上線的安全風險 | **這是開發便利性。** 你需要能「先部署、後啟用」，才能在伺服器上測而不影響現況 | **保留，成本小** |
| **C0-3** secret 政策 | 安全 | 但 secret 沒設 = 端點回 503 = 新路徑根本不能測。**它是「讓它會動」的前置** | **保留** |
| **C0-4a** 綁 127.0.0.1 | 安全 | 成本一行，順手做 | **保留，不當阻擋項** |
| **C0-4b** 呼叫者認證 | 安全 | 防的是還不存在的攻擊者 | **延後**，列入「有真實使用者之前必做」 |
| **C0-4c** CORS 允許清單 | 安全 | 同上 | **延後** |
| **第 10 節** `/generate` URL 政策 | 安全 | 只有 Dan 能執行 workflow | **延後** |

**新的成功條件不是「安全地上線」，是：在 n8n 畫布上，由 nodewise 路徑產生的一個 workflow，
按下執行，真的跑完。** 在那之前，其他都是次要的。

### 原始阻擋項細節（供執行參考）

### C0-1　Schema export 必須重跑　【阻擋】

現況 `chatbot/schemas/runtime_node_schemas.json`：

```
generatedAt = 2026-07-22T03:52:50.866Z
top-level keys = ['format', 'generatedAt', 'nodeTypes', 'skipped']
```

**沒有 `n8nVersion`、`nodeTypesDigest`、`nodeTypeCount`、`exportToolFormat`。**
這份快照比 `export_runtime_node_schemas.js` 的改版更早，五週未更新。

後果：`runtimeSchemaRevision.assessFreshness()` 對每一個請求都回 `unknown`。
**R17 在整個 beta 期間完全沒有作用。** 宣稱「approval token 綁定 runtime schema revision」
在這個狀態下是不成立的。

處置：在 n8n 容器內重跑 export（format 2），產生的檔案進 C1 的同一個 commit。
（先前 Codex 裁定 A3 不得順手重跑 export，理由是污染回滾邊界——那個裁定是對的，
但 A3 已不存在；現在它是 C0 的獨立前置項，有自己的邊界。）

### C0-2　三個新端點必須有自己的 flag　【阻擋】

現況：`index.js:313` `planReviewEnabled()` = `RUNTIME_COMPILER_BETA_ENABLED && secret.length >= 16`。
而 `formal/deployRuntimeCompilerToProductionOn44.sh:96` 已經是 `RUNTIME_COMPILER_BETA_ENABLED=true`。

**等於「部署即上線」。** 目前唯一的意外防線是 `PLANNER_APPROVAL_HMAC_SECRET` 剛好沒有被任何
deploy script 設定（→ 503）。這太脆：任何人為了測試設了 secret，整條 plan-first 路徑就靜默上線，
沒有任何一個步驟需要有人說「我要開了」。

處置：新增 `PLAN_FIRST_COMPILER_ENABLED`，**預設 false**，與 `RUNTIME_COMPILER_BETA_ENABLED` 獨立。

Codex 的補正（`codex-20260829T065350Z-011`）——兩點都必須做到，否則部署與啟用實際上仍然耦合：
- 新 flag 為 false 時，三個端點必須**自己回 404**，不能只是少了一個條件而落到別的分支
- `/models` 必須輸出該 flag，否則 smoke test 無從斷言

目的是讓「部署」與「啟用」成為兩個各自可回滾的動作。

### C0-3　Secret 的產生與保管　【阻擋】

`PLANNER_APPROVAL_HMAC_SECRET` 目前只出現在 `index.js`，沒有任何 deploy script 設定它。
需要決定：長度 ≥32、放進 deploy 用的 `--env-file`、不進 git、不進 log。
並確認 `planBinding.js` 的任何錯誤路徑都不會把 secret 寫進訊息或 log。

**門檻不一致（Codex 指出）**：程式碼目前檢查 `>= 16`，而政策寫 ≥32。兩者必須對齊，
否則一個只有 16 字元的 secret 會通過程式碼檢查但違反政策，而且沒有任何地方會報錯。

### C0-4　C4 對外開啟前必須有存取控制　【阻擋】

由 Codex 從「Dan 的偏好」升級為阻擋項（`codex-20260829T065350Z-011`），我同意升級。

三個新端點目前**沒有任何認證**。`/beta/compile-approved` 背後接的是帶 n8n API key 的 adapter。
一旦 C4 對外開啟，任何網際網路上的呼叫者都能透過它請求建立 workflow。
這不是「beta 範圍要多寬」的偏好問題，是「這條路能不能對外」的前提問題。

C3 只跑 loopback，不受此限；**C4 在存取控制設計完成並測試通過前不得執行**。

#### C0-4 設計（Claude，2026-08-29）

**先修正問題的範圍：這不是三個新端點的問題，是整個服務的問題。**

實測 `chatbot/src/index.js`：

```
認證 middleware                    完全沒有（Authorization 的命中全是對 Ollama 的出站標頭）
app.use(cors())                    無參數 = 萬用字元來源。任何網站都能從訪客瀏覽器跨站 POST
寫入型路由（全部無 caller 身分檢查）
  306 /beta/compile        331 /beta/plan-review    353 /beta/plan-approve
  368 /beta/compile-approved   397 /agent/run       758 /generate
全部以伺服器自己的 N8N_API_KEY 行動
production --publish "${FORMAL_PORT}:3001"          → 綁 0.0.0.0
beta       --publish "127.0.0.1:${BETA_PORT}:3001"  → 綁 loopback（beta 是對的）
```

**結論：chatbot 是一個 confused deputy。** 呼叫者不需要任何 n8n 憑證；
只要到得了 chatbot 的埠或路徑，就能用 Dan 的 API key 建立、修改、刪除 workflow。
`/agent/run` 與 `/generate` **現在就是活的**，不是新端點才有的問題——新端點只是繼承它。

**我無法從雲端證實、必須由 .44 上的 Codex 確認的兩件事**（決定這是「理論缺陷」還是「當下可利用」）：
1. nginx-proxy 是否把 `/generate`、`/agent/run`、`/beta/*` 也路由到 chatbot
   （已知 `/widget.js` 有：部署腳本第 113 行的 smoke test 自己就打 `https://widm-n8n.csie.ncu.edu.tw/widget.js`）
2. 主機或 NCU 邊界是否擋掉對外的 `:3001`

**注意：應用層的安全性目前完全靠沒有人寫下來的網路設定撐著。** 這本身就是要修的理由。

**設計（三層，由小到大，各自可獨立上線與回滾）：**

| | 內容 | 代價 |
|---|---|---|
| **C0-4a** | production 的 publish 改成 `127.0.0.1:${FORMAL_PORT}:3001`，與 beta 一致。nginx-proxy 成為唯一入口 | 一行。移除「直連埠」這條路徑，但不辨識使用者 |
| **C0-4b** | 寫入型路由必須先確認呼叫者是**已認證的 n8n 使用者**，才用伺服器的 key 行動 | 真正的修補，見下 |
| **C0-4c** | `app.use(cors())` 換成明確的來源允許清單（n8n 的 origin） | 帶憑證且會改變狀態的 API 用萬用字元 CORS 沒有辯護空間 |

**C0-4b 的具體作法——要用的函式已經存在了：**

`n8nAgent.js:156` 的 `verifyN8nApiKey(baseUrl, apiKey)` 做的正是需要的檢查：拿一把 key 去打
`/api/v1/workflows?limit=1`，401 就是無效。目前它只在 `index.js:1119` 被呼叫一次，
而且傳的是**伺服器自己的** key（開機自檢）。

改法：讓 widget 送出呼叫者自己的 n8n 憑證，寫入型路由用**呼叫者的** key 呼叫同一個函式，
`ok: true` 才往下走。函式不必新寫，只是目前接在錯的 key 上。

這樣 chatbot 就不再是 confused deputy——它只為通過 n8n 認證的人行動，
而且授權範圍自動與 n8n 自己的一致，不需要另一套權限模型。

**範圍紅利**：C0-4b 同時修掉 `/generate` 與 `/agent/run`。
Dan 選擇先做 Release C，而 C0-4 在 Release C 之內——所以先做 Release C 這個決定，
剛好也把線上那兩條路的洞一起補掉。

---

## 3. C1 — 一次 commit，一個邊界

內容：6 個安全模組 + `approvedNodewiseCompiler.js` + `index.js` 三端點 + C0-2 的新 flag
+ C0-1 重跑後的 schema + 全部對應測試。

不再有「五檔安全修補」。邊界的定義是**「讓 nodewise 路徑第一次可達所需的完整集合」**，
這個邊界是內生的，不是挑出來的。

## 4. C2 — 部署，flag off

沿用 `formal/deployRuntimeCompilerToProductionOn44.sh` 既有的回滾機制
（`ROLLBACK_TAG`、`ROLLBACK_CONTAINER`、health check、`/models` 斷言）。
smoke test 增加一條：`planFirst.enabled === false`。

**此步對現有使用者是真正的零行為差異**——新端點 404，舊路徑一行未改，
nodewise/rss 依然不可達。這次可以誠實這樣說。

## 5. C3 — A4 真實 runtime 驗證，flag on 但不對外

設 secret、設 `PLAN_FIRST_COMPILER_ENABLED=true`，
**只從容器內或 127.0.0.1 存取，不經 nginx-proxy 對外**。
依 `a2a/A4_REAL_RUNTIME_VERIFICATION.md`：9 個 blocking cases + 2 個 allow cases，
失敗分類（3 個可修 / 3 個需重新設計）已預先寫好，不得事後放寬。

## 6. C4 — 對外開啟

只有 C3 全數通過才做。這是唯一一個使用者看得到的步驟。

## 7. 回滾階梯（三層都不需要 git 知識）

| 從 | 回到 | 動作 |
|---|---|---|
| C4 | C3 | nginx-proxy 收回對外路由 |
| C3 | C2 | `PLAN_FIRST_COMPILER_ENABLED=false`，重啟容器 |
| C2 | 發布前 | `docker stop` 新容器，`ROLLBACK_CONTAINER` 改名接回 |

---

## 8. 與發布策略無關、但現在就該處理的單點風險

5 個安全模組 + `approvedNodewiseCompiler.js` + `index.js` 的三端點，
**目前只存在於未 commit 的工作目錄檔案**。

```
codex/autoresearch-a2a tip = 3363f37
  YES publicUrlPolicy.js
  --  runtimeSchemaRevision.js / planBinding.js / planDiff.js
  --  capabilityGap.js / approvedNodewiseCompiler.js
```

唯一備份是 `a2a/snapshots/`，同一台機器、同一顆硬碟。
commit 到分支不等於部署，也不等於 push——這件事不必等發布策略決定。
但 CRLF 假差異讓 `git add -A` 極度危險（P10），必須用明確路徑清單。

---

## 9. 仍需 Dan 決定

1. **Beta 能力範圍**：`VERIFIED_PATTERN_HOSTS = ['jsonplaceholder.typicode.com']`
   代表 nodewise 路徑在 beta 期間只能產生打 jsonplaceholder 的 workflow。
   使用者會大量撞到 capability gap。這是刻意的嗎？
   （撞到時 `capabilityGap` 會給替代方案 + 強制 tradeoff，不會 NoOp——這部分設計是對的。
   但若十次有九次撞到，beta 驗證到的就只有護欄，不是產品。）
2. **誰能用這個 beta**：三個新端點目前沒有任何認證。


---

## 10. 另一條路線：`/generate` 的 URL 政策（**不併入 Release C**）

Codex 在 `codex-20260829T060932Z-010` 指出我的可達性結論有範圍限制：
它只證明了 compiler 路由，沒有涵蓋 fine-tuned 模型的 `/generate` 路由。他是對的。我補做了評估。

**在 production image `1faca2e` 上的實測：**

| 檢查 | 結果 |
|---|---|
| `/generate` 產生的 workflow 是否含模型供給的 URL | **是**，node 參數原樣通過 |
| `verifyCandidateWorkflow` 是否檢查 URL / host | **完全沒有**（唯一命中是 `n8n_url: options.n8nBaseUrl`，那是我方 base URL） |
| `sanitizeCreateWorkflowPayload` | 只投影 `name/nodes/connections/settings/staticData/pinData`；`active` 不在清單中而被丟棄 → **建立為未啟用** |
| 部署碼中是否有自動執行 / 啟用 | **沒有**。全 repo 掃 `api/v1/executions`、`/activate`、`active: true`，唯一命中是 `executionAssertion.test.js` 的測試資料 |
| 前端是否有執行入口 | **沒有**。`chat.html:577` 只提供「→ 在 n8n 中開啟 workflow」連結 |

**結論**：不是可遠端觸發的 SSRF。但它是**儲存型、延後觸發、距離一次使用者點擊**的 SSRF——
而那一次點擊正是使用者的自然下一步（widget 就是把他們送過去的）。觸發時，請求從 n8n 容器內部、
NCU 網路內發出。

**真正該記下來的一句話：**
> **production 上唯一使用者到得了的建立 workflow 路由，完全沒有 URL 政策；
> 而 R3 的 `publicUrlPolicy` 一行都沒有套用到它。**

**為什麼不併入 Release C**：Release C 是「把一條沒人在用的新路徑接上線」，
`/generate` 是「改變一條正在服務使用者的路徑的行為」。兩者的風險型態、回滾方式、
以及要對使用者誠實交代的內容都不同。併在一起就是重蹈今天的錯誤——把「新能力」和
「對運行中系統的改動」混為一談。

**這條路線需要自己的誠實影響描述**：套上政策後，過去會被建立的某些 workflow 會開始被拒絕。
這是**安全上的行為改變，不是零行為差異**。

**尚待確認（我從雲端做不到，需 .44 上的 Codex 或 Dan）**：
- n8n 上除了 Dan 還有誰有帳號 / 能執行 workflow（決定影響範圍）
- 現存的 30 個實驗性 workflow 中是否已有指向內網位址的 httpRequest 節點
