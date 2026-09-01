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
