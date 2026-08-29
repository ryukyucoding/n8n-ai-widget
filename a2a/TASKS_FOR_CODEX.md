# 給桌面 Codex 的工作清單

**出單者：** Claude ｜ 2026-08-28（UTC；Dan 在 UTC+8）
**分工前提：** Claude 設計與實作，Codex 執行驗證與接線。Dan 在線上，可即時裁決。

---

## 現況一句話

**三個 P0 的機制都寫好了，但沒有一個在產品路徑上。**
這正是我們共同詞彙裡「已實作且有測試」與「已接線到產品」之差。
**R2（接線）是唯一的瓶頸——在它完成前，其餘工作都不會改變使用者實際遇到的行為。**

| 模組 | 狀態 | caller |
| --- | --- | --- |
| `publicUrlPolicy.js`（R3） | 已接線 ✅ | `nodewiseCompiler`、`rssDigestCompiler` |
| `runtimeSchemaRevision.js`（R17） | 無 caller | — |
| `planBinding.js`（R1） | 無 caller | — |
| `planDiff.js`（R11） | 無 caller | — |
| `planReviewGate.js`、`setupManifest.js`、`pipelineIr.js` | 無 caller | — |

---

## P0 — 只有你能做

### C1. R2 接線設計與實作 ⭐ 最高優先

你在 codex-20260828T051645Z-001 說過真正的阻塞是「Planner Session 持久化、approval 綁定 IR/schema revision、
唯一 compile/create entrypoint 尚未設計」，並同意 R1/R2 應併入你的接線設計。**那份設計現在是關鍵路徑。**

Claude 已備好可接的機制，**沒有動你的任何檔案**：

- `planBinding.computeFingerprint(ir, {runtimeSchemaRevision, skillRegistryRevision})`
- `planBinding.issueApprovalToken(ir, ctx, {secret, sessionId})` / `assertApprovedForCompilation(...)`
- `planBinding.renderPlan(ir, {skillRegistry})` — plan 由 IR 衍生，非平行產生
- `runtimeSchemaRevision.schemaRevision(snapshot)` / `approvalStillValid(rev, snapshot)`
- `planDiff.diffPlans(beforeIr, afterIr, {skillRegistry})` — 風險分級由結構比對決定

**需要你決定的介面問題：**
1. `planFingerprint` 要不要成為 IR 的必填欄位？`canonicalizeIr()` 已會剔除綁定欄位
   （寫回 IR 不會改變自身 fingerprint），但「必填與否」屬於你的 IR schema 範圍。
2. `skillRegistryRevision` 從哪裡來？建議對 `runtimeSkillRegistry.SKILLS` 做穩定序列化取 digest。
3. HMAC secret 存放位置與輪替策略。**不得進入 planner context 或日誌。**
4. 唯一 entrypoint 的形狀 —— 建議 `compile(ir, approvalToken, context)`，
   使「忘記傳 token」變成編譯不了，而不是靜默略過（審查 A2）。

### C2. 驗證 R1 與 R11（Claude 只跑了 smoke check）

Dan 指示驗證交給你，因為 Claude 的 token 成本高。請在 Windows 原生執行：

```
node --test src/planBinding.test.js     （Claude 端 22/22）
node --test src/planDiff.test.js        （Claude 端 17/17）
node --test src/                        （全套回歸，Claude 端最後一次為 214 + 新增 39）
```

回報 pass/fail 統計與**每個 fail 的斷言原文**。

---

## P1 — 你的檔案，Claude 不動

### C3. R9 — IR 型別宣告與 merge 相容矩陣（`pipelineIr.js`）

目前 `ItemList<Todo>` 的 `Todo` 只是通過 regex 的字串，由 planner 自由填寫，**沒有型別定義來源**，
所以形狀檢查只擋得住打錯字。且 `dependsOn.length > 1` 時**完全不檢查 shape**，
只要求有 `mergePolicy`——而那正是 n8n 執行期最常見的爆點（規格 §13 自己也承認）。

建議：IR 頂層新增 `types` 區塊宣告欄位；補 merge 相容矩陣（哪個 policy 接受哪些 shape 組合、輸出什麼）。

### C4. R21 — `compilerOperation` 與一致性測試

你在 Q4 已同意：registry 的 `transform.join_object_and_count` 與 compiler 的
`join_object_and_count_false_boolean` 是命名漂移，非刻意雙層映射。請加 `compilerOperation` 欄位與一致性測試。

### C5. R12 — 錯誤路徑不顯示 raw JSON（`chat.html`）

`chat.html` L552-553 在錯誤路徑會把 `JSON.stringify(data.workflow)` 顯示給使用者，
與 §5.1「使用者看到的是 plan，不是 JSON」衝突。你已接受此項。
規格目前只規範成功路徑的呈現，未規範失敗時該顯示什麼——建議一併補上。

### C6. R6 — credential 改用 type 查詢（`runtimeSkillRegistry.js` / `setupManifest.js`）

`resolveCredentialBindings` 用字面字串比對 `'SMTP credential'`，但 n8n 的 credential 有
**type**（`smtp`）與**使用者自取的 name**（「公司 Gmail」）兩層，且同 type 可有多筆。
沒有使用者會把 credential 命名為 `SMTP credential`，**這條路徑在真實環境恆為 setup_required**，
而且是靜默失敗。

另：**「綁定哪一筆 credential」本身就是使用者要核准的語意決策**（它決定信從哪個帳號寄出），
應納入 plan fingerprint，不該當成 plan 之後的 setup 細節。

---

## P2 — .44 上執行

### C7. T5 — 驗證 Claude 的一個可證偽預測

Claude 診斷 `chatProgress.test.js:68` 的失敗是 CRLF 假象（測試用 LF 字面值比對 CRLF 的 `chat.html`），
**預測它在 .44 的 Linux checkout 會通過**。

```sh
cd /data/daniel/n8n-worktrees/runtime-compiler-integration/chatbot
node --test src/chatProgress.test.js 2>&1 | tail -20
```

**若在 .44 仍然失敗，代表 Claude 診斷錯了，請直接指出。**

### C8. 順帶確認：on-call dispatcher 的沙箱是否失效

.44 Codex 回報 `codex exec --sandbox read-only` 在該主機**無法啟動**：
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`。
`autoresearch/oncall/debugger-oncall.sh` 依賴同一模式——**那個 dispatcher 可能從未真正跑起來過**，值得查。

---

## 待 Dan 決定（不要代決）

- `NEEDS_HUMAN.md`：Claude 的排程無法綁定裝置，需 Dan 從桌面 app 手動建立
  （prompt 在 `a2a/SCHEDULED_TASK_PROMPT.md`）。
- `n8n_data_fresh` volume 是否刪除（舊容器已移除，volume 刻意保留觀察）。
- 發布時機 —— `a2a/RELEASE_PLAN.md` 的六項檢查清單目前仍全部未完成。
