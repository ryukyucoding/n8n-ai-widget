# GPT-OSS 120B edit benchmark results

## Test setup

- **Model:** `gpt-oss:120b` served by Ollama at `140.115.54.62`.
- **Tasks:** the first 30 cases of each Delete and Insert benchmark split.
- **Execution path:** the benchmark invokes the deployed `widget_agent_bridge.py` in
  the `n8n-chatbot-1` container. It records predicted workflow JSON only; it does
  not save or modify a workflow in n8n.
- **Scoring:** local benchmark scoring scripts in `Experiments/benchmark/scoring`.

The complete per-case raw outputs are versioned in `results/gpt-oss-120b/`, including
each prediction (`pred.json`), execution record (`run.json`), and generated score
summary. The commands used to reproduce this run are `run_delete_container.py`, `score_delete_batch.py`,
`run_insert_container.py`, and `score_insert_batch.py`.

## Results tables

### Delete

| Metric | GPT-OSS 120B |
| --- | ---: |
| `delete_success` | 100.0% |
| Targets removed | 100.0% |
| Only intended removed | 100.0% |
| Survivors match oracle | 100.0% |
| Connections match oracle | 100.0% |
| No extra raw nodes | 100.0% |

### Insert

| Metric | GPT-OSS 120B |
| --- | ---: |
| `insert_success` | 16.7% |
| Position OK | 93.3% |
| Type OK | 96.7% |
| Mean param. (complete coverage) | 16.7% |
| Survivors match oracle | 100.0% |
| No extra raw nodes | 96.7% |

The diagnostic mean parameter-path coverage is 32.61%. This is not used for the
`Mean param.` table row, which is the stricter complete-coverage binary metric.

## Interpretation

### Delete

All 30 deletion cases passed. These tasks request deletion of one explicitly named
node, and the deterministic graph splice performs the actual removal and reconnection
after the model resolves the target. This is a useful end-to-end validation, but its
ceiling effect means it should not by itself be used to claim that two models are
equivalent on general workflow editing.

### Insert

The main limitation is parameter completion, not finding the edit location or choosing
the node type. Most non-perfect cases inserted the correct node in the correct place
but omitted one or more required n8n parameters, so they fail strict scoring.

Two notable failures occurred:

- `create-ins-015`: phase 1 did not complete, so no usable insertion was produced.
- `create-ins-028`: the inserted node type was correct, but its incoming and outgoing
  connections were reversed, producing a splice error.

Future work should therefore prioritize schema-guided parameter generation and
validation/retry for inserted nodes.
