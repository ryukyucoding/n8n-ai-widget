# AutoResearch Multi-Agent Architecture

## The actual problem A2A solves

Different Codex sessions and Antigravity instances do not have shared memory.
Pasting a long chat transcript between them is slow, lossy, and can leak secrets.
The broker replaces that with a durable task record:

```text
                  ┌─────────────────────────────────────┐
                  │  A2A Task Broker (server)            │
                  │ task state + safe messages + refs    │
                  └─────────────────────────────────────┘
                    ▲             ▲              ▲
                    │ JSON-RPC    │              │
       ┌────────────┘             │              └────────────┐
       │                          │                           │
┌─────────────┐          ┌──────────────────┐        ┌──────────────────┐
│ Orchestrator│          │ Experiment Agent │        │ Debugger (.44)   │
│ primary     │          │ lab Codex        │        │ diagnosis only   │
└─────────────┘          └──────────────────┘        └──────────────────┘
       │                          │                           │
       │                    ┌───────────────┐          ┌──────────────────┐
       └───────────────────►│ Evidence Agent│          │ Execution        │
                            │ Antigravity   │          │ Verifier         │
                            └───────────────┘          └──────────────────┘
```

The broker is not a sixth intelligence and does not execute work. It only records
the handoff. Two workstations can each run Codex and Antigravity; `.44 Codex` is a
role on the server rather than a fourth physical machine. An operator or a low-rate
heartbeat tells the relevant machine that a task has been assigned.

## Load policy

The earlier 15-minute heartbeat is useful for continuity but too costly if it wakes a
full coding session while the workstation is being used. The broker therefore treats
tasks as event-driven and load-classified, rather than polling work constantly.

| Resource class | Typical work | Broker limit |
| --- | --- | --- |
| `light` | read task, inspect a file, write a short report | no broker limit |
| `cpu-bound` | local parsing, static evaluation, test suite | one `working` task per host |
| `model-inference` | LLM generation, semantic review | one `working` task per host |
| `n8n-operation` | approved create, execution, readback | one `working` task per host |

An idle workstation should do no continuous model work. It may perform a tiny
heartbeat check with backoff, but it should not launch a task unless the broker has a
new assignment and the user is not actively using that machine. The server runs the
broker and explicitly approved services. The optional on-call debugger is not a
default model worker: it is an event-driven, single-task exception for a safe
diagnosis packet, and it yields whenever an interactive `.44 Codex` session is
active.

## Current degraded topology

Until the lab workstation is available again, treat this as a two-host system:

- `workstation-a`: the current computer. It runs the orchestrator and, sequentially,
  any evidence or experiment-preparation role.
- `server`: the broker and `.44 Codex` debugger role. It should not automatically
  run model inference or n8n operations.
- `workstation-b`: reserved for the lab computer after it returns. Do not assign a
  real task to it now.

The coordinator should use at most one heavy local task at a time. This is slower
than five-way parallelism, but it yields evidence we can trust without making the
current computer unusable.

## Role contract

| Role | Receives | Produces | Cannot do alone |
| --- | --- | --- | --- |
| Orchestrator | research objective, task outcomes | task decomposition, approval requests, decisions | assume another agent ran a task |
| Evidence researcher | question and evidence scope | source notes, dataset provenance, uncertainty | declare implementation success |
| Experiment engineer | approved experiment plan | reproducible command plan, revision/digest references, safe run outcome | call models/network without approval |
| Execution verifier | approved exact workflow/execution evidence | assertion pass/fail and sanitized findings | create, execute, or delete workflows without approval |
| Debugger | sanitized failure packet | probable root cause, test proposal, safe fix proposal | retry, deploy, or access credentials |

## Research loop

```text
1. Orchestrator creates a bounded task.
2. Evidence researcher or experiment engineer reports evidence.
3. If execution evidence fails, orchestrator sends a sanitized failure packet to debugger.
4. Debugger proposes a test/fix; it does not apply it.
5. Orchestrator asks the user before any external operation or product-code change.
6. After approval, experiment engineer or execution verifier performs the narrow action.
7. The result becomes a new task message with a revision/digest reference.
```

This makes the loop inspectable: each decision has an owner and each claim has a
reference. The authoritative code line remains `ollama-widget`; the broker should
record its revision for every code-related outcome.

## Task states

`submitted` means the task is ready for its assignee. `working` means that assignee
has started local reasoning or an approved operation. `input-required` means a human
decision or missing non-secret information is needed. `completed`, `failed`, and
`canceled` are terminal and cannot be reopened; create a new linked task instead.

## Cross-machine rollout

1. Start the broker on the server. Begin with loopback while testing.
2. Keep the broker loopback-only and reach it through an authenticated SSH tunnel.
   Give each remote role a distinct `A2A_BROKER_AGENT_TOKENS_JSON` entry outside Git;
   revoke one entry to disable just that role. Use TLS/reverse-proxy protection before
   any future private-network binding. Do not expose the current prototype publicly.
3. Give each machine one role identity. The identity is not a model API key; it is a
   label used for task authorization and auditability.
4. Each agent reads its assigned task, performs only its declared role, then posts a
   sanitized outcome. It must not place secrets, raw workflow JSON, raw execution
   payloads, or absolute local paths in a message.
5. Start with two roles (orchestrator + debugger), then add experiment and evidence
   roles after the handoff is routine. Five simultaneous agents are a capacity limit,
   not a requirement to use all five.

## What remains future work

- Use the official A2A SDK/types and a complete A2A server when external agent
  interoperability becomes necessary.
- Add OAuth/mTLS, per-task access control, encrypted durable storage, and event
  subscriptions before a shared or public deployment.
- Add a small client adapter for each actual environment (Codex on each computer and
  Antigravity). These products do not automatically expose compatible A2A endpoints.
- Connect only approved execution-first research experiments; never treat historical
  workflow-similarity scores as the primary quality signal.
