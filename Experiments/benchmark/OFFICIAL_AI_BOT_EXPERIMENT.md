# 與 n8n 官方 Cloud AI Builder 對照實驗 — 完整說明

本文件說明本專案如何設計、執行、評分，並與 **n8n 官方 Cloud 上的 AI Workflow Builder（以下簡稱 Official / 官方 AI Bot）** 做公平對照。內容涵蓋資料集、操作流程、環境變數、結果目錄、指標定義，以及與 **Our system（本地 chatbot pipeline）**、**GPT-4.1 one-shot 基線** 的關係。

> 相關入口：[`DATASET_README.md`](DATASET_README.md)（資料與評分給協作者）、[`CREATION_README.md`](CREATION_README.md)（create 子集）、[`scoring/README.md`](scoring/README.md)（指標 API）。

---

## 1. 實驗目的

| 研究問題 | 對照方式 |
|----------|----------|
| 從零建立 workflow（**Creation**）誰的結構與參數更接近 gold？ | 同一 `instruction.txt`，Official 在 Cloud 空畫布 vs 本地 FT / staged / one-shot |
| 在既有 workflow 上 **刪除** 一個節點（**Delete**）誰做對？ | 同一 `base.json` + 刪除指令，Official 在 Cloud vs 本地 agent |
| 在刪除後畫布上 **插入** 節點（**Insert**）誰做對？ | 同一 `base.json` + 插入指令（名稱 + type + between，**不含參數填寫要求**），Official vs 本地 agent |

**核心原則：**

1. **同一題、同一輸入**：Official 與 Our system 使用相同的 `instruction.txt`（或 manifest 內等價文字）。
2. **同一評分器**：所有 `pred.json` 皆由 `Experiments/benchmark/scoring/`（或根目錄 wrapper `score_case.py` / `score_creation.py`）評分，避免各系統自訂 metric。
3. **Gold 不洩漏給模型**：評分用 `gold.json`；送給 AI 的只有 instruction（與當前 canvas 上的 workflow，edit 任務）。

---

## 2. 測試集總覽

### 2.1 Creation（60 題）

- **來源**：S1 original-description，**20 low + 20 med + 20 high**（`create-001` … `create-060`）。
- **路徑**：`data/creation/create-NNN/`
  - `instruction.txt`：給使用者的自然語言需求（Cloud 上整段貼進 AI Builder）。
  - `prompt.json`：`{ system, user }`，供 fine-tune / one-shot 本地實驗。
  - `gold.json`：標準答案 workflow JSON。
  - `base.json`：create 任務為空或占位；評分時以 gold 為準。
- **索引**：`data/manifest_creation.json`

### 2.2 Creation-edit 配對（60 Delete + 60 Insert）

由 60 個 creation gold **自動衍生**（`dataset/prepare_creation_edit_dataset.py`，seed=42）：

| 任務 | Case ID | Canvas（base） | Gold | 指令風格 |
|------|---------|----------------|------|----------|
| **Delete** | `create-del-NNN` | 已刪除目標節點後的 workflow | 刪除**前**的完整 gold（oracle 連線） | 僅節點名：`Delete the node "Wait".` |
| **Insert** | `create-ins-NNN` | 與 delete 的 base 相同（缺那一節點） | 與 create 原始 gold 相同（還原後） | 名稱 + type + between，**不要求填參數**：`Insert the node "Wait" of type "n8n-nodes-base.wait" between "A" and "B".` |

- **路徑**：`data/creation_edit/delete|insert/<case-id>/` → `base.json`, `gold.json`, `instruction.txt`
- **索引**：`data/manifest_creation_edit.json`（含 `delete_cases`, `insert_cases`, 合併的 `cases`）
- **Oracle**：insert case 的 manifest 條目含 `oracle_clue`（目標節點 type、between 錨點等），供評分與除錯，**不送給 Official**。

### 2.3 複雜度分層

每題標 `complexity`: `low` | `med` | `high`（functional node 數量與圖結構）。論文或報告可報 **整體 N=30/60** 或 **分層** 結果。

---

## 3. 三方系統定義

