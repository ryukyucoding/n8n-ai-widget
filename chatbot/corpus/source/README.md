# Easy-100 語料源檔（planner corpus 的原始輸入）

> ## ⚠️ 安全隔離中（2026-09-02）
>
> `testing_data_low_100.jsonl` 的 raw assistant-workflow payloads 含有待私有複核的 credential-like／個人聯絡資料候選。**在 Dan 明確解除隔離前，不得把它餵給 corpus builder、categorizer、模型、agent 或外部服務。** 不要複製或曝光 raw records，也不要自行 redaction、刪除或改寫歷史。完整政策見 `a2a/CORPUS_SECURITY_QUARANTINE.md`。

## 這是什麼

`testing_data_low_100.jsonl` —— 100 題低難度 workflow 需求描述，是
`chatbot/corpus/planner_corpus.json` 裡 `group: "easy100"` 那 100 題的**原始輸入**。

先前只有稽核「輸出」（語料 JSON）進了版控，這份「輸入」沒有，導致
語料無法從源頭重建。放進這裡就補上了重現性缺口。

## 出處（provenance）

- 來源：fine-tune 評測集 **S1（original description）變體**，
  原始路徑 `workflow_template/S1_ft_original_description/testing_data_low_100.jsonl`
  （fine-tune 專案，非本 repo；不受本 repo 版控）。
- 另有 S2（analysis prompt）與 S3（human prompt）兩個改寫變體**未**收錄，
  因為現行語料只用 S1 生成。要測不同語氣的穩健性時再另行加入並標明變體。
- 位元組與 S1 相同（sha256 前 16 碼 `d946078d5396bcc6`），CRLF 保留自原檔。
- 每行結構：`{ "id": <int>, "messages": [ {role, content}, ... ] }`，
  需求描述在 role=user 的 content。

## 如何從源頭重建語料

```bash
node chatbot/tools/buildPlannerCorpus.js \
  --easy100 chatbot/corpus/source/testing_data_low_100.jsonl \
  --output chatbot/corpus/planner_corpus.json
```

已驗證（2026-09-02，node v22）：用本源檔重生的語料，其 cases
（request / expectedOutcome / rationale）與已提交的 `planner_corpus.json`
**逐案一致**，僅 `generatedAt` 時間戳不同。

## 為什麼標記會隨時間改變（這是設計，不是 bug）

`easy100` 每題的預期結果由**能力稽核**推導：目前所有題都缺至少一項能力，
故全部標 `unsupported_capability`。編譯器能力擴充後重跑本工具，
先前「該拒絕」的題目會自動變成「該做到」。所以語料要能從源頭重生，
標記才不會凍結在某個時間點。
