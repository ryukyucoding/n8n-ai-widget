# Limit Items Runtime Fixture Result

## Scope

- Requested candidate: `topic/limit-items@6e9579af7135903de9fb3c90d7a712f28f2e116f`
- Requested fixture: manual trigger -> public todos -> `limit_items(5)` ->
  `count_false_boolean` -> `set_output` -> create -> readback -> manual execution.
- No source corpus, credentials, prompts, schemas, models, or acceptance criteria
  were changed for this attempt.

## Result

**Classification: `failed`**

The attempt stopped during compiler validation, before workflow creation. The
actual running service rejected the `limit_items` operation as unsupported.

Consequently, no workflow was created, no readback was available, and no manual
execution was performed. The following required runtime observations are
therefore unavailable for this attempt:

- Limit-node `maxItems` and `keep` readback;
- downstream preservation of `completed`;
- post-limit item count;
- `count_false_boolean` result; and
- final output contract.

## Interpretation

The requested revision has `limit_items` coverage in its source-level compiler
tests, but the supplied runtime evidence does not establish that the executing
service was built from that exact revision. This is an expected-versus-actual
mismatch at the deployment/active-image boundary, not evidence that the
candidate has a verified runtime fixture.

The capability remains `implemented` in the exact candidate's source evidence
and is **not** promoted to `verified_fixture`. No retry or on-site repair was
performed.

## Next Gate

Before any new fixture attempt, independently establish the active service's
exact revision and successful candidate build/deployment evidence. Then rerun
the unchanged fixture once under the approved protocol.
