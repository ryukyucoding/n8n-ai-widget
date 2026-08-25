# Runtime-Aware Workflow Product Architecture

## Product promise

The product must never represent a workflow as ready when the system only has a plausible JSON document. It must tell the user which of these states applies:

- the request needs clarification;
- the product lacks a required compiler capability;
- a workflow draft can be created but needs user setup;
- a workflow is ready for controlled execution;
- execution succeeded or failed against an explicit output contract.

## End-to-end path

```text
User request
  -> Intent intake
  -> Planner result
       -> clarification_required
       -> capability_gap
       -> ready_to_compile
  -> Typed step specification
  -> Runtime skill resolution
  -> Compiler with installed n8n schema
  -> Static verification
  -> Setup / confirmation gate
  -> Create inactive draft in n8n
  -> User configures credentials in n8n
  -> Controlled execution
  -> Output-contract evidence
```

## Responsibility boundaries

| Component | Owns | Must not own |
| --- | --- | --- |
| Planner | User intent, missing information, required capabilities | Raw n8n JSON, credentials, arbitrary code |
| Skill registry | Supported capability inventory, setup and risk requirements | Secret values, model reasoning |
| Compiler | Runtime node versions, parameters, ports, generated code templates, deterministic connections | Semantic guessing beyond a typed specification |
| Static verifier | Schema, connection, value and policy findings | Claiming real execution success |
| n8n UI | Credential selection, setup fields, human approval, actual execution | Sending credentials to a model |
| Execution verifier | Output contract and execution evidence | Silent repair of semantic intent |

## User-facing states

| State | What the user sees | Safe next action |
| --- | --- | --- |
| Clarification required | Specific unanswered questions | Answer in chat |
| Capability gap | Which ability is not implemented, without pretending a workflow was made | Save request or choose another mode |
| Plan ready | Short step list, required setup, and expected output | Review plan |
| Static validation failed | Concrete validation findings | Review; do not create |
| Setup required | Credential and configuration checklist, never secret fields in chat | Open n8n setup |
| Confirm external write | Destination and action summary | Confirm or cancel |
| Created draft | Link to inactive workflow | Configure and run in n8n |
| Execution passed/failed | Output-contract result and execution link | Activate, revise, or inspect |

## Four-day implementation order

1. Stabilize this state contract and skill registry.
2. Make Planner output one typed plan envelope, including `draft_requires_setup`.
3. Implement reusable high-coverage skills: authenticated HTTP, branch/control flow, and generalized mapping.
4. Bind n8n setup requirements to created drafts and add controlled execution evidence.

## Non-goals for this iteration

- Do not modify the `ollama-widget` branch.
- Do not silently execute external writes.
- Do not accept raw workflow JSON or credential values from a planner.
- Do not claim that a static pass proves semantic correctness or successful execution.
