# Nodewise Construction Protocol

## Purpose

This protocol separates semantic workflow planning from n8n JSON construction.
The planning agent returns a small, stable **intent plan**. It does not choose
n8n node versions, write parameters, make connections, or return a workflow.

The later Runtime Construction Skill owns those version-sensitive operations:

1. resolve each capability against the installed runtime schema;
2. instantiate only the exact installed node card and type version;
3. set only schema-allowed parameter roles;
4. connect ports from the declared input/output data contracts;
5. validate before returning a candidate JSON.

This is deliberate. Generating a workflow one node at a time reduces the
surface where an LLM must remember changing n8n syntax, but does not make nodes
independent. Each step still declares its data inputs and outputs, and the
compiler retains ownership of the global graph.

## Intent Plan Contract

The exact JSON contract is enforced by `autoresearch/nodewise/intentPlan.js`.

- `goal`: concise user outcome.
- `steps`: ordered semantic actions. A step may only read outputs produced by an
  earlier step.
- `capability`: one stable operation class, such as `http_request` or
  `data_transform`; it is not an n8n node type.
- `inputs` and `outputs`: short data-shape labels, for example `fetch.items` or
  `summary.count`.
- `requiredUserSetup`: labels for information the user must provide, such as a
  Google Drive credential or destination folder. Never include values or
  secrets.
- `expectedOutput`: the intended delivery shape and fields.

## First .44 Codex Trial

The first trial evaluates planning only, across five Easy-100 descriptions.
It is not allowed to call a model, create or execute a workflow, access n8n,
or modify files. The success criterion is five replies that validate against
the contract. A valid intent plan is **not** evidence that its final workflow
would execute correctly.

Run task generation on `.44` from the research worktree, then submit the five
generated task request files through the local A2A broker. The interactive
Codex session reads its debugger inbox and publishes one JSON reply per task.
The orchestrator validates every reply with `parseAndValidateIntentPlan` and
reports: valid plans, rejected plans, clarification-required plans, and any
contract error category.

`autoresearch/operations/submitNodewiseIntentTrialOn44.sh` submits the five
bounded tasks. `autoresearch/nodewise/collectIntentTrial.js` later reads the
broker state and emits only this safe aggregate; it does not retain requests or
agent plan contents in its report.

## Model Setting

Use `gpt-5.6-sol` with **High** reasoning for this initial five-case planning
trial. This is an architecture and tool-boundary decision, where reliability is
more useful than saving a few seconds. Reduce to Medium only after the same
contract passes repeatedly and latency becomes the limiting resource.

## Boundary

This protocol is research-only. It does not modify the deployed
`ollama-widget` service, credentials, production workflows, or n8n state.
