# Research Organization and Operating Model

**Status:** operating map for agents and Dan. Update role facts when verified;
do not use this document to grant permissions or override A2A ownership rules.

## 1. Organization map

```text
                                      Dan
                     Human owner / research director / final authority
                     ├─ sets research goal and acceptance standard
                     ├─ decides deployment, promotion, destructive cleanup,
                     │  credentials, production access, and external sharing
                     └─ bridges cross-machine communication until a direct
                        secure channel exists

      ┌────────────────────── GPT capacity pool ──────────────────────┐
      │                                                              │
brain — research coordinator                                 Desktop Codex / Terra
GPT-5.6 family                                               senior technical operator
├─ roadmap / architecture                                    ├─ desktop data/checkouts ownership
├─ independent result review                                 ├─ GitHub and approved Git operations
├─ experiment contract / acceptance                           ├─ private-environment evidence collection
├─ cross-role prioritization                                  ├─ approved deployment execution / .44 commands
└─ A2A governance and escalation                             └─ coordinates with .44 Codex when authorized
      │                                                              │
      └──────────────────────────────────────────────────────────────┘

      ┌──────────────────── Claude capacity pool ────────────────────┐
      │                                                              │
executor — lab evidence engineer                              Desktop Claude
Opus 4.8                                                     Opus 4.8 fallback collaborator
├─ bounded experiments / test reproduction                    ├─ assists Desktop Codex when its GPT capacity is
├─ source, wiring, and architecture audits                    │  unavailable
├─ independent review of evidence                             ├─ should take distinct bounded tasks, not duplicate
├─ durable continuous-research queue                          │  executor's full audit
└─ brain recovery documentation                               └─ reports to Dan/Desktop Codex or A2A through Dan
      │                                                              │
      └──────────────────────────────────────────────────────────────┘

.44 Codex — production-adjacent experiment operator
├─ closest to self-hosted n8n and private runtime facts
├─ executes only explicitly authorized runtime fixtures, diagnostics, or
│  deployment-adjacent commands
├─ returns sanitized evidence to Desktop Codex / Dan
└─ must report actual model/provider and quota pool before allocation
```

## 2. Roles and decision rights

| Role | Primary responsibility | Can decide alone | Requires Dan | Must not do |
| --- | --- | --- | --- | --- |
| Dan | Research direction, product acceptance, access authority | Human decisions and final tradeoffs | — | Delegate away final responsibility for secrets, deployment, promotion, or destructive cleanup without explicit scope |
| brain | Research architecture, priority, independent synthesis, acceptance criteria | Bounded planning, documentation, review-topic commits/pushes authorized by Dan | Deployment, product promotion, remote deletion, force-push, credentials, production configuration | Treat a hypothesis or relay as verified evidence; duplicate executor's bounded audit work |
| executor | Reproducible evidence, audits, continuous research, independent verification | Authorized read-only/documentation work and A2A evidence records in its autonomy envelope | Product code, deployment, promotion, deletion/consolidation, credentials, production changes | Write Codex-owned A2A files; self-certify its own deployment; compete with another Claude writer |
| Desktop Codex / Terra | Senior private-environment operator and deployment executor | Bounded private evidence collection after Dan approval | Any deployment/ref movement/configuration change, external effect, credential action | Replace evidence criteria after seeing results; publish private host/path/secret material to A2A |
| Desktop Claude | Capacity fallback for desktop work | Distinct bounded analysis/test work assigned by Dan/Desktop Codex | Git/deployment/credential/production actions unless separately authorized | Duplicate Desktop Codex's task while sharing the same Claude quota pool with executor |
| .44 Codex | Runtime-near operator | Read-only diagnosis where authorized | Runtime writes, deployment, workflow creation/execution, environment changes | Guess private runtime state; leak raw secrets/host details; assume its model/quota pool |

## 3. Work routing

```text
New research question
  → brain defines evidence/acceptance contract
  → executor performs bounded reproducible audit or prototype evidence
  → brain independently checks method and conclusion
  → Desktop Codex / .44 Codex performs private runtime fixture only when Dan authorizes
  → brain + executor classify sanitized evidence
  → Dan accepts, rejects, requests repair, or authorizes promotion
```

### Allocation principles

1. **One task, one primary owner.** A second agent receives an independent
   verification dimension, not a duplicate open-ended task.
2. **Keep implementation and acceptance apart.** The deployer records raw
   evidence; brain/executor evaluate it against criteria set before deployment.
3. **Use the cheapest sufficient quota pool.** Do not spend GPT capacity on
   routine grep/test reproduction that executor can run; do not spend Claude
   capacity on duplicate desktop Git/environment work that Desktop Codex owns.
4. **Serialize shared pools.** Brain and Desktop Codex avoid concurrent broad
   GPT jobs. Executor and Desktop Claude avoid concurrent full-repo reads or
   reviews. `.44` Codex announces its actual provider before being scheduled.
5. **Prefer bounded artifacts.** A task should name its input ref, expected
   artifact, tests/evidence, stop condition, and forbidden actions.

## 4. Communication topology

### Current durable channel

```text
canonical codex/autoresearch-a2a
  ├─ sanitized decisions/findings/evidence packets
  ├─ cross-machine durable work queue
  ├─ recovery and continuity protocols
  └─ organization/branch/deployment contracts
```

### Current real-time channels

- Lab-machine brain ↔ executor: direct cross-session messaging.
- Desktop agents ↔ lab/.44: currently relayed through Dan and synchronized by
  A2A Git records.
- Desktop Codex ↔ .44 Codex: private operational channel only when Dan
  authorizes; return sanitized results to A2A.

### Known limitation and target improvement

There is no direct authenticated cross-machine agent-to-agent messaging yet.
Until one exists, Dan is the human relay and A2A is the durable source of truth.
A future channel must provide: per-instance identity, scoped authorization,
event notification, durable queue semantics, sanitized artifact references, and
no credential transmission. It must not bypass Dan's production/credential
approval gates.

## 5. Current research routing

| Workstream | Current state | Next owner / required evidence |
| --- | --- | --- |
| Mapping v1 string/boolean | `verified_fixture` on one public-source case | Desktop Codex/Dan retain execution evidence; brain/executor independently classify |
| Mapping v1 number | `implemented_untested / provisional` | Desktop Codex/.44 executes deterministic Case B; brain/executor review readback + execution result |
| Mapping promotion | Blocked | Requires Case B, target-env rejection matrix, independent sign-off, Dan promotion approval |
| Control flow IF | Design input only; Option B adapter direction | Desktop Codex/.44 must pin filter and merge fixtures before any code |
| Credential/setup | Contract exists; no product caller | Caller-auth runtime facts and Dan's access-control decision before implementation |
| Public source expansion | Existing source contract verified | Dataset/categorizer evidence before prioritizing new capabilities |
| PlanReviewGate | Unwired retirement candidate | Keep until Dan authorizes deprecation/deletion and brain reviews cleanup |

## 6. Operational anti-patterns

- A role name is not a model/provider guarantee.
- A passing unit test is not a runtime fixture.
- A healthy deployment is not an execution-success claim.
- A sanitized record is not a substitute for independently reproducible raw
  evidence; classify its provenance honestly.
- A2A is not an automatic authorization for Git, deployment, credential, or
  production action.
- A shared quota pool is not parallel capacity. Scheduling two expensive jobs in
  one pool often produces less throughput than serial bounded work.
