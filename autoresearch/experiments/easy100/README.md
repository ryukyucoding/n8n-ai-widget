# Easy-100 Generation and Execution-Readiness Batch

This experiment sends only the original user descriptions from the 100 Easy
(`low`) test prompts to the configured Create model. The assistant ground-truth
workflow in the source JSONL is never sent to the model.

The runner performs no n8n API call, does not create a workflow, and does not
execute a workflow. Each generated candidate is checkpointed, parsed using the
same strict/repaired JSON policy as Create, and checked with the existing
runtime-schema and Code-dataflow verifier.

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
