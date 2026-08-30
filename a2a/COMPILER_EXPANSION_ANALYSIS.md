# Compiler 能力擴充：該先補哪些，以及為什麼那張缺口次數表會誤導

分析日期 2026-08-30（Dan 睡後，Claude 獨立完成）
資料：`workflow_template/S1_ft_original_description/testing_data_low_100.jsonl`
工具：`chatbot/tools/audit_easy100_capability_coverage.js`（既有工具，未修改）
重現：`caseCount 100`、`blocked_by_current_skill_library 100`、缺口次數與簡報第 8 頁完全相同

---

## 1. 那張表回答錯了問題

簡報上的缺口次數表回答的是「**哪個缺口最常出現**」。
但要決定先做什麼，該問的是「**補哪些能解鎖最多題**」——因為一題要所有缺口都補齊才算能做。

兩者的答案幾乎相反：

| 缺口 | 出現次數 | **單獨補它能解鎖的題數** |
|---|---:|---:|
| credentialed_integration | 175 | **0** |
| ai_service | 148 | **3** |
| node_skill | 82 | **0** |
| http_post_or_authenticated_request | 62 | **0** |
| control_flow | 56 | **0** |
| mapping_semantics | 49 | **0** |
| arbitrary_code_semantics | 43 | **0** |
| schedule / trigger / email | 20 / 20 / 7 | **0** |

**出現最多的那個，單獨補它解鎖 0 題。**
原因：每題被 **中位數 4 種** 缺口擋住（1 種的只有 3 題，4 種以上的有 54 題）。

## 2. 累積解鎖曲線：能力擴充有門檻效應

依貪婪順序補下去：

```
補 1 種 →   3 / 100     補 6 種 →  46 / 100
補 2 種 →  12 / 100     補 7 種 →  58 / 100
補 3 種 →  22 / 100     補 8 種 →  76 / 100
補 4 種 →  27 / 100     補 9 種 →  93 / 100
補 5 種 →  35 / 100     補 10 種 → 100 / 100
```

前段很平，後段陡升。**「補了三種只解鎖 22 題」不是做得不好，是這個問題的形狀。**
這件事必須先講清楚，否則接下來幾個月的每一次進度回顧都會看起來像原地踏步。

## 3. 最重要的發現：Easy-100 是一個「憑證整合」語料庫

```
73 / 100  題需要憑證整合
10 / 100  題既不需要憑證也不需要 AI 服務
          （而這 10 題每題仍有 2 種以上其他缺口，沒有一題是單一缺口）
```

「編譯器內部、不需要憑證」那一族（mapping、control_flow、POST、code、schedule、trigger），
**六種全部做完也只解鎖 5 題**。對照之下 `credentialed + AI` 兩種就是 12 題。

**結論：不做憑證子系統，就無法在 Easy-100 上取得有意義的進展。**
Dan 自己列的 future work 第 2 項「把 credential 放進 workflow 的 setup 流程」，
資料顯示它不是第 2 項，**它是閘門。**

## 4. 但編譯器內部的工作仍然要做——它是共用前綴

```
需要 mapping 泛化的 43 題中，32 題同時需要憑證
需要控制流的   39 題中，31 題同時需要憑證
含憑證缺口的 73 題中：43% 也要 mapping、42% 也要控制流、38% 也要 POST
```

也就是說 mapping 與控制流**不是繞路，是幾乎每條路都會經過的前段**。
先做它們不會讓 Easy-100 的數字動，但之後每一個憑證整合都會用到。

## 5. 各桶內部高度集中，這決定了實作成本

```
credentialed 175：googleSheets 39 + gmail 27 + googleDrive 14 + googleDocs 6 = 86 是 Google
ai_service   148：agent 28 + lmChatOpenAi 25 + openAi 17 + memoryBuffer 14 + chatTrigger 13 = 97 是 LangChain agent 堆疊
control_flow  56：if 28 + splitInBatches 10 + wait 10 = 48（if 一個就佔一半）
http_post     62：全部都是 n8n-nodes-base.httpRequest —— 節點型別已經實作，缺的是 method 與認證
node_skill    82：長尾，splitOut 11 是最大宗，其餘各 2–6。**這桶最貴、最不值得先做**
```

## 6. 建議的建置順序

**先講一個不建議做的**：`arbitrary_code_semantics`（43 次）**建議永久保持關閉**。
補它等於讓 planner 產生任意程式碼，那會摧毀「workflow JSON 由 deterministic compiler 組裝、
不由 LLM 自由生成」這個讓整套系統可被信任的性質。
它應該是一條**宣告出來的邊界**，由 capability gap 誠實說明，而不是待辦事項。

