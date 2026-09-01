# Three-Day Execution Plan

## Outcome for This Sprint

Produce a small but real execution-first research loop. It must be observable and
safe, rather than pretending that five autonomous agents are already productive.

**Sprint acceptance evidence**

1. The lab workstation can receive one bounded offline task and return a sanitized
   result without human copy/paste.
2. A user can see task state, assigned agent, age, and the next required approval.
3. One video-generation request is transformed into a typed setup checklist rather
   than an unsupported-node or missing-input error.
4. The resulting proposed workflow uses only a reviewed supported skill or is
   explicitly stopped with a useful setup requirement.

## Day 1 - Connect and Observe

### Must finish

- [ ] Record the lab workstation's OS, available Codex/Antigravity installation,
  local repository path, and available disk/RAM. Do not install a background agent
  yet.
- [ ] Add a **scoped, revocable lab-agent identity** to the broker design. Do not
  copy the server's existing broker token to the lab workstation.
- [ ] Establish one authenticated tunnel or relay path from the lab workstation to
  the loopback-only broker.
- [ ] Implement a sanitized task-status command or small status page showing only:
  task ID, role, state, resource class, timestamps, and evidence digest/reference.
- [ ] Run a no-model `light` handoff: orchestrator -> lab experiment engineer ->
  broker -> orchestrator.

### Definition of done

The user can watch a task change from `submitted` to `working` to `completed` and
can tell which machine performed it. No n8n API, model, credential, or deployment is
used.

## Day 2 - Turn the Video Request into a Setup Plan

### Must finish

- [ ] Define the Skill Registry v0 schema and add two reviewed skills: generic HTTP
  Request and Google Drive upload.
- [ ] Define `video-generation-http-v1` only after reviewing the provider's current
  API documentation. If unsupported, record `needs_skill_review`; do not guess node
  parameters.
- [ ] Extend the Create contract with a durable non-secret setup checklist:
  prompt, duration, aspect ratio, provider choice, credential status, Drive folder,
  cost approval, and execution approval.
- [ ] Make clarification responses update the same Create session instead of relying
  on visible chat history.
- [ ] Produce a fixture-backed plan for the request "make a cartoon-style AI video
  and save it to Google Drive." No live provider request yet.

### Definition of done

The UI or a documented API response says exactly what the user must configure and
why. It never asks for an API key in chat, and it never emits an unsupported Runway
community node.

## Day 3 - Draft and Evidence Path

### Must finish

- [ ] Review and safely integrate the validated inactive-draft handoff, keeping
  unrelated dirty UI work out of the release.
- [ ] Show a setup checklist next to the draft: connected / missing / optional /
  needs approval.
- [ ] Add preflight gates for selected skill, non-secret credential reference, output
  folder, cost approval, and execution approval.
- [ ] Run one controlled execution path with a non-billable or explicitly approved
  provider action.
- [ ] Save a sanitized evidence record: workflow revision, setup status, execution
  status, output assertion result, and any debugger diagnosis.

### Definition of done

Either the workflow finishes with verified evidence, or the system stops before a
side effect and gives a precise user action. A generic error alone is not acceptable.

## Stretch Work - Only After the Must-Finish Items

- [ ] Add a second provider skill.
- [ ] Let Antigravity operate as evidence researcher through a separately scoped
  agent identity.
- [ ] Add opt-in execution assertions to more than one safe fixture.
- [ ] Build a browser task board instead of a CLI status view.

## Explicit Non-Goals for These Three Days

- A fully autonomous multi-agent loop.
- Automated credential creation or extraction of credential values.
- Automatic paid video generation.
- Automatic production deployment or n8n execution.
- Replacing the existing Create Reliability Harness.

## Daily Decision Gates

| Gate | Ask before proceeding | Reason |
| --- | --- | --- |
| Model call | Any non-local Codex/LLM invocation | Cost and external data transfer |
| External API | Video provider, Drive write, or web call | Side effect and provider policy |
| Credential action | OAuth, API key, sharing, or scope change | User-owned authorization |
| n8n action | Create, execute, activate, publish, or delete | Workflow side effect |
| Code deployment | Build/restart/push to `ollama-widget` | Production behavior |
