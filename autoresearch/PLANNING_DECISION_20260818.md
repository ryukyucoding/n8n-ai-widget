# Runtime-Aware Planning Decision

## Decision

Suspend direct one-shot LLM planning for the current server deployment. Use a
Schema-Grounded Workflow Engineer Agent as the next planning boundary instead.
The fine-tuned Create model remains the workflow generator; the agent does not
replace it.

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

The smaller catalog did not resolve the planner failure. Therefore schema
context volume is not the only bottleneck, and increasing timeouts or repeating
the same direct planner calls is not justified.

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

Before a new Easy-100 batch, implement and test the typed planning-envelope
validator plus an interactive agent work order. One approved single-case run
must first show that the agent can produce a catalog-compliant envelope. Only
then should it call the fine-tuned Create model.
