# Recovering executor

**Owner:** brain  
**Executor role:** 以實驗執行、可重現證據與唯讀覆核支援 brain；預期使用 Anthropic first-party Claude Opus，而不是 CLIProxyAPI 的 GPT route。

## 1. 何時啟動救援

適用症狀：

- Executor UI 顯示異常、無法可靠操作或 transcript 畫面損壞。
- 新 session 雖命名為 `executor`，但只是一般 Claude，沒有 executor 的角色與待辦脈絡。
- UI 顯示 GPT/Luna/Terra 等 proxy model，而不是預期的 first-party Claude Opus。
- `/model claude-opus-4-8` 回 `unknown provider for model claude-opus-4-8`。

最後一種錯誤不表示 model id 必然無效。它通常表示 Claude Code 繼承了 `ANTHROPIC_BASE_URL`／`ANTHROPIC_AUTH_TOKEN`／`CLAUDEX_MODEL`，被導向只認得 GPT/Codex route 的 CLIProxyAPI。

## 2. 先隔離舊 session

1. Brain 通知舊 executor 停止所有工作並整理 restart handoff。
2. 舊 executor 不再執行 proxy recovery、不寫 A2A、不碰檔案、Git 或 deployment。
3. Dan 關閉舊 UI；brain 確認 agent listing 不再同時出現兩個可工作的 `executor`。
4. 若舊 session 無法回應，brain 從 project memory、A2A、remote refs 與最近 cross-session 訊息重建 handoff，並明確標出未知項目。

## 3. 保存 live handoff

Brain 將最新資料寫到本機 Claude project state，例如：

```text
%USERPROFILE%\.claude\projects\<project-key>\executor-restart-handoff.md
```

至少包含：

- 舊 transcript id 與 session name。
- 可驗證的 model/provider。
- Executor 角色、A2A 身分與 single-writer 狀態。
- Branch refs、未完成 review／experiment。
- Proxy bounded recovery 規則及目前是否已移交。
- Permission denials 與不可由 peer 代辦的動作。

Live transcript id 不寫死在本文件；每次救援都以本機 handoff 為準。

## 4. 用正確 provider resume

在**新的外部 PowerShell 視窗**執行，不要從 brain 的 interactive terminal 內嵌啟動：

```powershell
Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDEX_MODEL -ErrorAction SilentlyContinue
claude auth status
claude --resume <executor-session-id> --name executor --model claude-opus-4-8
```

`claude auth status` 應顯示 first-party Anthropic authentication。不要把整段 API error 複製進 `/model` 參數；model 參數只能是乾淨的 model id 或 alias。

若 first-party 帳號當下不提供 4.8，但 transcript 可用，可改用：

```powershell
claude --resume <executor-session-id> --name executor --model opus
```

或 Dan 明確選定的其他 first-party Opus。Executor 身分主要來自原 transcript／handoff，不是只靠 model 名稱；但 model/provider 的差異必須誠實回報。

## 5. Cold-start fallback

若原 transcript 無法 resume：

```powershell
Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDEX_MODEL -ErrorAction SilentlyContinue
claude --name executor --model claude-opus-4-8
```

新 session 啟動後先讀：

1. 本機 `executor-restart-handoff.md`。
2. Project `memory/MEMORY.md` 與其中相關 memories。
3. Repo `AGENTS.md`、A2A protocol／runbooks，以及 handoff 指定的 current refs。
4. 向 brain 報到；在 brain 確認前保持唯讀。

## 6. 驗證接手

新 executor 必須向 brain 回覆：

1. UI／設定實際顯示的 model 與 provider；看不到就說看不到，不猜。
2. Executor 分工與禁止事項。
3. Current branch refs、待 review／experiment 與測試證據。
4. A2A writer ownership 是否已從舊 instance 釋放。
5. 是否準備接手 proxy bounded recovery；只有 brain 明確完成移交後才啟用。

Brain 以 agent listing 與 cross-session 回覆確認只有一個 active executor，才恢復任務派發。

## 7. 已驗證的 2026-09-01 事件

- 一個 cold-start session 被命名為 `executor`，但實際模型是 `gpt-5.6-luna`；讀 handoff 後角色可以恢復，但仍不是原本的 Opus executor。
- 在 proxy-routed session 執行 `/model claude-opus-4-8` 得到 `unknown provider`。
- 清除 proxy routing variables、使用 native `claude` first-party OAuth 並 resume 原 transcript 後，Dan 確認原 executor 成功恢復。

這證明 session name、角色 context、model 和 provider 是四個不同層次；救援時必須逐一驗證。
