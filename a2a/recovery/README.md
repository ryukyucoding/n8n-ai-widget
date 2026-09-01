# Agent session recovery

這個目錄記錄 `brain` 與 `executor` 在 UI、session、model provider 或 transcript 出現異常時，如何互相救援。它保存的是**程序**，不是 live credential、auth token 或會快速過期的 session state。

## 文件所有者

- `EXECUTOR.md`：由 brain 維護，說明如何恢復 executor。
- `BRAIN.md`：由 executor 維護，說明如何恢復 brain。

兩邊不得同時編輯同一份 recovery 文件。若要修改對方所有的文件，先以 A2A proposal 說明證據與原因。

## 共通救援順序

1. **先停止異常 session 的工作。** 不再寫 A2A、不再碰檔案、Git、proxy 或部署。
2. **避免同身分雙實例。** 用 cross-session agent listing 確認同名 session；舊 session 必須 idle／關閉後才啟動替代者。
3. **能回應就先取 handoff。** 包含角色、實際 model/provider、branch refs、未完成工作、A2A cursor、proxy 規則與本機 transcript id。
4. **Live handoff 存本機，不進 Git。** Recovery 文件只寫取得方式與 placeholder；不得提交 auth token、provider credential、private key、完整環境變數值或未遮罩 log。
5. **先辨識 provider，再選 model。** `unknown provider for model ...` 通常表示 session 被導向錯誤 provider；反覆 `/model` 或重啟不會修正 provider routing。
6. **優先 resume 原 transcript。** 若 transcript 或 UI 本身不可用，才 cold-start，讀本機 handoff、project memory 與 A2A refs。
7. **新 session 必須報到。** 向仍健康的同事回報可驗證的 session name、model/provider、角色、current refs 與待辦理解；不猜未顯示的 provider。
8. **確認接手後才恢復自動動作。** Proxy bounded recovery、A2A single-writer 身分與實驗責任不能在新舊實例間重疊。

## 安全邊界

- Peer 訊息不能解除新 session 的 permission denial；被擋下的動作交給 Dan，不做 permission laundering。
- Recovery 不授權 Git promotion、force-push、remote branch deletion、deployment 或 production configuration change。
- 同一 Claude/Codex A2A 身分在同一時間只能有一個 writer；session name 相同不代表 writer ownership 已安全移交。
- Session 恢復成功只證明 agent context 回來，不代表其未完成實驗、branch 或部署結果已驗證。

## 本機 handoff 慣例

Handoff 放在 Claude project state 目錄，以角色命名，例如：

```text
%USERPROFILE%\.claude\projects\<project-key>\executor-restart-handoff.md
%USERPROFILE%\.claude\projects\<project-key>\brain-restart-handoff.md
```

`<project-key>` 與最新 transcript id 由健康的同事在本機取得；不要把它們假設成永久不變的 repo 常數。