| 順序 | 內容 | 為什麼 | 對 Easy-100 |
|---|---|---|---|
| 0 | **修好 plan-first 雙重驗證並正式 commit** | 目前線上跑的是未 commit 的本地 patch，無法回溯到任何 commit | — |
| 1 | **來源 schema 綁定**，然後才逐一登錄公開 API | 見第 9 節的更正：放寬清單本身會重新引入本專案要消滅的失敗模式 | 不動，但**可展示範圍變大且仍然可信** |
| 2 | **泛化 `set` 的 mapping 語意** | 43 題需要，是最大的共用前綴；編譯器內部，不碰憑證 | 單獨 0 題，但後續每題都會用到 |
| 3 | **`if` 控制流** | 控制流 56 次裡 28 次是它；編譯器內部 | 同上 |
| 4 | **憑證子系統 + 存取控制** | 73 題的閘門。**先做 Google 一家**（86/175） | 這一步才會讓數字真的動 |

## 7. 一個必須先講的相依關係

**第 4 步不能只做「憑證」。**
目前六條寫入路由沒有任何呼叫者身分驗證、CORS 為萬用來源
（Dan 已裁決在沒有真實使用者前延後，那個裁決在當下是對的）。

但是——**不可能在一個不驗證呼叫者身分的端點上，請使用者交出他的 Google 憑證。**

所以 C0-4b 的存取控制不是「之後有空再做的加固」，**它是憑證階段的前置條件**。
它會以「能力的使能者」的身分回來，而不是以「防禦」的身分。
這一點應該現在就寫進路線圖，免得到時候被當成臨時插進來的阻礙。

## 8. 對衡量方式的建議

Easy-100 作為研究基準是誠實的，簡報照實報告也是對的，應該保留。
但**它不適合當作接下來幾個月的進度訊號**——第 2 節的曲線顯示它會長期停在接近 0。

建議另立一個近期指標，讓下一個增量真的推得動它，例如：
**「不需要憑證、以公開 API 完成、且真的在 n8n 執行成功的 workflow 種類數」**。
今天是 1 種（jsonplaceholder 使用者 + todo 統計）。第 1～3 步會讓這個數字明顯成長，
而 Easy-100 在同一段時間仍然會是 0——兩個指標同時報告，才是完整且誠實的圖像。

---

## 9. 第 1 步的成本：我原本估錯了（Codex 更正，已實測確認）

我原本寫「放寬允許清單是設定變更，不是開發工作」。**這個說法是錯的**，
Codex 指出每個新 API 仍須有受限的 skill，不能讓 planner 任意拼 URL 與欄位。
我把它的後果實測出來，結果比他說的更嚴重。

### 先確認我原本對的部分

```
只做 denylist 檢查（不帶 allowlist）：
  通過  https://api.github.com/x · https://api.open-meteo.com/x
  擋下  https://127.0.0.1/x · https://169.254.169.254/x
```

**allowlist 與 denylist 確實是獨立兩層**，放寬 allowlist 不會削弱 SSRF 防護。這一點成立。

### 但錯的部分嚴重得多

把主機換掉、並刻意使用目標 API 根本不存在的欄位：

```
編譯結果：✓ 通過，5 節點

產生的 code 節點：
  const records = $input.all().map((item) => item.json);
  const falseCount = records.filter((r) => r.totally_nonexistent_boolean_field === false).length;
  return [{ json: { name: source.this_field_does_not_exist, totalTodos: records.length,
                    incompleteTodos: falseCount } }];
```

**compiler 完全沒有檢查那些欄位是否存在於該 API 的回應中**——它只檢查識別字是否安全。
這個 workflow 會**執行成功**，然後回傳 `name: undefined`、`falseCount: 0`。

**這正是本專案存在的理由所要消滅的失敗模式：看起來合理、跑得動、但是錯的。**
與 fine-tuned 模型那 93 個「可解析但不可用」的 workflow 是同一種東西，
只是從「n8n 的節點 schema」搬到了「外部 API 的回應 schema」。

現況之所以沒出事，只是因為 allowlist 只有一個主機，
而那個主機的回應形狀剛好被寫死在三個 transform 的假設裡。

### 因此第 1 步的內容改寫

**不是「放寬允許清單」，而是「來源 schema 綁定」：**

- 每個登錄的 API host 必須附帶一份**宣告的回應 schema**
- compiler 必須驗證 planner 引用的每個欄位確實存在於該來源的 schema 中
- 目前 compiler **沒有「這個來源會產生哪些欄位」的概念**，這是要新增的能力

**這個機制本身就是第 1 步的實作內容。** 建好之後，逐一登錄新 API 才真的便宜。
順序不變，但成本估計要改：它不是設定調整，是一個新的編譯器能力。

### 一個對稱性：這個設計模式已經存在於程式碼中

系統已經有 `runtimeSchemaRevision`——把計畫綁定到 n8n 的節點 schema 版本。
來源 schema 綁定是同一個想法套用到外部 API：
**先宣告 schema，再驗證引用，最後把版本綁進 approval token。**
不必發明新架構，把既有的模式再用一次。
