# GPT-OSS 120B edit benchmark results

## Test setup

- **Model:** `gpt-oss:120b` served by Ollama at `140.115.54.62`.
- **Tasks:** the first 30 cases of each Delete and Insert benchmark split.
- **Execution path:** the benchmark invokes the deployed `widget_agent_bridge.py` in
  the `n8n-chatbot-1` container. It records predicted workflow JSON only; it does
  not save or modify a workflow in n8n.
- **Scoring:** local benchmark scoring scripts in `Experiments/benchmark/scoring`.

The per-case raw outputs remain local in `results/gpt-oss-120b/`; that directory is
ignored because it contains many generated artifacts. The commands used to reproduce
this run are `run_delete_container.py`, `score_delete_batch.py`,
`run_insert_container.py`, and `score_insert_batch.py`.

## Summary

| Operation | Cases | Pipeline completed | Strict success | Other measures |
| --- | ---: | ---: | ---: | --- |
| Delete | 30 | 30 / 30 (100.00%) | 30 / 30 (100.00%) | All target removals, survivor graphs, and resulting connections matched the oracle. |
| Insert | 30 | 29 / 30 (96.67%) | 5 / 30 (16.67%) | Position: 28 / 30 (93.33%); node type: 29 / 30 (96.67%); mean parameter coverage: 32.61%. |

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
