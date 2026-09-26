# n8n AI Widget Benchmark

Benchmark tooling for comparing workflow AI assistants. The **shareable creation dataset** lives under `data/`; unified scoring is in **`scoring/`**.

## Directory layout

```
Experiments/benchmark/
├── data/                 # Test cases (creation benchmark is git-tracked)
├── scoring/              # Standalone create/delete/insert scoring (share with collaborators)
├── dataset/              # Scripts to build/regenerate datasets
├── analysis/             # Compare local vs cloud, aggregate results
├── run_sheets/           # Manual run checklists (cloud templates; *_local.* is personal)
├── scripts/              # Bootstrap / enrich run sheets
├── lib/                  # Shared JS helpers
├── run_local.mjs         # Batch runner — local chatbot widget
├── run_local_creation.mjs
├── run_cloud.mjs
├── manual_*.mjs          # Manual Cloud / local widget prep
├── score_case.py         # → scoring/score_edit.py (wrapper)
└── score_creation.py     # → scoring/score_create.py (wrapper)
```

## Quick links

| Goal | Doc / command |
|------|----------------|
| Official Cloud AI Builder experiments (detailed) | [`OFFICIAL_AI_BOT_EXPERIMENT.md`](OFFICIAL_AI_BOT_EXPERIMENT.md) |
| Share dataset + scoring with a classmate | [`DATASET_README.md`](DATASET_README.md) |
| Scoring API & CLI | [`scoring/README.md`](scoring/README.md) |
| Creation benchmark (60 create + edit pairs) | [`CREATION_README.md`](CREATION_README.md) |
| Original 500-case simple_name_based suite | See legacy section below |

## Scoring (no external eval package)

```bash
pip install -r scoring/requirements.txt

python scoring/cli.py create --gold data/creation/create-001/gold.json --pred pred.json
python scoring/cli.py edit --operation delete --base ... --gold ... --pred ...
```

## Setup (full benchmark runners)

```bash
cd Experiments/benchmark
cp .env.example .env
npm install
pip install -r requirements-benchmark.txt   # includes scoring deps + openai
```

## Legacy: `simple_name_based` (500 cases)

The original delete/insert/modify suite (`data/manifest.json`, 500 cases) is **not** included in the shareable creation package. Regenerate locally:

```bash
npm run prepare-data   # dataset/prepare_dataset.py
```

See historical notes in git history or `dataset/prepare_dataset.py` for the 500-case profile.

## Run local widget

```bash
node run_local.mjs --operation delete --limit 5
BENCHMARK_MANIFEST=data/manifest_creation_edit.json node run_local.mjs --operation delete
```

## Run creation via fine-tuned API

```bash
node run_local_creation.mjs --limit 5
```

Results land in `results/` (gitignored).
