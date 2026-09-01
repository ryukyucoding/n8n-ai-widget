# Runtime Compiler / n8n Operations Runbook

This is the operational handoff for the research branch. It is intentionally
conservative: no agent may deploy, commit, push, restore, or change `.44`
without Dan's explicit approval for that specific action.

## What Is Actually Deployed

The production host is `.44` (`widm-n8n.csie.ncu.edu.tw`). The public n8n UI
is `https://widm-n8n.csie.ncu.edu.tw`; the production chatbot container is
`n8n-chatbot-1` and publishes its internal service on port `3001`.

`formal/deployRuntimeCompilerToProductionOn44.sh` **does not rebuild, restart,
or upgrade n8n itself**. It does the following:

1. Builds a candidate chatbot image from the checked-out revision.
2. Runs the focused runtime-compiler tests inside that image.
3. Retags and retains the old chatbot image/container for automatic rollback.
4. Replaces only `n8n-chatbot-1`, retaining its existing networks and its
   existing `N8N_API_KEY` and `N8N_BASE_URL` environment values.
5. Checks `/health`, `/models`, and that the public n8n host serves `widget.js`.

Therefore, a chatbot deployment changes the widget and its backend routes. It
does not change the n8n server, its database, credentials, or already-created
workflows.

## Secrets And Safety Boundaries

- Never put SSH private keys, `N8N_API_KEY`, OpenAI/Ollama credentials, OAuth
  tokens, or `PLANNER_APPROVAL_HMAC_SECRET` in Git, A2A messages, shell history,
  screenshots, or pasted output.
- Run production commands only while logged into `.44` and only after Dan has
  explicitly approved the deployment.
- Do not use `git add -A`, `git commit -a`, `git checkout -f`, `git reset --hard`,
  or an unscoped restore. The Windows worktree can show CRLF-only false changes.
- `PLANNER_APPROVAL_HMAC_SECRET` is used to bind a reviewed plan to approval.
  Replacing it invalidates outstanding plan approvals. Do not deploy while a
  user is reviewing an existing plan.

## 1. Push A Reviewed Change From Windows

Only do this after Dan has approved both the commit and the push.

```powershell
cd C:\Users\User\Desktop\C.ai_project\2026_7_10_frontend\n8n-ai-widget-autoresearch
git add -- a2a/OPERATIONS_RUNBOOK.md
git commit -m "docs(a2a): add production operations runbook"
git push origin codex/autoresearch-a2a
```

For a different reviewed change, replace the one explicit path and commit
message. Stage every intended file path explicitly; do not broaden the command.

## 2. Prepare `.44` Without Overwriting Local Work

On `.44`, work in the production checkout:

```bash
cd ~/n8n-worktrees/runtime-compiler-integration
git status --porcelain chatbot/
```

Expected result: no output. If any path is listed, stop and preserve the output
for Dan and the agents. Do not restore it merely to make deployment proceed.

After the checkout is confirmed clean, fetch the approved branch and detach at
the fetched revision:

```bash
git fetch origin codex/autoresearch-a2a
git checkout FETCH_HEAD
git rev-parse --short HEAD
```

Record the short revision in the deployment report. `git checkout FETCH_HEAD`
is deliberate here: the remote-tracking branch might not exist locally on `.44`.

## 3. Deploy The Plan-first Chatbot On `.44`

The following is authorised only when Dan explicitly asks for a deployment.
It creates a fresh, ephemeral approval secret without printing it. Use this only
when there are no pending plan approvals.

```bash
export PLAN_FIRST_COMPILER_ENABLED=true
export PLAN_FIRST_PLANNER_MODEL=qwen3.8:27b
export PLANNER_APPROVAL_HMAC_SECRET="$(openssl rand -hex 32)"
bash formal/deployRuntimeCompilerToProductionOn44.sh
unset PLANNER_APPROVAL_HMAC_SECRET
```

Success requires all of the following in the script output:

- focused tests report zero failures;
- `revision=<expected short revision>`;
- `status=running restartCount=0` for `n8n-chatbot-1`;
- no `deployment_failed_restoring_previous_chatbot`.

The initial connection reset immediately after the container swap can be normal
if the subsequent `/health` result is `{"status":"ok"}` and the final status
line is healthy. If the script reports automatic rollback or any test failure,
stop there and retain the complete output. Do not delete the rollback container
or attempt a manual replacement.

## 4. Verify The Deployed Backend

These checks prove that the expected container, plan-first flag, and source
schema guard are live. They do not expose credentials.

```bash
curl -s http://127.0.0.1:3001/health
curl -s http://127.0.0.1:3001/models | python3 -m json.tool
docker exec -w /app n8n-chatbot-1 node tools/runPlannerCorpus.js --level compiler
```

Expected evidence:

- `/health` returns `{"status":"ok"}`.
- `/models` contains `planFirst.enabled: true` and planner model
  `qwen3.8:27b`.
- compiler corpus returns `score: "12/12"` with no failures.

For a negative source-schema check, send the saved `/albums/1` plan-review
fixture from the test/report procedure. The response must reject it with the
Chinese phrase `沒有登錄的回應 schema`; accepting it means the deployed image
does not contain the source-schema protection.

## 5. Verify A Real n8n Workflow, Not Just The Container

The real product path is:

```
user request -> constrained planner -> plan review -> approval
-> deterministic compiler -> n8n workflow creation -> manual n8n execution
```

Use the public n8n Chat panel and select **Plan-first Beta**. A verified demo
request is:

> 幫我做一個流程：抓 JSONPlaceholder 使用者 5 的基本資料，再抓他的 todo 清單，最後只要輸出他的姓名，以及還沒完成的件數。

Expected behaviour:

1. The widget shows a reviewable plan, including the limited runtime skills.
2. After explicit approval, it reports that it created a workflow.
3. Open the linked workflow in n8n.
4. In n8n, click **Execute workflow** and inspect the execution output.
5. Record the resulting `name` and `incompleteTodos`; the known user-5 result
   is `Chelsey Dietrich` and `8`.

The workflow creation request goes through the chatbot's existing private n8n
API connection (`POST /api/v1/workflows`), then reads the workflow back before
reporting success. The final manual n8n execution remains essential evidence:
a created workflow is not automatically proof that it runs correctly.

## 6. Honest Demo Boundaries

- Plan-first is a bounded compiler path, not a general natural-language n8n
  generator.
- It supports registered public sources and the implemented runtime skill
  library. Unknown source schemas are rejected.
- Requests for schedules, credentialed integrations, email delivery, arbitrary
  code, or unimplemented skills must be shown as clarification/capability-gap
  results, not forced into a workflow.
- The observed qwen3.8 planner baseline is `123/124` corpus outcomes, including
  `18/18` generalization cases; it is not a claim of 99.2% general n8n workflow
  success.

## Incident Rule

If any command differs from the expected result, stop at that step. Save the
verbatim command and complete output in an A2A message or send it to Dan. Do
not diagnose by changing production configuration, credentials, models, or
runtime schemas in place.
