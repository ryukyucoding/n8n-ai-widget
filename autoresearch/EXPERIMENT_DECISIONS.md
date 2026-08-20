# Autoresearch Decision Ledger

This ledger records decisions that have evidence behind them. It is not a
backlog: a direction is retained only when a controlled trial supports it.

## Retain

- The installed runtime schema and static verifier are the authoritative
  source for node type, version, parameter, and connection validation.
- Qwen3.8 can use a bounded repair skill: in the three-candidate schema
  repair smoke test it removed all nine parameter-schema findings and left
  only two node-type findings, with one candidate reaching static pass.
- Static pass must not be inferred from JSON parseability. A workflow that
  adds nodes outside an accepted plan is a `plan_violation`.
- Automatic repair is limited to named, value-preserving runtime migrations.
  Parameter deletion is not a safe general repair.
- A deterministic nodewise compiler can bridge a small current-runtime subset.
  At revision `3ef98bd`, the offline `.44` smoke compiled
  `manual_trigger -> public HTTPS GET -> select_fields -> one_object output`
  with exact installed cards (Manual Trigger v1, HTTP Request v4.4, Set v3.4)
  and the existing verifier returned `pass` with zero findings. This is static
  evidence only; it does not prove n8n execution or general workflow support.
- The bounded compiler has now passed two controlled n8n executions:
  1. public object selection, created at revision `68769ac` and manually
     executed as workflow `p2wwyAyS0C1mIr8L`;
  2. public Todo-array aggregation, created at revision `830a33f` and manually
     executed as workflow `Vh9f60RfGCl9tgD4`, execution `558`.
  The second run had one final item and exact assertions
  `totalTodos=20` and `incompleteTodos=9` at verifier revision `2652686`.
  This proves only the two named compiler subsets, not arbitrary Code or
  arbitrary multi-service workflows.

## Retire

- Do not use the old Easy-100 workflow JSON as a current-runtime oracle. The
  source runtime audit found widespread version and schema drift.
- Do not rely on free-form planner JSON from Qwen3.8. The original three-case
  smoke test rejected all plans before Create.
- Do not rely on a tool-mediated free planner either. In the latest three-case
  trial, one plan was accepted, while two calls read the runtime catalog and
  stopped without submitting a plan. Forcing the next tool through the Ollama
  compatible endpoint did not change that behavior.
- Do not automatically drop unknown parameters or guess connection ports.
  Those edits can make static findings disappear while changing workflow
  meaning.

## Next Gate

Expand exactly one capability: preserve one named object from an earlier,
guaranteed predecessor while an item-array is aggregated, then emit one joined
output object. The controlled test must again create a disposable inactive
workflow, use a human UI execution, assert its exact output, and avoid any
credentialed or external-write node.
