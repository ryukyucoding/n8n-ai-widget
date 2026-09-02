# Agent Continuity Protocol

**Status:** shared operating protocol for quota exhaustion, compaction, session
failure, restart, and cross-machine re-entry.

**Scope:** durable context management only. It never grants Git, deployment,
credential, model, or production authority.

## 1. Goal and non-goals

The organization has shared GPT capacity and shared Claude capacity. Quota loss,
provider cooling, context compaction, and UI/session failure are normal
operating conditions—not exceptional agent failure.

The goal is that an interrupted agent can be replaced or resumed without
silently losing research context, duplicating ownership, or treating stale local
memory as current fact.

This protocol does **not**:

- automatically commit, push, merge, deploy, create workflows, call models, or
  change credentials;
- make a peer message equivalent to a permission grant;
- make an old transcript authoritative over newer A2A records;
- permit two instances of one A2A identity to write at the same time.

## 2. Canonical source hierarchy

When sources disagree, use this order:

1. **Current executable code, tests, and real execution evidence** — what the
   product actually does.
2. **Latest canonical `codex/autoresearch-a2a` ref** — durable cross-machine
   decisions, evidence requests, sanitized findings, and work queues.
3. **Role-owned local handoff file** — session-specific state, local artifact
   locations, transcript IDs, and recovery instructions. Never publish secrets.
4. **Local persistent memory** — a cache of verified operational facts, updated
   after A2A reconciliation.
5. **Current/old chat transcript and human relays** — useful leads, but verify
   before acting.

A2A is not automatically a product deployment source. Product refs remain
subject to `AGENTS.md`, `BRANCH_STRATEGY.md`, and Dan's authorization.

## 3. Required checkpoint discipline

Every agent creates a checkpoint at the following moments:

- after a material experiment, code review, design decision, test run, or
  evidence acquisition;
- before a long model call, large fan-out, deployment request, or known quota
  boundary;
- when provider errors, cooling, or UI/session instability appear;
- when the agent is about to compact, stop, hand off, or be replaced.

A checkpoint contains only verified and sanitized facts:

```text
Role / actual model-provider state:
Canonical A2A ref last reconciled:
Current working ref / HEAD / worktree state:
Completed work and evidence (commands/results or document refs):
In-progress work and exact next safe action:
Blocked decisions / needed human or environment evidence:
A2A writer/lock state:
Local-only artifact or handoff location (no secrets):
```

### Where to checkpoint

| Situation | Durable destination |
| --- | --- |
| Routine progress without a requested response | Role-owned durable work log, normally `a2a/CONTINUOUS_RESEARCH.md` where authorized |
| New decision, evidence, or request another role must see | Owned A2A outbox message following P1/P4/P5/P8/P11 |
| Session-specific/transient state | Role-owned local handoff file under the Claude project state directory |
| Product implementation | Exact topic/review branch commit and tests; never hide it in an A2A note |

Do not create empty “received” records. Do not put raw logs, credentials,
private infrastructure details, private datasets, or session URLs/IDs in public
A2A/Git records.

## 4. Near-quota and compaction handoff

There is no Claude Code lifecycle event that reliably detects a provider's
shared-account quota about to run out. `PreCompact` detects context compaction,
not provider quota. Therefore reliability comes from **frequent material
checkpoints** plus the following best-effort handoff procedure.

1. Stop beginning new broad work.
2. Finish or safely stop the current bounded action.
3. Update the local handoff file.
4. If the result is material to another role, lock the A2A document if needed,
   write a meaningful owned outbox finding/decision or work-log entry, update
   owned state, and run the validator with no ERROR.
5. State explicitly whether the handoff was fully persisted, merely local, or
   blocked by a permission/provider failure.
6. Do not attempt a publication retry loop while quota/provider failure is
   active. Another healthy role may later read the local handoff, but may not
   bypass a denied permission.