| 名稱 | 是什麼 | 怎麼跑 | 結果目錄（典型） |
|------|--------|--------|------------------|
| **Official（n8n AI Bot）** | n8n Cloud 實例上的 **AI Workflow Builder**（UI 對話編輯） | **手動**依 run sheet 貼指令 + Save；再以 API **fetch** workflow | `results/cloud/create/`、`results/cloud/create-del/`、`results/cloud/create-ins/` |
| **Our system** | 本 repo **chatbot widget + pipeline**（insert/delete/modify 等 bundle） | `run_local.mjs` 匯入 base → POST `CHAT_AGENT_URL` → 等 persist → 評分 | `results/local/create-ins/`、`create-del/` 或 `create-ins-{tag}/`（如 `gpt41`） |
| **GPT-4.1 one-shot（基線）** | 單次 LLM：整份 base JSON + instruction → 整份 pred JSON | `run_local_creation_edit.mjs` | `results/local/create-ins-gpt41-oneshot/`、`create-del-gpt41-oneshot/` |
| **Creation one-shot / FT** | 從零生成整 workflow | `run_local_creation.mjs` | `results/local/create-gpt41-semantic/` 等 |

Official **不是** OpenAI API 直接呼叫，而是 **n8n 產品內建 Builder**（模型與 prompt 由 n8n 控制，實驗中視為黑盒）。

---

## 4. 環境與憑證

設定檔：`Experiments/benchmark/.env`（模板见 `.env.example`）。

### 4.1 Cloud / Official

| 變數 | 用途 |
|------|------|
| `N8N_CLOUD_URL` | Cloud 實例根 URL（例如 `https://widmn8n.app.n8n.cloud`） |
| `N8N_CLOUD_API_KEY` | REST API：prepare 時 **匯入 base**、fetch 時 **GET workflow** |
| `N8N_CLOUD_EMAIL` / `N8N_CLOUD_PASSWORD` | Playwright 自動化（`run_cloud.mjs`）登入用 |
| `PLAYWRIGHT_STORAGE_STATE` | `npm run auth:cloud` 後的 session |
| `PERSIST_TIMEOUT_MS` | 等 AI 改動寫回後端的最長時間（本地 agent 用） |
| `BENCHMARK_SKIP_SETUP=1` | 自動略過 Builder 完成後的 credential / Execute 精靈（避免卡 5 分鐘） |

### 4.2 本地 Our system

| 變數 | 用途 |
|------|------|
| `N8N_BASE_URL` / `N8N_API_KEY` | 本地 n8n API |
| `CHAT_AGENT_URL` | Chatbot agent（預設 `http://localhost:3001/agent/run`） |
| `BENCHMARK_MANIFEST` | 例如 `data/manifest_creation_edit.json` |
| `BENCHMARK_RESULTS_TAG` | 結果子目錄 tag（如 `gpt41` → `create-ins-gpt41/`） |
| `OPENAI_MODEL` | 本地 agent / one-shot 使用的模型 |

### 4.3 Python 評分

```bash
cd Experiments/benchmark
pip install -r scoring/requirements.txt
# 或 pip install -r requirements-benchmark.txt
```

---

## 5. Official 實驗標準流程（手動，建議論文主流程）

手動流程可 **100% 對齊真實使用者**：開 workflow → 開 AI Builder → 貼文字 → 等完成 → **Save**。自動化 Playwright（`run_cloud.mjs`）可選，但 UI 變更時較 fragile。

### 5.1 Creation（從零 60 題）

```bash
cd Experiments/benchmark
node manual_creation_cloud.mjs prepare --limit 60 --force
```

1. 開啟 `run_sheets/creation_run_sheet.md`（或 `.json`）。
2. 對每一列：
   - 開 **Workflow URL**（prepare 會在 Cloud 建立**空 workflow**）。
   - 開 **AI Builder**。
   - 貼 **Instruction**（與 `data/creation/<case>/instruction.txt` 一致）。
   - 等生成結束，**Save** workflow。
3. 全部完成後：

```bash
node manual_creation_cloud.mjs fetch --force
node manual_creation_cloud.mjs summary
```

- **輸出**：`results/cloud/create/create-NNN/pred.json`, `score.json`, `meta.json`
- **指標**：Node F1、Connection F1、Matched Connection F1、Parameter Accuracy（見第 7 節）

### 5.2 Creation-edit — Delete（60 題）

```bash
node manual_creation_edit_cloud.mjs prepare delete --force
# 或 prepare all
```

1. 開 `run_sheets/creation_delete_run_sheet_cloud.md`。
2. 每題 workflow 已是該 case 的 **`base.json`**（刪除後狀態）。
3. AI Builder 貼 **刪除指令**（僅節點名），Save。
4. Fetch：

```bash
node manual_creation_edit_cloud.mjs fetch delete --force
# 部分題目： --offset 30 --limit 19 --force
```

