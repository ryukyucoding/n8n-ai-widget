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

With explicit approval, run one disposable, exact-ID controlled execution for
the bounded compiler output, verify its declared output, then remove only that
exact workflow. Do not generalize the result until that execution evidence
exists. The next expansion should add only one capability at a time.
