# Option-B adapter contract — nodewise branch surface → pipelineIr structural validation → n8n If/Merge emitter

**Status:** implementation-neutral contract for a single 2-way IF. Not code, not an implementation authorization, not a pipelineIr-canonical decision. Builds on `CONTROL_FLOW_DECISION_INPUT.md` (Option B) and the R1 schema facts in `CONTINUOUS_RESEARCH.md`.
**Author:** executor (2026-09-02). **Scope guard:** one 2-way `if` whose two branches converge to the existing one_object output contract; no switch, no loops, no waits, no nested branches beyond one level unless brain later extends this contract.

## 0. Three layers and their responsibilities

| Layer | Owns | Must not do |
| --- | --- | --- |
| **nodewise branch surface** (spec the planner/user produces + approval binds to) | condition grammar, branch step lists, source-schema field validation, the one_object output contract, canonicalization/fingerprint | know pipelineIr internals; emit n8n JSON directly |
| **pipelineIr structural validation** (adapter lowers the bounded IF into it) | port/branch edges, cycle detection (`topologicalOrder`), merge topology, shape reachability | field-existence/type checks against source schema; issue approvals |
| **n8n If/Merge emitter** | map validated structure → `n8n-nodes-base.if` (2 ports) + `n8n-nodes-base.merge` + connections | re-validate business rules; invent operators/params not pinned by a fixture |

The adapter is one-directional (surface → structure → emit). Source-schema and approval stay entirely in the nodewise layer so Mapping v1's proven guarantees are untouched.

## 1. Canonicalization / fingerprint — fields that MUST be covered

`computeFingerprint(canonicalizeIr(ir), runtimeSchemaRevision, skillRegistryRevision, sourceRegistryRevision?)` must deterministically include every new branch field, or an approval could be reused across a changed plan:

- the branch/if step id and capability;
- `condition.field`, `condition.operator`, `condition.valueType`, `condition.compareValue`;
- ordered `onTrue` step ids + configs and `onFalse` step ids + configs (canonical order fixed, not input order);
- the rejoin/merge step id and its declared merge mode + input count;
- the branch step's declared output fields (must equal expectedOutput.fields).

`canonicalizeIr` must sort/normalize these deterministically (mirroring set_fields' tagged-mapping normalization) so `validate(validate(spec)) === validate(spec)` and the same plan yields the same fingerprint. Any field the emitter reads but the fingerprint omits is an approval-bypass hole — enumerate and test them.

## 2. Where source-schema validation lives

Entirely in the **nodewise layer**, before the adapter runs:
- `condition.field` must exist in the branch input's declared schema (registered source or prior-step output) with a type compatible with the operator/`compareValue` — reuse `assertInputField`.
- every field each branch's final step produces must be validated exactly as today (no invented fields).
- the adapter/pipelineIr layer receives an already-field-validated structure and only checks topology. pipelineIr gains no source-schema awareness.

## 3. Output contract — both branches converge to one one_object

- `expectedOutput.deliveryShape` stays `one_object`.
- `onTrue` and `onFalse` must each end producing **exactly** `expectedOutput.fields` (same names, same order, same types). A branch that produces a different field set is rejected before emit — this preserves the existing strict final-fields equality check and means the merge output is contract-stable regardless of which branch ran.
- No branch may leave a field unset or add an extra field.

## 4. Merge semantics (must be pinned by a fixture before emit)

- Candidate: `n8n-nodes-base.merge@3.2`, `numberInputs = 2`, one branch on each input, single `main` output.
- The exact mode (`append` vs `chooseBranch`) that yields "the single item from whichever branch ran, as one_object" is **UNKNOWN from schema** (R1) and MUST be confirmed by a real n8n fixture/.44 readback before the emitter hard-codes it. Until pinned, the contract records merge-mode as a required fixture output, exactly like Mapping v1's number-literal provisional handling — do not claim runtime-correct merge without execution evidence.

## 5. Rejection matrix (fail-closed; unit-testable before any deployment)

The surface/adapter MUST reject, with a clear reason, each of:

- **missing condition key** — `condition` absent, or missing `field`/`operator`/`valueType`/`compareValue`;
- **extra/unknown key** — any key outside the declared condition/branch grammar (tagged, like set_fields);
- **non-boolean condition** — operator/compareValue whose evaluation is not a boolean test (operator must come from the pinned boolean-result allowlist; unknown operator rejected);
- **dangling branch** — `onTrue`/`onFalse` referencing a nonexistent step, or a branch with no terminal step;
- **field/type mismatch** — `condition.field` not in source schema, or `compareValue` JS type ≠ `valueType`, or a branch output field/type ≠ expectedOutput;
- **cycle** — adapter's pipelineIr `topologicalOrder` throws (`IR contains a cycle`); surfaced as a rejection, not a crash;
- **unsupported merge** — merge mode/input-count outside the pinned allowlist, or branches not both rejoining the single merge;
- **shape misuse** — items input where one_object is required (branch condition input and branch outputs are one_object for v1).

Each check needs a unit test separating actual result from expected, mirroring the Mapping v1 discipline.

## 6. Explicit non-goals / deferred (brain decides)

- Does **not** decide whether pipelineIr becomes the canonical IR (Option C) — the adapter uses pipelineIr for structure only.
- Does **not** touch `planReviewGate` or `setupManifest`.
- Does **not** add operators/merge params beyond what a real fixture pins.
- Does **not** implement anything — code waits for brain's review of R1/R2 and explicit authorization.

## 7. Pre-implementation blockers (must be resolved before IF code)

1. Operator allowlist + filter v3 JSON shape — pin against the n8n filter component / a real If fixture (needs Desktop Codex/.44).
2. Merge mode + item semantics for mutually-exclusive rejoin — pin against a real Merge fixture (needs Desktop Codex/.44).
3. brain's decision: adapter (Option B) confirmed vs reconsider A/C.
