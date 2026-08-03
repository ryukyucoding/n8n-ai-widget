# Create candidate benchmark plan

## Scope and confidentiality

This is a repeatable comparison of Create candidate quality, not a live
workflow test and not a default-model decision. The first round excludes the
Planner. Each candidate receives the same prompt-template fingerprint,
acceptance contract, runtime-schema snapshot fingerprint, and decoding-profile
fingerprint.

The manifest uses opaque candidate slots. Run records and public summaries
must not contain model identifiers, hosts, endpoints, model parameters,
credentials, workflow IDs, raw prompts, raw model output, or complete workflow
JSON. Maintain any required model-to-slot mapping in a separate access-
controlled operator record.

No single successful live response is ranking evidence. Each populated case is
run at least five times per candidate, with model/case/attempt order shuffled
from a recorded non-sensitive seed. A ranking requires the same completed case
set, repetition count, timeout policy, and verification snapshot for every
candidate.

## Case set

`C01` through `C07` are fixed IDs. `C01`, `C04`, and `C07` are the only IDs
currently backed by a machine-readable fixture. The remaining IDs are explicit
blocked entries in the manifest rather than invented prompts or contracts; they
must be specified before a full seven-case comparison can begin.

| Case | Tier | Generation/static verification | Execution evidence |
| --- | --- | --- | --- |
| C01 | controlled fixture | yes | future safe assertion only |
| C02, C03, C05, C06 | specification missing | no benchmark run | not applicable |
| C04 | sandbox required | yes | skipped, manual evidence, or isolated-sandbox evidence only |
| C07 | sandbox required | yes | skipped, manual evidence, or isolated-sandbox evidence only |

`C04` and `C07` must not be sent to the current production-like execution
runner. Their `n8n-nodes-base.code` use requires an isolated execution
environment capability. The benchmark records this evidence state separately;
it is not converted into a pass.

## Measurements

For every attempt record latency and timeout outcome before scoring. Then record
these independent outcomes:

- JSON parse pass;
- runtime schema pass;
- connection and port pass;
- must-execute-before pass;
- semantic-review pass (or explicitly unavailable/skipped);
- first-candidate pass, repair-needed, and candidate count;
- C01 safe execution assertion pass; and
- C04/C07 execution evidence status: only `skipped`, `manual_evidence`, or
  `sandbox_evidence` are valid in this phase.

JSON validity is only a format gate. It is never evidence that a workflow is
correct. Likewise, an execution result is not compared across tiers unless the
same safety environment and evidence rules apply.

## Existing offline metrics versus runtime benchmark

The repository includes an offline Create scorer and 60 creation gold
workflows under `Experiments/benchmark`. Given a prediction plus its matching
gold workflow, it can recompute JSON validity, Node F1, Connection F1, and
Matched Connection F1. Parameter Accuracy uses an embedding evaluator and
requires its Python dependencies and embedding model; it is therefore not
guaranteed to be runnable in an offline/no-network environment.

Those F1 metrics are offline gold-workflow similarity metrics. They are not the
same as this n8n runtime benchmark, which is based on the runtime schema
snapshot, connection/port validation, must-execute-before analysis, semantic
review, and tiered execution evidence. No C01-C07 gold workflow mapping or
batch runtime benchmark runner currently exists, so F1 must not be reported for
this new case set until matching ground truth and an adapter are supplied.

## Run protocol and failure records

Use the manifest's required attempt fields and enum values. A timeout records
`outcome=timeout`, elapsed time, and `failureStage=generation`; it does not
store model responses. A parse or validator failure records the corresponding
stage plus status codes only. Store aggregates (counts, rates, latency
percentiles) in the public report; retain sanitized diagnostic references only
in access-controlled operator logs.

Before running the next phase, obtain: the actual model inventory and a
confidential candidate-slot mapping; fixed specifications for C02/C03/C05/C06;
the frozen prompt and decoding profile fingerprints; a pinned runtime-schema
snapshot fingerprint; a C01 controlled execution evidence runner; and, for
C04/C07, an isolated code-execution environment with explicit capability
attestation. No benchmark invocation is authorized by this plan.
