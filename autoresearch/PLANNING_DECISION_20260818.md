# Runtime-Aware Planning Decision

## Decision

Do not use `gpt-oss:120b` as the current Planner. Treat `qwen3.8:27b` as a
gated research Planner candidate: it may produce a typed plan only after local
runtime-catalog validation. The fine-tuned Create model remains the workflow
generator; the Planner does not replace it.

## Evidence

The Easy-100 case-0 preflights used only the original description and a
read-only current-runtime capability catalog. They made no n8n API calls and
did not create or execute a workflow.

| Planner attempt | Bounded input | Outcome |
| --- | --- | --- |
| `gpt-oss:120b` | 8 candidates, 68 parameters, 8,127 characters | timeout at 120 seconds |
| `gpt-oss:120b` | same bounded response, 180-second limit | timeout at 180 seconds |
| `gpt-oss:120b` | 5 candidates, 25 parameters, 2,444 characters | timeout at 180 seconds |
| `qwen2.5-coder-32b-ft-original:latest` | same minimal context | one contract rejection after 35 seconds; a separate bounded call returned HTTP 500 |
| `qwen3.8:27b` | same minimal context, `reasoning_effort=none` | catalog-compliant plan in 18.4 seconds |

The smaller catalog did not resolve the `gpt-oss` failure, so increasing its
timeout or repeating it is not justified. The Qwen3.8 result is one successful
single-case observation, not a batch result or a production approval.

## Agent Boundary

The Workflow Engineer Agent receives a user description and may perform only
these bounded steps:

1. Retrieve runtime capability cards from the installed schema export.
2. Produce a typed planning envelope with selected node types, exact versions,
   output requirements, and explicit setup gaps.
3. Validate the envelope locally before the Create model is invoked.
4. Send the validated, compact instruction to the fine-tuned Create model.
5. Read only sanitized verifier findings and propose the next repair or
   clarification step.

It must not read credential values, create or execute a workflow without a
separate approval, or treat a static pass as execution correctness.

## Role Assignment

Use Antigravity on the lab workstation as the first interactive Workflow
Engineer Agent, because it can work with the local checkout and its tools. Keep
the `.44` Codex role as debugger: it receives sanitized failure packets through
the A2A broker and proposes diagnoses, rather than owning workflow creation.

## Next Gate

Before a new Easy-100 batch, run one bounded Plan-to-Create preflight using
Qwen3.8 as Planner and the fine-tuned Create model as generator. It must keep
the plan and candidate in memory, perform only local JSON/runtime validation,
and make no n8n API call. Only after that gate should we decide whether an
interactive Workflow Engineer Agent is needed.
