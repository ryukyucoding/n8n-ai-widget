# n8n Decompose Task（v2 獨立包）

從 [n8n-decompose-task](../n8n-decompose-task) 抽出的 v2 版本：將自然語言 n8n workflow 需求拆解成 **純自然語言** 的 `tasks`（`create` / `modify` / `delete` / `insert`），不輸出 `node_type` 與參數；需要時可 **互動反問**（最多 2 題）再重跑 LLM。

## 環境

```bash
pip3 install -r requirements.txt
```

在**本目錄**建立 `.env`：

```
OPENAI_API_KEY=sk-...
```

## 執行

```bash
python3 decompose_pipeline/decompose_v2.py "我想把天氣來源改成其他服務，然後刪掉不需要的通知步驟"
```

若 query 有關鍵缺漏，腳本會暫停提問，你輸入補充後再輸出最終 `tasks` JSON。

## 輸出

```json
{
  "tasks": [
    { "operation": "create|modify|delete|insert", "description": "..." }
  ]
}
```

架構與釐清邏輯見 `ARCHITECTURE.md`。

## 與 v1 的差異

| 項目 | v1（同 repo 的 `decompose.py`） | v2（本包） |
|------|-----------------------------------|------------|
| 節點辨識 | 先從全節點目錄選相關 node | 不選節點 |
| 輸出 | 含 `node_type`、`parameters` 等 | 僅 `operation` + 自然語言 `description` |
| 測試 / eval | 有 `test_data`、`eval.py` 等 | 本包僅執行腳本，不含 v1 評測管線 |

本包內的 `decompose_pipeline/decompose_v2.py` 與 `n8n-decompose-task/decompose_v2.py` 一致。

## 本包檔案

見 `MANIFEST.txt`。
