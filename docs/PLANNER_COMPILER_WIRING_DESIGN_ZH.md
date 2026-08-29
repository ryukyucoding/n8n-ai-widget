# Planner 到 Compiler 的接線設計

## 目的

把「模型理解使用者需求」與「依真實 n8n schema 組裝 workflow」分開。Planner 只提出受限、可審閱的工作計畫；Compiler 只接受已核准的計畫，並以 runtime schema 與 Skill 產生 JSON。Planner 不得直接輸出 n8n JSON，Compiler 不得自行猜測使用者意圖。

## 一條完整資料流

1. 使用者描述需求。
2. Planner 產生 `Plan IR`：步驟、能力、資料流、缺少的設定，以及 credential 需求的名稱與用途。
3. UI 顯示計畫摘要；使用者可要求修正，直到按下核准。
4. 核准服務把 canonical `Plan IR` 與當前 `runtimeSchemaRevision` 雜湊成 `approvalFingerprint`。
5. Compiler 只接收 `approvedPlanId`，重新讀取同一份 canonical IR，選擇對應 Skill，產生 workflow JSON。
6. Canonicalizer、靜態驗證器與安全政策檢查 JSON。
7. 成功時才由唯一的 workflow-create adapter 呼叫 n8n API；失敗則回傳可理解的分類，不把不安全 JSON 送到 n8n。
8. UI 回傳 workflow 連結、執行狀態與尚待使用者補齊的 credential/configuration。

## Plan IR 最小欄位

```json
{
  "planId": "uuid",
  "planVersion": 1,
  "goal": "使用者可閱讀的目標",
  "steps": [
    {
      "id": "fetch-feed",
      "capability": "rss.read_public_feed",
      "inputs": [],
      "outputs": [{ "name": "entries", "cardinality": "items" }],
      "configuration": { "feedUrl": "https://example.org/feed.xml" },
      "credentialRequirements": []
    }
  ],
  "requiredUserInputs": [],
  "requiredConfiguration": [],
  "credentialRequirements": [],
  "expectedOutput": { "deliveryShape": "one_object", "fields": ["markdown"] }
}
```

`steps` 的 capability 必須在 Skill Registry 中存在；資料引用必須指向前一個已宣告 output。IR 不含 n8n node type、typeVersion、raw parameters、credential secret 或 workflow JSON。

## 核准與版本綁定

核准時儲存：

```text
approvalFingerprint = SHA-256(canonical Plan IR + runtimeSchemaRevision)
```

Compiler 每次建立前重新取得 runtime schema revision。只要 IR 或 schema digest 改變，舊核准就失效，必須重新讓使用者確認。這避免使用者核准 A 計畫、系統卻在 schema 更新後建立 B workflow。

## Credential 與敏感資訊邊界

- Planner 只能看到「需要 Google Drive upload credential」等需求，不看 token、client secret、email password 或使用者個資。
- UI 直接寫入 n8n Credentials 或安全的 server-side binding store；其回傳給計畫的只有 `credentialBindingId` 或 `missing` 狀態。
- 若 credential 已存在，Compiler 綁定它。
- 若不存在，Compiler 仍建立可見但 inactive 的 workflow，並回傳精確 setup 清單，例如「建立 Google Drive OAuth2 credential、選取目標資料夾」。
- 缺 credential 不可被誤報為 JSON 或 compiler 成功後的可執行成功。

## Compiler / Skill 邊界

每個 Skill 是一個受限編譯器，而非自由提示詞：

```text
capability + typed IR step + runtime schema card
  -> deterministic n8n node fragment + declared ports/data contract
```

初期每個 Skill 只支援明確能力，例如 `http.public_get`、`rss.read_public_feed`、`data.todo_summary`、`email.draft`。不支援時 Planner 明確回覆 capability gap，不要求模型臨時捏造 node JSON。

## 統一錯誤分流

| 結果 | 系統行為 |
| --- | --- |
| 使用者資訊不足 | 回到 plan review，詢問具體欄位 |
| Credential 缺少 | 建立 inactive workflow，顯示 setup 清單 |
| Skill 不存在或語意不支援 | 說明 capability gap，不建立 workflow |
| schema / port / parameter 錯誤 | 阻擋 create，交給 Compiler/Skill 維護，不叫使用者修 JSON |
| URL / capability 違反安全政策 | 拒絕並說明被拒絕的原因 |
| 靜態驗證通過 | 允許唯一 create adapter 建立 workflow |
| n8n 執行失敗 | 保留 execution evidence，分類為 runtime failure；不得冒稱成功 |

## 需要實作的四個邊界

1. `PlannerSessionStore`：保存 IR、對話修訂、plan version 與 review 狀態。
2. `ApprovalService`：canonicalize IR、綁定 runtime revision、簽發 approval fingerprint。
3. `CompilerGateway`：驗證核准後，依 capability dispatch 到 Skill，執行 static verifier。
4. `WorkflowCreateAdapter`：唯一可呼叫 n8n create API 的入口；只接受已驗證 workflow 與 approval fingerprint。

這四個邊界完成後，Fine-tuned Create、外部強模型 Planner 與本地 Planner 都能替換，而 workflow 組裝、安全檢查與 credential 邊界不會跟著漂移。
