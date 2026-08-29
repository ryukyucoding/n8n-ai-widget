# Release Manifest — R3（SSRF 修補）

**產出者：** Claude ｜ **2026-08-28** ｜ **git 執行者：Codex（Windows 原生）**

Dan 已核准依 Codex 的 release 流程。這份清單就是「要 cherry-pick 哪些東西」的具體內容。
**Claude 不執行任何 git 操作**，這份文件是交接，不是動作。

---

## 1. 變更檔案（共 5 個）

### 新增

| 檔案 | 作者 | 內容 |
| --- | --- | --- |
| `chatbot/src/publicUrlPolicy.js` | Claude（**覆蓋了 Codex 的初版，見第 4 節**） | URL 政策：denylist + 可選 allowlist + 選用 DNS 檢查 |
| `chatbot/src/publicUrlPolicy.test.js` | Claude | 42 個測試 |

### 修改

| 檔案 | 誰改的 | 改了什麼 |
| --- | --- | --- |
| `chatbot/src/nodewiseCompiler.js` | **Codex** 加 require 與呼叫；**Claude** 改為顯式帶入 allowlist | `public_literal` URL 改走政策模組 |
| `chatbot/src/rssDigestCompiler.js` | Claude | `feedUrl` 改走政策模組；輸出新增 `feedHost` 供 plan review |
| `chatbot/src/rssDigestCompiler.test.js` | Claude（**在既有檔案末尾 append，未改動原有測試**） | 新增 9 個 feedUrl SSRF 測試 |

**未改動：** `runtimeSkillRegistry.js` 的三軸風險模型尚未實作（原 R3 提案的一部分，尚未做）。

---

## 2. 修補內容

修補前，兩處 compiler 對 URL 的唯一檢查都是 `protocol === 'https:'`。
n8n runtime 跑在使用者網路內部，而 URL 來自 LLM 產生的 specification，因此以下全部可達：

- `https://169.254.169.254/latest/meta-data/` — 雲端 instance metadata（憑證竊取標準路徑）
- `https://127.0.0.1:5678/api/v1/credentials` — **n8n 自己的 API**
- RFC1918 / CGNAT / IPv6 ULA / link-local 全部可達

現在阻擋：RFC1918、loopback、link-local、CGNAT、IPv6 ULA 與 link-local、
**`::ffff:` IPv4-mapped 繞過**、非標準 port、`user:pass@` userinfo、
內部網域後綴（`.local` `.internal` `.corp` …）、單標籤主機名、IP literal。

**兩個 compiler 的政策不同，這是刻意的：**

| Compiler | allowlist | 理由 |
| --- | --- | --- |
| `nodewiseCompiler` | **強制**（`VERIFIED_PATTERN_HOSTS`） | beta 只跑受驗證 pattern，收窄邊界幾乎沒有成本 |
| `rssDigestCompiler` | **不套用**，只用 denylist | feed URL 由使用者自訂，不可能維護固定名單 |

RSS 那側的代價是使用者仍可指向任意公開 feed。這是預期行為，
但目的地必須讓使用者看得見——所以輸出帶了 `feedHost`，供 plan review 顯示
（審查建議 B8：plan 摘要必須顯示會連到哪些外部網域）。**plan review UI 尚未接上這個欄位。**

---

## 3. 測試狀態

| 範圍 | 結果 |
| --- | --- |
| R3 相關（policy / nodewise / rssDigest / rssEmailDraft / beta） | **59 passed, 0 failed** |
| `chatbot/src/` 全套 | **199 passed**，2 個失敗（皆非本次造成，見下） |

### 兩個既有失敗

**`chatProgress.test.js:68` — 環境假象，不是 bug。**
測試用 LF 換行的字串字面值去比對 `chat.html`，而 Windows checkout 的該檔是 CRLF。
已實測：`s.includes('...\n...')` 為 false，`s.includes('...\r\n...')` 為 true。
**在 Linux 部署環境（git 以 LF checkout）應會通過。** 同一檔案第 64 行的測試就有正確處理
（用 `/\r?\n/`），第 68 行漏了。
**Claude 未修改**——這不是 Claude 的檔案，且依 P11 不單方面改對方的測試。建議改成 `\r?\n` 比對。

**`candidateWorkflowVerifier.test.js:144` — 尚未診斷。**
與本次修補無關（該檔未 import `publicUrlPolicy`，mtime 為本 session 之前）。歸屬待議。

---

## 4. 必須揭露的事故

**Claude 用 `cat >` 覆蓋掉 Codex 已寫好的 `publicUrlPolicy.js`，內容永久遺失**（該檔未進 git，無備份）。
兩人命名不同（`validatePublicHttpsUrl` vs `assertPublicHttpsUrl`），
一度造成 `nodewiseCompiler.js` 的 require 取到 `undefined`——
**檔案照樣載入成功，要執行到那一行才 TypeError。** 目前以相容別名解決。

此事故已促成協定 **P11（原始碼檔案所有權）** 與 **快照機制**。
若 Codex 的初版有本版缺少的設計，請提出，Claude 補回。

---

## 5. 發布前仍未完成

- [ ] **R3 未在真實 n8n runtime 驗證**——只有單元測試。單元測試證明邏輯對，不證明 n8n 裡攔得住。
- [ ] R1（IR 攜帶 planFingerprint）、R2（架構不變式）、R17（schema digest）三個 P0 未實作
- [ ] `runtimeSkillRegistry` 三軸風險模型未實作
- [ ] plan review UI 未顯示 `feedHost`
- [ ] 執行期 DNS rebinding 無防線（見 `publicUrlPolicy.js` 的 `RESIDUAL_RISKS`）
- [ ] `deployBetaChatbotOn44.sh` 的 `BETA_WORKTREE` 需顯式指向 release worktree

**Claude 的立場：R3 本身可以發布**——它嚴格優於現況（現況是完全無防線），
且不改變任何既有行為，只收窄允許範圍。但它是安全修補，不是「架構完成」。
把它當成「補上一個洞」而不是「上線一個系統」，預期才會正確。