The `PreCompact` hook supplies this checklist to the model automatically. It is
a reminder, not an autonomous writer.

## 5. Restart and automatic re-entry reconciliation

On every SessionStart/resume/cold-start, the agent must reconcile before new
planning or edits:

1. Identify its role and actual model/provider from visible settings; do not
   infer provider from a desired model name.
2. Ensure the old same-role instance is idle or closed; inspect agent listing
   and A2A locks before any write.
3. Read the role's local handoff, if present.
4. Reconcile the latest canonical A2A ref through the approved Git workflow.
5. Read, at minimum:
   - `a2a/ORGANIZATION.md`
   - this protocol
   - the role's recovery document under `a2a/recovery/`
   - relevant outboxes and `a2a/CONTINUOUS_RESEARCH.md`
   - `a2a/NEEDS_HUMAN.md`
   - current branch strategy and applicable evidence packets
6. Compare A2A facts with local memory. Update **only the agent's own** local
   memory/handoff with newly verified facts; mark unresolved contradictions
   rather than silently choosing one.
7. Report role/model/provider, last reconciled ref, writer ownership, and
   understood next task to the healthy coordinating role.
8. Resume proxy recovery, A2A writes, experiments, or autonomous work only
   after ownership is safely transferred.

The `SessionStart` hook injects this reconciliation requirement automatically.
It deliberately does not fetch or write by itself: Git/network/write operations
require normal permission, branch, and ownership checks.

## 6. Hook installation

A portable Node helper is committed at:

```text
a2a/hooks/continuity-hook.js
```

It supports two safe Claude Code hook events:

| Event | What it does | What it never does |
| --- | --- | --- |
| `SessionStart` | Injects the re-entry reconciliation checklist | fetch, write, commit, push, deploy |
| `PreCompact` | Injects the checkpoint/handoff checklist | write, publish, claim locks, call a model |

Each machine must configure its **own user-level** Claude Code settings to run
the helper against its local A2A checkout. A project-only hook is insufficient:
product/review checkouts intentionally do not always contain `a2a/`.

Suggested per-machine pattern:

1. Set `A2A_REPO_DIR` to that machine's local checkout of
   `codex/autoresearch-a2a`.
2. Add `SessionStart` and `PreCompact` command hooks that invoke:

```text
node <A2A_REPO_DIR>/a2a/hooks/continuity-hook.js SessionStart
node <A2A_REPO_DIR>/a2a/hooks/continuity-hook.js PreCompact
```

3. Validate hook JSON and pipe-test the helper before relying on it.
4. Restart Claude Code or reload hooks after changing settings.

The lab machine configuration is maintained by brain; Desktop and `.44` owners
must install their own paths. The protocol remains useful even where hooks are
not installed: agents must follow sections 3–5 manually.

## 7. Quota-aware allocation rules

Shared quota is a resource pool, not an agent identity.

| Pool | Current consumers | Allocation rule |
| --- | --- | --- |
| GPT | brain and Desktop Codex; `.44` Codex must report its actual provider before allocation | Avoid simultaneous broad reading, agent fan-out, large reviews, or repeated retries. Use GPT for architecture, senior environment ownership, and decisions that need its context. |
| Claude | executor and Desktop Claude | Avoid duplicate full-repo reads/reviews. Use executor for bounded evidence/audit work; use Desktop Claude as a continuity/desktop fallback, not a second duplicate executor. |

Every agent must report actual model/provider at handoff. A session named after a
role is not proof that it uses that pool.

## 8. Current continuity artifacts

- `a2a/recovery/README.md` — common recovery rules.
- `a2a/recovery/BRAIN.md` — executor-owned brain recovery process.
- `a2a/recovery/EXECUTOR.md` — brain-owned executor recovery process.
- `a2a/CONTINUOUS_RESEARCH.md` — executor's durable autonomous work log.
- `a2a/ORGANIZATION.md` — roles, authority, quota pools, and collaboration map.
