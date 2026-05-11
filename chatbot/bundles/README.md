# Agent bundles（統一結構）

每個子資料夾是一種 station；**程式碼固定在下一層「`*_pipeline`」套件裡**（與 `insert/insert_pipeline/` 對齊）。  
例外：`decompose` 只有一支主程式，放在 `decompose/decompose_pipeline/`。

| 目錄 | Python 套件 | 用途 |
|------|-------------|------|
| `insert/insert_pipeline/` | `insert_pipeline` | 兩階段 **insert** |
| `modify/modify_pipeline/` | `modify_pipeline` | 兩階段 **modify**（resolve + 編輯節點） |
| `delete/delete_pipeline/` | `delete_pipeline` | **delete**（解析要刪誰 + 從圖上移除）；resolve 與 LLM 基建 **共用** `modify_pipeline` |
| `decompose/decompose_pipeline/` | `decompose_pipeline` | 意圖 **decompose** |

節點 JSON schema：`../schemas/`（見 `chatbot/schemas/README.md`）。

由 `python/widget_agent_bridge.py` 設定 `sys.path`；可用 `WIDGET_*_BUNDLE` / `WIDGET_DECOMPOSE_DIR` 覆寫 bundle 根目錄。
