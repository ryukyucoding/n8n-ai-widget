# Lab Workstation Runbook

## Role for This Sprint

The lab workstation starts as the `experiment-engineer`. It is a bounded worker for
offline checks, not an unattended general-purpose model agent.

```text
allowed by default:  light task, approved offline cpu-bound task
requires approval:   model call, network, n8n API, workflow action, deployment
not allowed:         credentials, token copying, automatic retries
```

## Before Connecting It

Collect these facts and send only the non-secret values to the orchestrator:

```text
OS and version
whether Codex CLI is available
whether Antigravity is available
repository checkout path and current Git revision
available RAM / disk space
whether an SSH client is available
```

Do not send API keys, OAuth cookies, broker tokens, or private SSH key contents.

## Safe Connection Design

The broker remains bound to `127.0.0.1` on `.44`. The lab workstation must use an
authenticated SSH tunnel or a future dedicated relay. It also needs its own scoped,
revocable broker identity; the server's existing bearer token must remain server-only.

The scoped-token support is present in the reviewed source, but the running `.44`
broker must be updated before this workstation is authorized to submit or consume a
task independently. Until that deployment is complete, it may prepare local evidence
under direct user control only.

## Connect After Broker Approval

The lab machine does not expose a port or receive the server's legacy token. Instead,
keep one SSH tunnel window open and use the lab-specific role token only in the local
PowerShell process:

```powershell
ssh -N -L 8787:127.0.0.1:8787 -i "$env:USERPROFILE\.ssh\id_ed25519_n8n_a2a" `
  -o IdentitiesOnly=yes daniel@140.115.54.44
```

In a second PowerShell window, the human stores the issued `experiment-engineer`
token outside Git and sets only the runtime variables below. Do not paste the token
into chat, a task file, source code, or a command argument.

```powershell
$env:A2A_BROKER_URL = 'http://127.0.0.1:8787'
$env:A2A_AGENT_ID = 'experiment-engineer'
$env:A2A_BROKER_TOKEN = '<lab-specific token entered locally>'
node autoresearch/client/task-status.js
```

The command prints only task IDs, role ownership, state, host, resource class, and
timestamps. It intentionally omits task instructions, replies, artifact paths, and
credential data.

When an approved `light` task is visible, the lab operator may inspect its sanitized
instruction and publish a local file-backed reply. These commands do not launch a
model or call n8n:

```powershell
node autoresearch/client/agent-inbox.js
Set-Content -NoNewline .\a2a-reply.txt 'Completed the declared offline check; no n8n operation was performed.'
node autoresearch/client/complete-task.js --task <task-id> --reply .\a2a-reply.txt
```

## What the User Will Monitor

There are three independent signals:

| Signal | Where to inspect | Meaning |
| --- | --- | --- |
| Broker task state | `node autoresearch/client/task-status.js` | Who owns the task and whether it is submitted, working, waiting, or complete; task text and artifact paths are deliberately omitted |
| Server debugger | `.44` systemd path/timer and dispatcher log | Whether the on-call debugger is awake, deferred, or finished |
| Lab worker | Future lab worker log plus local process status | Whether a bounded local task has started or ended |

Current `.44` server checks are:

```bash
systemctl --user status autoresearch-debugger-oncall.path
systemctl --user status autoresearch-debugger-oncall.timer
tail -f ~/.local/state/autoresearch-a2a/oncall/dispatcher.log
```

`deferred_interactive_codex_active` is healthy behavior: it means the on-call worker
detected a human using Codex and deliberately did not compete for resources.

## Low-Load Policy

- The broker is event-driven. It does not run a model while no matching task exists.
- A 15-minute fallback check only handles a task deferred by interactive use; it
  exits immediately if there is no allowed work.
- One host may have only one `cpu-bound`, `model-inference`, or `n8n-operation`
  task in `working` state.
- The lab worker must use a single-process lock, low process priority, a wall-clock
  timeout, and a final sanitized status report.

## First Acceptance Test

After a scoped identity and monitor exist, run only this test:

```text
Task: inspect a repository-relative, sanitized fixture manifest and report whether
      required fields are present.
Inputs: a Git revision and file digest only.
Expected result: submitted -> working -> completed; no model, no network, no n8n.
```

Only after this succeeds should we authorize one approved offline evaluation task.
