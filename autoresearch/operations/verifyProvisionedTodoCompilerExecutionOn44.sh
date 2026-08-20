#!/usr/bin/env bash
set -euo pipefail

: "${WORKFLOW_ID:?WORKFLOW_ID is required}"
: "${EXECUTION_ID:?EXECUTION_ID is required}"
WORKTREE="${AUTORESEARCH_WORKTREE:-/data/$USER/autoresearch-a2a}"
ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT
chmod 600 "$ENVFILE"

docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' n8n-chatbot-1 | grep '^N8N_' > "$ENVFILE"
grep -q '^N8N_API_KEY=' "$ENVFILE"
grep -q '^N8N_BASE_URL=' "$ENVFILE"
IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"

docker run --rm --network container:n8n-chatbot-1 --read-only \
  --env-file "$ENVFILE" \
  -e WORKFLOW_ID -e EXECUTION_ID \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -v "$WORKTREE:/work:ro" \
  -w /work/chatbot \
  "$IMAGE" node /work/autoresearch/nodewise/verifyProvisionedTodoExecution.js
