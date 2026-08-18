# AutoResearch A2A Task Handoff

`autoresearch/` is the communication layer for the next research phase: generating
and validating n8n workflows from natural-language requests. It gives up to five
agent roles a shared, durable task record without requiring them to share private
chat history. The physical setup is two workstations (each can run Codex and
Antigravity) plus one server; five roles do not mean five always-running processes.

This implementation is deliberately small and dependency-free. It follows the
important A2A ideas -- Agent Cards, Tasks, Messages, and JSON-RPC `SendMessage` --
but is **not a complete or certified implementation of the A2A protocol**. Before
opening it outside a trusted network, add transport protection and a managed
identity provider. Scoped agent tokens prevent accidental role impersonation here,
but they are not a replacement for production-grade identity management.

## Why A2A here

An agent cannot reliably infer another agent's hidden conversation or local files.
Instead, the broker records a task's owner, assignee, state, safe summary, and
artifact references. The next agent starts from that explicit evidence.

The protocol is complementary to MCP: MCP connects an agent to tools, whereas A2A
is intended for agent-to-agent collaboration. See the [A2A specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md),
the [protocol schema](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto),
and the [official JavaScript SDK](https://github.com/a2aproject/a2a-js).

## Roles

| Agent ID | Suggested operator | Responsibility |
| --- | --- | --- |
| `orchestrator` | primary Codex | plans work, assigns tasks, requests user approval for side effects |
| `evidence-researcher` | Antigravity | records literature/data evidence and open questions |
| `experiment-engineer` | Codex on a lab machine | creates reproducible offline experiment plans and runs approved ones |
| `execution-verifier` | primary Codex | validates allowed n8n execution evidence and output assertions |
| `debugger` | .44 Codex | diagnoses sanitized failure packets and proposes tests or fixes |

The cards in `agents/cards/` define only capabilities and limits; they do not contain
credentials or machine addresses.

## Safety boundary

- Never place API keys, cookies, credential values, raw workflow JSON, execution
  data, or absolute local paths in a task message.
- Use a Git revision plus repository-relative path and digest for an artifact.
- The broker starts on `127.0.0.1` by default. Each remote worker should receive a
  different, revocable entry in `A2A_BROKER_AGENT_TOKENS_JSON`, stored only in the
  broker process environment. A scoped token may submit messages only as its assigned
  role. `A2A_BROKER_TOKEN` remains a temporary legacy compatibility token for `.44`.
- A task message is a coordination record, not authorization to call a model,
  create/execute/delete an n8n workflow, deploy, or use the network.
- The broker does not itself invoke Codex, Antigravity, or .44. The optional `.44`
  on-call dispatcher is the only automatic consumer currently supported: it accepts
  one narrowly allowlisted debugger task and invokes `codex exec` only at task time.
- Tasks include an `executionHost` (`workstation-a`, `workstation-b`, or `server`)
  and a `resourceClass`. The broker permits only one active `model-inference`,
  `cpu-bound`, or `n8n-operation` task per host. This prevents background work from
  competing with interactive work; `light` tasks remain unconstrained.

## Run locally

```powershell
node autoresearch/broker/server.js
node --test autoresearch/tests/*.test.js
```

Use the small client rather than manually composing an HTTP request:

```powershell
node autoresearch/client/task-client.js --request autoresearch/examples/create-execution-task.json
```

The client reads `A2A_BROKER_TOKEN` only from its environment, never from command
arguments. For a scoped worker, set its own token in that variable plus
`A2A_AGENT_ID`. It is safe to use from the current workstation for a local proof of
handoff; server deployment remains a separate, approved step.

The default endpoint is `http://127.0.0.1:8787`. It serves the facilitator card at
`/.well-known/agent-card.json` and individual role cards at
`/agents/<agent-id>/.well-known/agent-card.json`.

For a trusted shared host only:

```powershell
$env:A2A_BROKER_AGENT_TOKENS_JSON = '{"orchestrator":"<server-only-token>","experiment-engineer":"<lab-only-token>"}'
$env:A2A_BROKER_HOST = '0.0.0.0'
$env:A2A_BROKER_STATE_PATH = '<writable state path outside the source checkout>'
node autoresearch/broker/server.js
```

To monitor only safe metadata, without printing task instructions, replies, paths,
or artifact contents:

```powershell
$env:A2A_AGENT_ID = 'experiment-engineer'
node autoresearch/client/task-status.js
```

## Minimal message flow

1. `orchestrator` sends `SendMessage` with a safe instruction, `assigneeAgentId`,
   `executionHost`, and `resourceClass`.
   Without `taskId`, the broker creates a task in `submitted` state.
2. The assignee sends a status message, moving it to `working`, `input-required`,
   `completed`, or `failed`.
3. Evidence is attached only as a safe artifact reference: `repository`, `revision`,
   `path`, and `sha256`.
4. A failure is sent to `debugger` as a structured, sanitized failure packet. The
   debugger proposes a diagnosis; the orchestrator decides whether to ask the user
   for permission for any side effect.

JSON-RPC examples are in `examples/`. Runtime state is written to `state/`, which
is intentionally ignored by Git.

## Interactive .44 debugger handoff

The broker does not start an interactive Codex session. When `.44 Codex` is open,
give it the fixed instruction below once. It can read its assigned task and publish
its own answer without the human copying the task body between machines:

```text
You are the AutoResearch debugger. First run:
node autoresearch/client/debugger-inbox.js
For each submitted task, analyze only its sanitized instruction. Do not call models,
the network, n8n, or retry operations. Write a concise diagnosis to /tmp/a2a-reply.txt,
then run:
node autoresearch/client/reply-task.js --task <TASK_ID> --reply /tmp/a2a-reply.txt
```

`ListInbox` is a small internal broker extension for the interactive debugger; it is
not presented as a complete standard A2A queue API. The next orchestration step reads
the same task through `GetTask`.

## Optional .44 on-call debugger

`oncall/` provides a bounded, event-driven alternative to manually opening Codex on
`.44`. It is intentionally not a general autonomous worker.

- It accepts only `debugger` tasks with `taskType=sanitized_failure_diagnosis`,
  `executionHost=server`, and `resourceClass=model-inference`.
- The `PathChanged` unit wakes on a new broker state file; a 15-minute timer is only
  a fallback for a task deferred because a human interactive Codex session was open.
  Neither mechanism runs a model while there is no matching task.
- It takes an exclusive lock, leaves the task submitted when interactive `codex` is
  detected, uses low CPU/I/O priority, and bounds one `codex exec` run to five
  minutes. It performs no retry.
- The task packet is treated as untrusted data. The model is instructed not to run
  commands, change files, use n8n/network tools, or access credentials. It returns a
  sanitized diagnosis only. Any later fix or external action still requires an
  orchestrator and user approval.

The dispatcher uses the installed `.44` CLI's non-interactive `codex exec` mode with
`--sandbox read-only`, `--ephemeral`, `--ignore-user-config`, and `--ignore-rules`.
Those flags restrict its local work; the Codex model request itself is an external
model call made only after an allowlisted task is assigned.

Install only on `.44`, after the broker has been verified and the repository is at a
reviewed revision:

```bash
mkdir -p ~/.config/systemd/user ~/.config/autoresearch-a2a
printf 'A2A_REPO_DIR=%s\n' "$HOME/autoresearch-a2a" > ~/.config/autoresearch-a2a/oncall.env
chmod 600 ~/.config/autoresearch-a2a/oncall.env
cp ~/autoresearch-a2a/autoresearch/oncall/autoresearch-debugger-oncall.{service,path,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now autoresearch-debugger-oncall.path autoresearch-debugger-oncall.timer
```

For persistence after SSH logout, an administrator must enable user lingering for
the `daniel` account. Do not enable the dispatcher until the unit files, path, and
service logs have been reviewed. Runtime logs live only under the owner-only broker
state directory; no task body, credential, workflow JSON, or execution payload is
written to Git.
