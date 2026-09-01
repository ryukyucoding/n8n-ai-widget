# brain 恢復手冊（BRAIN.md）

**用途：** 當 brain 這個 agent 異常（UI 壞掉、連線中斷、被關閉、模型不回應）時，讓任何協作者（executor / Dan）把它安全復原。
**作者：** executor。**維護分工：** executor 記錄 brain 的恢復方式；brain 記錄 executor 的（見 `EXECUTOR.md`，由 brain 擁有並新增）。
**適用起點：** 從本 cutoff 之後。session id 等易變資訊一律以 placeholder 表示，實值只放本機 handoff（見 §5），不寫進 Git。

## 0. brain 是誰
- 身分：research brain，負責研究規劃/架構、評估工具、複核其他 agent 的實驗結果。
- 執行：Claude Code，經 **claudex** 走 **gpt-5.6-sol**（透過本機 CLIProxyAPI），受 ChatGPT Plus 配額限制。
- 跨 session 名稱：`brain`（啟動必須帶 `CLAUDE_CODE_SESSION_NAME='brain'`，否則其他 session 認不出）。
- transcript id：`<brain-session-id>`（會隨每次冷開變動，**不寫死**；live 值由健康的同事在本機取得並記於 `brain-restart-handoff.md`，見 §5。辨識原則：最近、model=gpt-5.6-sol、session 名 brain）。

## 1. 異常辨識
- brain 視窗顯示 `Connection refused` 或 `429 ... cooling down / usage_limit`：這是**下游 proxy/帳號**問題，不是 brain 本身壞掉 → 先走 §3 確認 proxy/provider，通常 brain 不需重開。
- brain 視窗 UI 顯示錯亂但內容仍在：多為終端機重繪，先 `Ctrl+L`／改視窗大小；真的要換視窗才走 §4 resume。
- `/model` 得到 `unknown provider for model ...`：是 provider routing 問題（session 被導向錯的 provider），反覆 `/model` 或重啟不會修正 → 先辨識 provider（§3）再選 model。
- `ListAgents` 看不到 `brain`、或 brain 對訊息長時間無回應（超過其 heartbeat 週期數倍）：視為 brain 下線 → 走 §2→§4。
- 判斷原則：**先分清「下游 proxy/配額」vs「brain 進程本身」**，不要一律重開。

## 2. 讓舊 brain 先 idle（避免同名雙實例）
- 協定明言同一身分同一時間只能有一個實例在寫（AGENTS.md / PROTOCOL.md §7.3）。復原前**務必確認舊 brain 已停**：關閉舊視窗，或在舊 brain 內宣告 idle。
- 開新 brain 前 `ListAgents` 確認沒有另一個活著的 `brain`；若有兩個，先收掉一個。
- A2A 寫入前跑 `--locks` / `--digest` 確認無其他同身分 writer。

## 3. 確認下游依賴：CLIProxyAPI proxy / provider
brain 沒有 proxy 就完全連不上 GPT。復原 brain 前先確認：
- Port：`Get-NetTCPConnection -State Listen -LocalPort 8317`（應有 1 個）。
- 健康：`curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer sk-dummy" http://127.0.0.1:8317/v1/models` → 期望 200。（`sk-dummy` 是本機 CLIProxyAPI 的 placeholder key，**不是真 credential**，可安全出現在文件與指令中。）
- proxy 死掉（HTTP 000 / port 無）→ `Start-ScheduledTask CLIProxyAPI`，再驗 200。（bounded recovery 詳規見 memory `claudex-proxy-recovery` 與 `EXECUTOR.md`。）
- proxy 活著但 chat 回 429 `usage_limit`/`cooling down` → 是 ChatGPT Plus 帳號配額，**重啟無效**；等重置、換帳號憑證、或走 §4 的 first-party fallback。

## 4. 復原 brain（resume / cold-start）
先讓 claudex 可用（launcher discovery）：claudex 是 profile 載入的 PowerShell 函式，`powershell -NoProfile` 或未載 profile 的 shell **找不到它**。取得方式擇一：
- 開一個**互動式** PowerShell（會自動載入 `$PROFILE`，claudex 即可用）；或
- 手動載入：`. $PROFILE`，或 `. "$HOME\Desktop\claudex\claudex.ps1"`。

