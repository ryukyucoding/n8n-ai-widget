# Creation Benchmark Scoring

Standalone scoring for **create / delete / insert** — no `n8n_workflow_generator_package` required.

## Install

```bash
cd Experiments/benchmark
pip install -r scoring/requirements.txt
```

Create **Parameter Accuracy** needs `sentence-transformers` (first run downloads the embedding model).

## CLI

```bash
# Create — Node F1, Connection F1, Matched Connection F1, Parameter Accuracy
python scoring/cli.py create --gold data/creation/create-001/gold.json --pred YOUR_PRED.json

# Skip embedding model (structure metrics only)
python scoring/cli.py create --gold ... --pred ... --skip-parameter-eval

# Delete
python scoring/cli.py edit --operation delete \
  --base data/creation_edit/delete/create-del-001/base.json \
  --gold data/creation_edit/delete/create-del-001/gold.json \
  --pred YOUR_PRED.json

# Insert (pass manifest case entry for oracle_clue, or minimal JSON with inserted_node_name)
python scoring/cli.py edit --operation insert \
  --base data/creation_edit/insert/create-ins-001/base.json \
  --gold data/creation_edit/insert/create-ins-001/gold.json \
  --pred YOUR_PRED.json \
  --case-json path/to/case_entry.json
```

Write JSON output: add `--out score.json`.

## Metrics

| Task | Primary | Notes |
|------|---------|-------|
| **create** | `summary.node_f1`, `connection_f1`, `matched_connection_f1`, `parameter_accuracy` | Bipartite type matching; param sim via cosine ≥ 0.8 |
| **delete** | `metrics.delete_success` | 0/1 — target removed, no extras, survivors + connections match oracle |
| **insert** | `metrics.insert_success` | 0/1 — name, type, splice, params, graph integrity |

Insert also reports tier: `insert_status_label` → Perfect / Splice Error / Insert Type Mismatch / Ambiguous.

## Python API

```python
import sys
from pathlib import Path
sys.path.insert(0, "Experiments/benchmark")

from scoring.score_create import evaluate_creation
from scoring.score_edit import score_case

# create
result = evaluate_creation(gold_wf_dict, pred_wf_dict)

# delete
result = score_case(operation="delete", base=base, gold=gold, pred=pred)

# insert — case entry from manifest_creation_edit.json
result = score_case(operation="insert", base=base, gold=gold, pred=pred, case=case_entry)
```

## Layout

```
scoring/
├── cli.py                 # unified entry
├── score_create.py        # creation metrics
├── score_edit.py          # delete / insert / modify
├── evaluation/            # vendored evaluators (WorkflowNormalizer, etc.)
└── insert/                # insert-specific helpers
```

Backward-compatible wrappers at benchmark root: `score_creation.py`, `score_case.py`.
