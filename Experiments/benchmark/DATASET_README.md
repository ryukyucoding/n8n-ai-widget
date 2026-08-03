# Creation Benchmark

60 題 **create** + 60 題 **delete** + 60 題 **insert**。同學用自己的環境跑 model，用 **`scoring/`** 評分即可對齊你的數字。

## 需要 push 的檔案

```
Experiments/benchmark/
├── DATASET_README.md          # 本文件
├── data/
│   ├── manifest_creation.json
│   ├── manifest_creation_edit.json
│   ├── creation/              # 60 題
│   └── creation_edit/         # 60 delete + 60 insert
└── scoring/                   # 獨立評分套件（不需 n8n_workflow_generator_package）
    ├── README.md
    ├── cli.py
    ├── requirements.txt
    └── ...
```

## 資料結構

| 路徑 | 用途 |
|------|------|
| `data/creation/create-NNN/instruction.txt` | 給 model 的 create 指令 |
| `data/creation/create-NNN/prompt.json` | `{ system, user }` fine-tune 格式 |
| `data/creation/create-NNN/gold.json` | create 標準答案 |
| `data/creation_edit/delete/create-del-NNN/` | delete：`base.json`（刪前）、`gold.json`（刪後）、`instruction.txt` |
| `data/creation_edit/insert/create-ins-NNN/` | insert：`base.json`（刪後）、`gold.json`（還原）、`instruction.txt` |
| `manifest_*.json` | case 索引、complexity、路徑、insert 的 `oracle_clue` |

## 評分（統一標準）

```bash
cd Experiments/benchmark
pip install -r scoring/requirements.txt

# Create
python scoring/cli.py create \
  --gold data/creation/create-001/gold.json \
  --pred his_pred.json \
  --out score.json

# Delete
python scoring/cli.py edit --operation delete \
  --base data/creation_edit/delete/create-del-001/base.json \
  --gold data/creation_edit/delete/create-del-001/gold.json \
  --pred his_pred.json

# Insert — case entry 從 manifest_creation_edit.json 複製該 case 的 JSON
python scoring/cli.py edit --operation insert \
  --base data/creation_edit/insert/create-ins-001/base.json \
  --gold data/creation_edit/insert/create-ins-001/gold.json \
  --pred his_pred.json \
  --case-json case_entry.json
```

詳細指標說明見 [`scoring/README.md`](scoring/README.md)。

## 指標摘要

| 操作 | 主指標 |
|------|--------|
| create | Node F1、Connection F1、Matched Connection F1、Parameter Accuracy |
| delete | `delete_success` (0/1) |
| insert | `insert_success` (0/1) + tier（Perfect / Splice Error / …） |

## 同學的工作流程

1. Clone repo，讀取 `data/` 測試集
2. 用自己的 pipeline 對每題產生 `pred.json`（n8n workflow JSON）
3. 用 `scoring/cli.py` 對 gold 評分
4. 自行彙總分數（或寫小 script 批次跑 manifest 裡的 cases）

