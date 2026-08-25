# Runtime-Aware Compiler User Experience

## First-use flow

1. The user describes an automation in ordinary language.
2. The system replies with one of three useful outcomes: questions, a capability boundary, or a compact plan.
3. The user reviews the plan before any workflow is created.
4. The system looks up credential names after compilation and static validation pass, without reading any secret values.
5. Existing credentials are bound directly. Missing credentials do not block creation: the system creates an inactive draft and returns a setup checklist.
6. The user executes the draft and sees output-contract evidence.

## Interaction principles

- Ask only questions that unblock a supported plan.
- Explain unsupported work as a missing skill, not as a mysterious model failure.
- Keep credential values out of chat history, planner prompts, compiler specifications, and logs. The system may use only credential identity and service metadata for binding.
- Separate "draft created" from "ready to run" and from "output verified".
- Make every external write visible and reversible where n8n permits it.

## Example: email digest

```text
User: Every morning, summarize this RSS feed and email it to my team.

System: Plan ready.
  - read RSS
  - filter and format ten recent items
  - send email digest
  Credential status: SMTP credential not found.
  Setup required after draft creation: SMTP credential. Configuration still needed: sender, recipient.

User: Create draft.

System: Draft created. Open it in n8n to create or select the SMTP credential, then fill sender/recipient.

User: Runs workflow in n8n.

System: Shows execution result. It can say "execution passed" only if the configured output contract succeeds.
```

## Research capture

Every run should persist a non-secret record of request, selected skills, runtime schema revision, planner state, compiler revision, validation findings, setup state, workflow ID, and execution evidence. This makes future user reports actionable instead of anecdotal.