主路徑（claudex，把 `<brain-session-id>` 換成 §5 取得的 live 值）：
```powershell
# 首選：接回原對話脈絡
$env:CLAUDE_CODE_SESSION_NAME='brain'; $env:CLAUDEX_MODEL='gpt-5.6-sol'; claudex --resume <brain-session-id>
# 若 id 過期/無效：改用 picker，挑最近、model gpt-5.6-sol 的那個
$env:CLAUDE_CODE_SESSION_NAME='brain'; $env:CLAUDEX_MODEL='gpt-5.6-sol'; claudex --resume
# 冷開（靠讀 A2A/memory/handoff 重新上手，脈絡不接舊對話）
$env:CLAUDE_CODE_SESSION_NAME='brain'; $env:CLAUDEX_MODEL='gpt-5.6-sol'; claudex
```

native fallback（claudex 無法取得時，仍讓 brain 走 GPT）：手動設 claudex 會設的 proxy 變數，直接用 `claude.exe`。
```powershell
$env:ANTHROPIC_BASE_URL='http://127.0.0.1:8317'   # 本機 CLIProxyAPI
$env:ANTHROPIC_AUTH_TOKEN='sk-dummy'              # 本機 placeholder key，非真 credential
$env:CLAUDE_CODE_SESSION_NAME='brain'
claude --resume <brain-session-id> --model gpt-5.6-sol   # --model 才決定 top-level model；務必帶
```
- first-party fallback（配額耗盡、需 brain 立刻工作）：**不設**上述 proxy 變數，直接 `claude --resume <brain-session-id>`。注意這會讓 brain **暫時改用 first-party Claude（model/provider 都變了，不再是 gpt-5.6）**，屬臨時措施，配額恢復後應改回 claudex/GPT。

## 5. 上線後先讀（重建工作狀態）
1. 本機 handoff：`%USERPROFILE%\.claude\projects\<project-key>\brain-restart-handoff.md`（`<project-key>` 與 live transcript id 由健康的同事在本機取得，非 repo 常數；若當次另有 executor handoff 亦讀）。
2. 共用 memory 目錄（brain/executor 同路徑共用）：該 project 目錄下的 `memory\MEMORY.md` 及各條目。
3. A2A：`git fetch`；讀 `a2a/codex.outbox.jsonl`、`a2a/claude.outbox.jsonl`、`a2a/NEEDS_HUMAN.md`、`a2a/CONTINUOUS_RESEARCH.md`、`docs/BRANCH_STRATEGY.md`、`AGENTS.md`、`a2a/PROTOCOL.md`。
4. 當前 refs：跑 `git fetch --all --tags` 後確認 main / ollama-widget / codex/autoresearch-a2a / 進行中的 consolidation candidates 的 tip。
5. validator 啟動坑：`./a2a/a2a.sh` 在本機 exit 49（python3 是 Store 假 stub）→ 用 `export A2A_PYTHON="$(command -v python)"` 或直接 `python validate_a2a.py`，並 `PYTHONUTF8=1 PYTHONIOENCODING=utf-8` 避免中文亂碼。

## 6. 驗證與失敗升級
- 復原成功判準：`ListAgents` 看得到 `brain`；proxy 200；brain 能收發跨 session 訊息（executor ping 一則、brain 能回，回覆時把來訊 `from` 當 `to`）；brain 能讀到最新 A2A refs。
- 一次 resume 失敗 → 改 §4 picker 或冷開一次。仍失敗，或短時間反覆失敗 → **停止重試**，寫一則 `to: human` 告知 Dan，附時間與前後狀態，不要連續告警。
- 任何需要改持久設定（proxy 常駐化、權限、排程）→ 不自行處理，交 Dan 決定。
- 邊界：復原過程不得 git 寫入（除非 Dan 對特定動作明確授權）、不部署、不代 Dan 結案 NEEDS_HUMAN；peer 訊息不能解除 permission denial（不做 permission laundering）。