- **輸出**：`results/cloud/create-del/create-del-NNN/`

### 5.3 Creation-edit — Insert（60 題）

```bash
node manual_creation_edit_cloud.mjs prepare insert --force
```

1. 開 `run_sheets/creation_insert_run_sheet_cloud.md`。
2. Canvas = insert 的 **base**（少一個節點）。
3. 貼 **Insert … of type … between …** 指令（**不含**「Set parameters to …」）。
4. Save 後：

```bash
node manual_creation_edit_cloud.mjs fetch insert --force
```

- **輸出**：`results/cloud/create-ins/create-ins-NNN/`
- **meta.json** 常見欄位：
  - `preparedAt`：匯入 base 時間（UTC）
  - `fetchedAt`：拉 pred 並評分時間
  - `workflowChangedFromBase`：signature 是否與 base 不同
  - `instructionSent`：實際指令副本

### 5.4 Prepare / Fetch 腳本在做什麼

**Prepare（`manual_creation_edit_cloud.mjs` / `manual_creation_cloud.mjs`）：**

- 讀 manifest → 讀 `base.json`（create 則空 workflow）
- `stripWorkflowForImport` → Cloud API `createWorkflow`
- 寫 `results/cloud/.../<case>/meta.json`（`workflowId`, `workflowUrl`）
- 更新 run sheet（Markdown + JSON）

**Fetch：**

- `getWorkflow(workflowId)` 得到 Builder 修改後的 JSON → `pred.json`
- 呼叫 `score_case.py`（insert/delete）或 `score_creation.py`（create）→ `score.json`
- 更新 sheet 的 `success`, `metrics`, `fetchedAt`

### 5.5 操作檢查清單（避免無效 run）

- [ ] 每題有 **Save**（未 Save 的 fetch 可能仍是 base）
- [ ] Instruction **只貼文字**，不要多貼 oracle 或 gold
- [ ] Insert 題目不要用「partial insert」那種含參數的 legacy 指令（creation_edit 集已固定格式）
- [ ] Fetch 前確認 `meta.json` 有 `workflowId`
- [ ] 若 workflow 與 base 完全相同，fetch 會標 `unchanged`，通常 `success=false`

### 5.6 Playwright 自動 Cloud（可選）

```bash
npm run auth:cloud
node run_cloud.mjs --operation delete --limit 3
```

- 使用已登入 session 操作 AI Builder UI。
- 適合大量重跑；**論文若強調「真實使用者」可仍以手動為主**，自動化寫入方法章節附錄。

---

## 6. Our system 本地對照流程

### 6.1 Creation-edit（與 Official 同 manifest）

```bash
# 可選：生成本地 run sheet + 匯入 base
node manual_creation_edit_local.mjs prepare all

# Pipeline 批次（需 n8n + chatbot 運行）
BENCHMARK_MANIFEST=data/manifest_creation_edit.json \
BENCHMARK_RESULTS_TAG=gpt41 \
OPENAI_MODEL=gpt-4.1 \
node run_local.mjs --operation insert --limit 30

BENCHMARK_MANIFEST=data/manifest_creation_edit.json \
node run_local.mjs --operation delete --limit 30
```

流程：API 建立 workflow（base）→ agent 收 instruction → 等 persist → 寫 `pred.json` → 評分 → 預設刪除 workflow（`BENCHMARK_KEEP_WORKFLOW=1` 可保留）。

### 6.2 Creation one-shot / staged

見 [`CREATION_README.md`](CREATION_README.md)：`run_local_creation.mjs`（`--mode oneshot` 或 `staged`）。

### 6.3 Creation-edit GPT-4.1 one-shot 基線

不走 pipeline，單次輸出整份 JSON：

```bash
OPENAI_MODEL=gpt-4.1 node run_local_creation_edit.mjs --operation insert --limit 30
OPENAI_MODEL=gpt-4.1 node run_local_creation_edit.mjs --operation delete --limit 30
```

- 腳本：`run_local_creation_edit.mjs`
- 結果：`results/local/create-ins-gpt41-oneshot/`、`create-del-gpt41-oneshot/`

---

## 7. 評分標準（與論文 Table 對齊）

所有系統共用 **`scoring/`**。Case 級輸出為 `score.json`；聚合時對 binary metric 取平均（即成功率）。

### 7.1 Creation

