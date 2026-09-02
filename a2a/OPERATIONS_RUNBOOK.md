# Production Operations Handoff (Sanitized)

This document is a public collaboration handoff. It deliberately excludes
internal hostnames, addresses, ports, checkout paths, container names, private
endpoints, credentials, secrets, and production command sequences.

For the immutable Mapping v1 acceptance contract, read
`a2a/DEPLOYMENT_VERIFICATION_PROTOCOL.md`. That protocol is a deployment
proposal and verification contract; it is not deployment authorization.

## Roles

- **Dan** explicitly authorizes an exact ref, a target/test window, creation of
  inactive test workflows, and manual n8n execution.
- **Desktop Codex / Terra** performs only the approved private-environment
  deployment steps and preserves raw, private evidence.
- **brain + executor** independently compare sanitized evidence with the
  predeclared acceptance contract. They do not deploy or redefine success.

## Private Deployment Procedure

The deployment executor must use a private, locally maintained runbook in the
approved environment. That runbook may contain operational commands, but it
must not be committed, pasted into A2A, or copied into reports.

Before a production change, the executor must:

1. Confirm Dan's explicit authorization for the exact immutable revision.
2. Check the product checkout for unreviewed changes and stop if any exist.
3. Fetch and detach at the exact authorized revision, then record its full and
   short commit IDs.
4. Build the candidate and run the predeclared focused and full test gates.
5. Confirm that no user is reviewing a plan before rotating any plan-approval
   secret; generate a replacement only inside the approved private environment.
6. Stop on any unexpected revision, test failure, rollback, or unhealthy final
   service state. Do not alter code, prompts, models, schemas, credentials, or
   success criteria in place.

## n8n Verification Boundary

A service deployment alone is not a workflow success claim. The evidence path
for an approved test is:

```text
natural-language request
-> constrained planner
-> reviewable plan
-> explicit approval
-> deterministic compiler
-> workflow creation and readback
-> manual n8n execution
-> output-contract inspection
```

Sanitized reports may identify the revision, request category, plan outcome,
workflow ID/name, readback structural facts, execution ID/status, output
fields/types, and whether rollback occurred. They must not contain secrets or
private infrastructure metadata.

## Claim Discipline

- A healthy service proves only that the service is running.
- A workflow creation/readback proves only that an n8n workflow was created.
- One passing manual end-to-end fixture may be called `verified_fixture` only
  when every predeclared condition in the verification protocol has passed.
- A branch is never promoted automatically. Dan decides promotion after
  independent evidence review.

## Incident Rule

When a step differs from its predeclared expected result, stop at that stage.
Preserve complete raw evidence only through the approved private channel, then
send a sanitized finding to the collaboration record. Do not repair production
by trial and error.
