# Easy-100 Generation and Execution-Readiness Batch

This experiment sends the source dataset's fixed system protocol plus each
original user description from the 100 Easy (`low`) test prompts to the
configured Create model. The assistant ground-truth workflow in the source
JSONL is never sent to the model. This preserves a legacy-comparable input
protocol; the newer Create prompt is a separate experiment.

The runner performs no n8n API call, does not create a workflow, and does not
execute a workflow. Each generated candidate is checkpointed, parsed using the
same strict/repaired JSON policy as Create, and checked with the existing
runtime-schema and Code-dataflow verifier.

The default per-case model timeout is 180 seconds, based on the historical
Easy-100 S1 p99 of about 170 seconds. A timeout stops the batch immediately:
the remote model may still be draining the aborted request, so an immediate
second call would produce misleading availability failures. `EASY100_TIMEOUT_MS`
can lower or raise the bound for a separately approved run.
`EASY100_LIMIT=1` provides a one-case preflight using the exact same protocol
and verifier before a larger run.

If a JSON-mode preflight receives an HTTP error, repeat only that one case with
`EASY100_JSON_MODE=false`. This changes only the API's optional JSON-mode flag;
the model, fixed source system prompt, original user description, and no-n8n
execution policy remain unchanged. The report stores only a safe HTTP failure
category and whether the error body was readable, never the error body itself.

`executionReadiness` is intentionally not called execution success:

- `eligible_for_controlled_execution`: static checks passed and no setup or
  Code sandbox condition was detected.
- `sandbox_required`: static checks passed but Code needs an isolated runner.
- `requires_user_setup`: credentials or external write capability require user
  configuration before a controlled execution can be attempted.
- `static_blocked`: runtime/schema/dataflow verification found a blocker.
- `not_parseable` or `generation_unavailable`: no execution candidate exists.

Actual execution evidence requires a separate approved runner: exact workflow
identity, completed execution identity, and output assertions. Its denominator
is the number of execution attempts, not all 100 descriptions.

The optional `evaluateLegacySimilarity.py` joins the private predictions with
the source JSONL ground truth and uses the existing node and connection scorers.
Its result is a historical topology comparison only, not a correctness or
execution metric.

`reverifySavedPredictions.js` can re-run only the benchmark-safe runtime schema
and dataflow checks on private predictions from an interrupted batch. It uses
fixed safe finding classes such as `parameter_schema` and `type_version`, and
makes no model, n8n API, or workflow execution call.

`auditSourceGroundTruth.js` applies the same safe static checks to the source
dataset's assistant answers. This is a version-drift audit: it distinguishes a
legacy dataset incompatible with the current n8n runtime from a model that
fails to reproduce an otherwise valid target.
