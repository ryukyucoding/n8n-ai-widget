# Runtime Compiler Beta Deployment

This directory deploys a separate beta chatbot. It does not replace, rebuild,
restart, or modify the existing `ollama-widget` deployment.

The beta chat has two Create paths:

1. **Fine-tuned Create** uses the existing `/generate` route and configured
   Create model.
2. **Runtime Compiler Beta** does not call a model. It accepts only two tested
   public-data patterns: JSONPlaceholder Todo summary and Twitch channel
   `twitch` live status. Any other request is rejected before n8n Create.

## Preconditions

- The server has a clean checkout of `codex/runtime-compiler-integration`.
- The existing `n8n-chatbot-1` container is running and has a working n8n API
  key and network connection.
- The beta tester can establish an SSH tunnel to the server. The container is
  bound only to the server loopback interface and is not publicly exposed.

## Deployment

Run only after a candidate image test and explicit deployment approval:

```bash
cd /data/daniel/n8n-worktrees/runtime-compiler-integration
bash beta/deployBetaChatbotOn44.sh
```

The script refuses to replace an existing `n8n-chatbot-beta` container. It
builds `n8n-chatbot-runtime-compiler-beta:latest`, joins the existing chatbot
network, publishes loopback port `3002`, and verifies `/health` locally.

From a test workstation, open a tunnel in a separate terminal:

```powershell
ssh -L 3002:127.0.0.1:3002 daniel@140.115.54.44
```

Then open `http://127.0.0.1:3002/chat` in the browser.

## User Tests

- Fine-tuned Create: use the existing type of natural-language Create request.
- Runtime Compiler Beta Todo: `Retrieve public JSONPlaceholder user and todo
  data, then return a todo summary.`
- Runtime Compiler Beta Twitch: `Check Twitch channel twitch live status.`

The created workflows are inactive. Execute them manually in n8n and retain
the workflow/execution URLs as evidence.
