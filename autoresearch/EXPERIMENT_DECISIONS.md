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

Test a bounded construction skill rather than another planner. The agent may
only add installed node cards, set schema-allowed parameters, connect known
ports, validate, and finalize. The first trial must use multiple Easy-100
descriptions and report static validity separately from user setup and
execution eligibility. It must not create or execute n8n workflows.
