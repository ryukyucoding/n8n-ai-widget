# Creation benchmark (from-scratch)

Compare **local widget** vs **Cloud AI Builder** on greenfield workflow generation.

> **Sharing:** Pre-built dataset in `data/creation/` + `data/creation_edit/`. Collaborators only need `data/` + `scoring/` — see **`DATASET_README.md`**.

## Data source

60 cases — **20 low + 20 med + 20 high** from S1 original-description JSONL.

Regenerate locally (optional):

```bash
python3 dataset/prepare_creation_dataset.py
python3 dataset/prepare_creation_edit_dataset.py
```

Outputs:
- `data/creation/create-NNN/` — `gold.json`, `instruction.txt`, `prompt.json`, empty `base.json`
- `data/manifest_creation.json`
- `data/creation_edit/` — paired delete + insert
- `data/manifest_creation_edit.json`

## Metrics (per case)

| Metric | Description |
|--------|-------------|
| **Node F1** | Bipartite type matching (sticky notes excluded) |
| **Connection F1** | `(from_type, to_type)` edge multiset F1 |
| **Matched Connection F1** | Connection F1 on matched node pairs only |
| **Parameter Accuracy** | Cosine sim of serialized params (threshold 0.8) |

Scoring: `python scoring/cli.py create ...` — see [`scoring/README.md`](scoring/README.md).

```bash
pip install -r scoring/requirements.txt
```

## Cloud manual run

```bash
node manual_creation_cloud.mjs prepare --limit 60 --force
# Open run_sheets/creation_run_sheet.md
node manual_creation_cloud.mjs fetch --force
node manual_creation_cloud.mjs summary
```

## Local creation-edit (delete / insert)

```bash
node manual_creation_edit_local.mjs prepare all
# Run sheets: run_sheets/creation_*_run_sheet_local.md

BENCHMARK_MANIFEST=data/manifest_creation_edit.json node run_local.mjs --operation delete
```

## Local create (fine-tuned API)

```bash
# Baseline (S1 prompt from prompt.json)
node run_local_creation.mjs --limit 5

# Prompt ablation profiles: s1 | connection | semantic | rich
node run_local_creation.mjs --prompt-profile semantic --limit 5 --force
# Non-s1 profiles write to results/local/create-{profile}/

# Remap connection keys + re-score existing preds (no re-inference)
node rescore_creation.mjs --force
node rescore_creation.mjs --results-dir results/local/create --case-id create-002 --force
```
