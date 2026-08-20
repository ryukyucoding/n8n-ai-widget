#!/usr/bin/env bash
set -euo pipefail

WORKTREE="${AUTORESEARCH_WORKTREE:-/data/$USER/autoresearch-a2a}"
RESULTS="${AUTORESEARCH_RESULTS:-$HOME/autoresearch-data/easy100/c07-compiler-provision-$(date -u +%Y%m%dT%H%M%SZ)}"
ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT
mkdir -p "$RESULTS"
chmod 700 "$RESULTS"
chmod 600 "$ENVFILE"

docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' n8n-chatbot-1 | grep '^N8N_' > "$ENVFILE"
grep -q '^N8N_API_KEY=' "$ENVFILE"
grep -q '^N8N_BASE_URL=' "$ENVFILE"
IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"

docker run --rm --network container:n8n-chatbot-1 --read-only \
  --env-file "$ENVFILE" \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  -v "$WORKTREE:/work:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" node /work/autoresearch/nodewise/provisionC07CompilerWorkflow.js | tee "$RESULTS/provisioning-report.json"

printf 'REVISION=%s\n' "$(git -C "$WORKTREE" rev-parse --short HEAD)"
printf 'RESULTS_DIR=%s\n' "$RESULTS"
