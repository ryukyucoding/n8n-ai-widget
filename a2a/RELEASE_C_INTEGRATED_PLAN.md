# Release C — 整合受控 beta 發布計畫

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

## 2. C0 — 前置阻擋項（不解掉，護欄就是假的）

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
`/models` 回應加上 `planFirst: { enabled }`，讓 smoke test 可以斷言。
目的是讓「部署」與「啟用」成為兩個各自可回滾的動作。

### C0-3　Secret 的產生與保管　【阻擋】

`PLANNER_APPROVAL_HMAC_SECRET` 目前只出現在 `index.js`，沒有任何 deploy script 設定它。
需要決定：長度 ≥32、放進 deploy 用的 `--env-file`、不進 git、不進 log。
並確認 `planBinding.js` 的任何錯誤路徑都不會把 secret 寫進訊息或 log。

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
