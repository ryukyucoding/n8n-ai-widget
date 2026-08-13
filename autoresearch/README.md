# AutoResearch A2A Task Handoff

`autoresearch/` is the communication layer for the next research phase: generating
and validating n8n workflows from natural-language requests. It gives up to five
agents a shared, durable task record without requiring them to share private chat
history.

This implementation is deliberately small and dependency-free. It follows the
important A2A ideas -- Agent Cards, Tasks, Messages, and JSON-RPC `SendMessage` --
but is **not a complete or certified implementation of the A2A protocol**. Before
opening it outside a trusted network, replace the local bearer token with real
authentication and transport protection.

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
- The broker starts on `127.0.0.1` by default. Binding to another interface requires
  `A2A_BROKER_TOKEN`; place that value only in the process environment.
- A task message is a coordination record, not authorization to call a model,
  create/execute/delete an n8n workflow, deploy, or use the network.
- The broker does not invoke Codex, Antigravity, or .44 automatically. A heartbeat
  or human operator dispatches the assigned task on the appropriate machine.

## Run locally

```powershell
node autoresearch/broker/server.js
node --test autoresearch/tests/*.test.js
```

The default endpoint is `http://127.0.0.1:8787`. It serves the facilitator card at
`/.well-known/agent-card.json` and individual role cards at
`/agents/<agent-id>/.well-known/agent-card.json`.

For a trusted shared host only:

```powershell
$env:A2A_BROKER_TOKEN = '<secret stored outside Git>'
$env:A2A_BROKER_HOST = '0.0.0.0'
node autoresearch/broker/server.js
```

## Minimal message flow

1. `orchestrator` sends `SendMessage` with a safe instruction and `assigneeAgentId`.
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

