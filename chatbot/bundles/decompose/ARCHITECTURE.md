# v2 架構（節錄自 n8n-decompose-task/CLAUDE.md）

## 定位

`decompose_pipeline/decompose_v2.py` 較簡、可互動。單次 LLM 呼叫為主。每個 task 只輸出 `{ "operation", "description" }`，**沒有** `node_type` 與 `parameters`。設計上是要餵給四個下游客端 agent（各對應一種 operation 類型）。

## 流程

1. LLM 分解 query → `{"tasks": [...], "clarifications": [...]}`
2. 若 `clarifications` 非空，逐題印出問題並 **等待使用者輸入**（最多 2 題）
3. 若有補充答案，帶上「原始需求 + 問答」再呼叫 LLM 一次，得到最終 tasks
4. 回傳 `{"tasks": [{"operation": "...", "description": "..."}, ...]}`

## 釐清（clarification）原則

由 prompt 約束：僅在「缺了具體值、下游客端無法往下做」時才問（例如「改成其他服務」→ 要問是哪個服務）。可從 workflow 上下文推得的不問。

## 依賴

- OpenAI API（`OPENAI_API_KEY`）
- Python：`openai`、`python-dotenv`

v2 **不依賴** n8n node descriptions 目錄；v1 的 `DESCRIPTIONS_DIR` 僅在 `decompose.py` 使用。