| 指標 | 說明 |
|------|------|
| **Node F1** | 依 node type 二分匹配（通常排除 sticky note） |
| **Connection F1** | 邊 `(from_type, to_type)` 多重集 F1 |
| **Matched Connection F1** | 僅在已匹配節點對上的連線 F1 |
| **Parameter Accuracy** | 序列化 parameters 的 cosine 相似度，≥0.8 視為匹配（需 `sentence-transformers`） |

### 7.2 Delete

主指標：**`metrics.delete_success`**（0/1，case 級 `success` 同義）

分量（可報表平均）：

- `delete_targets_removed` — 目標節點已移除
- `delete_only_intended_removed` — 沒有多刪
- `delete_survivors_match_oracle` — 其餘節點語意/結構與 oracle 一致
- `delete_connections_match_oracle` — 主路徑連線與 gold 刪除後一致
- `delete_no_extra_raw_nodes` — 無多餘節點

### 7.3 Insert（論文 Table 7 常用列）

主指標：**`metrics.insert_success`**（strict success，0/1）

| 報表名稱 | score.json 欄位 |
|----------|-----------------|
| insert_success | `success` 或 `metrics.insert_success` |
| Position OK | `metrics.insert_position_ok` / splice 相關 |
| Type OK | `metrics.insert_type_ok` |
| Mean parameter coverage | 各 case `metrics.insert_param_coverage_rate` 的平均 |
| Survivors match oracle | `metrics.insert_survivors_match_oracle` |
| No extra raw nodes | `metrics.insert_no_extra_raw_nodes` |

**分級標籤**（除錯用）：`insert_status_label` → Perfect / Splice Error / Insert Type Mismatch / **Ambiguous**（常見原因：`parameters_incomplete`、`other_nodes_modified` 等，見 `score.json` → `insert_detail`）。

**重要**：creation_edit insert 指令**不要求**填參數，但 strict `insert_success` 仍會檢查 pred 節點 parameters 是否覆蓋 gold 子集；Official 常因參數不全而 **Ambiguous** 但 position/type 已對。

### 7.4 單題手動評分

```bash
python scoring/cli.py edit --operation insert \
  --base data/creation_edit/insert/create-ins-001/base.json \
  --gold data/creation_edit/insert/create-ins-001/gold.json \
  --pred path/to/pred.json \
  --case-json path/to/case_entry_from_manifest.json \
  --out score.json
```

---

## 8. 結果目錄結構

```
Experiments/benchmark/results/
├── cloud/                          # Official
│   ├── create/create-NNN/
│   ├── create-del/create-del-NNN/
│   └── create-ins/create-ins-NNN/
└── local/                          # Our system & baselines
    ├── create/ / create-gpt41-semantic/ / create-staged-*/
    ├── create-ins/ / create-ins-gpt41/ / create-ins-gpt41-oneshot/
    └── create-del/ / create-del-gpt41/ / create-del-gpt41-oneshot/
```

每 case 典型檔案：

| 檔案 | 內容 |
|------|------|
| `pred.json` | 模型/Builder 輸出的 workflow |
| `score.json` | `success`, `metrics`, insert/delete 詳情 |
| `meta.json` | 時間戳、workflowId、instruction、錯誤、Official 的 `workflowChangedFromBase` |
| `raw.txt` | one-shot LLM 原始輸出（若有） |

`results/` 預設 **gitignore**；論文應另存聚合 JSON 或表格。

---

## 9. 彙總與比較腳本

| 目的 | 命令 / 腳本 |
|------|-------------|
| Insert：本地 vs Cloud | `python analysis/compare_creation_edit_insert_local_cloud.py --cases create-ins-001:create-ins-030` |
| Delete：本地 vs Cloud | `python analysis/compare_creation_edit_delete_local_cloud.py`（注意本地路徑可能為 `create-del-{tag}`，需改腳本或 symlink） |
| Creation 三方 | `python analysis/compare_creation_three_way.py` |
| Cloud creation 摘要 | `node manual_creation_cloud.mjs summary` |
| 自訂聚合 | 對 `score.json` 讀 `success` 與 `metrics.*` 取平均（N=30 時與論文 Table 一致） |

**Compare 腳本預設路徑**：insert 的 local 預設 `results/local/create-ins/`；若跑在 `create-ins-gpt41/`，請加參數或暫時複製/symlink，或在 Python 中改 `load_case` 的 base path。

---

## 10. 實驗設計與已知限制

### 10.1 公平性

- **相同 canvas 起點**：Official prepare 與 local `run_local.mjs` 皆從同一 `base.json` 匯入。
- **相同指令**：run sheet 與 `instruction.txt` 一致。
- **相同評分**：同一 `gold.json` 與 oracle。

### 10.2 無法完全控制的變因

| 變因 | 說明 |
|------|------|
| **n8n Cloud 版本** | Official 行為隨 Cloud 升級變化；`meta.json` 目前**未必**記錄 `versionCli`，需實驗當下另查 `/rest/settings` 或記錄日期 |
| **執行時間** | 不同批次 fetch（例如 001–030 vs 031–049）可能跨多個 n8n 版本；比較時宜註明 `preparedAt` / `fetchedAt` |
| **手動操作** | 疲勞、漏 Save、貼錯指令；run sheet 的 `[ ]` 欄位應勾選追蹤 |
| **Credential 精靈** | Builder 完成後可能彈 setup；Playwright 用 `BENCHMARK_SKIP_SETUP`，手動實驗需自行 Skip |
| **Insert 參數** | 指令不要求參數，但 strict success 仍檢查參數覆蓋 → Official 的「Mean parameter coverage」可能與 position/type 脫鉤 |

### 10.3 Official 與 Pipeline 能力差異（解讀結果時）

- Official：黑盒 Builder，可能一次改多處、或只改局部。
- Our pipeline：分階段 resolve → insert/delete/modify bundle，**survivors match** 通常較嚴。
- One-shot：整圖重寫，delete 可能意外改動他處；insert 常 **type/position 對但參數弱**。

---

## 11. 論文表格範例（Insert N=30）

對 `create-ins-001` … `create-ins-030` 的 Cloud `score.json` 聚合：

1. `insert_success` → strict 成功率  
2. `insert_position_ok`, `insert_type_ok` → 分量平均  
3. `insert_param_coverage_rate` → **Mean parameter coverage**  
4. `insert_survivors_match_oracle`, `insert_no_extra_raw_nodes`

Delete N=30 同理，主列 **delete_success** + 第 7.2 節分量。

Creation 報 Node F1 / Param Acc 等（見第 7.1 節）。

---

## 12. 常見問題

**Q: prepare 後只有 meta.json，沒有 pred/score？**  
A: 正常。需在 Cloud 完成 Builder + Save 後再 `fetch`。

**Q: fetch 顯示 unchanged？**  
A: workflow 與 base 相同，通常未 Save 或 Builder 未改圖。

**Q: 如何只重跑評分？**  
A: 保留 `pred.json`，刪 `score.json` 後再 fetch（`--force`）或手動跑 `scoring/cli.py`。

**Q: 本地 agent 與 Official 指令要不要加 location？**  
A: creation_edit 指令已含 between；legacy `run_local.mjs --include-location` 用於舊 500 題集，creation_edit 通常不需要。

**Q: 031–060 官方還沒跑完？**  
A: 可 `prepare` + 手動 + `fetch insert --offset 30 --limit 19`；合併報告時註明 N。

---

## 13. 指令速查

```bash
cd Experiments/benchmark

# --- Official Cloud ---
node manual_creation_cloud.mjs prepare --limit 60 --force
node manual_creation_cloud.mjs fetch --force

node manual_creation_edit_cloud.mjs prepare all --force
# …手動 AI Builder…
node manual_creation_edit_cloud.mjs fetch all --force

# --- Our pipeline ---
BENCHMARK_MANIFEST=data/manifest_creation_edit.json node run_local.mjs --operation insert --limit 30

# --- GPT-4.1 edit one-shot ---
OPENAI_MODEL=gpt-4.1 node run_local_creation_edit.mjs --operation insert --limit 30
OPENAI_MODEL=gpt-4.1 node run_local_creation_edit.mjs --operation delete --limit 30

# --- 比較 ---
python analysis/compare_creation_edit_insert_local_cloud.py --cases create-ins-001:create-ins-030
```

---

## 14. 文件維護

- 新增 runner 或結果目錄命名時，請更新 **第 3、8、9 節**。
- 若 scoring 邏輯變更，以 `scoring/README.md` 與 `scoring/score_edit.py` 為準，並同步本文件 **第 7 節**。
- Run sheet 標題與 case 數由 `lib/creation_edit_run_sheet.mjs` 產生；Cloud URL 以 `.env` 的 `N8N_CLOUD_URL` 為準。

如有新批次 Official 實驗，建議在 repo 外或 `results/` 下保留一份 **實驗日誌**：日期、Cloud 版本、操作者、N、是否手動/Playwright，以便論文 replication。
