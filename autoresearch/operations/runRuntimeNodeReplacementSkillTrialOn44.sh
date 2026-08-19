#!/usr/bin/env bash
set -eu

# One bounded semantic replacement skill trial. It reaches Ollama only.

WORKTREE="${AUTORESEARCH_WORKTREE:-/home/daniel/n8n-worktrees/autoresearch-easy100}"
RESULTS="${AUTORESEARCH_RESULTS:-/home/daniel/autoresearch-data/runtime-node-replacement-$(date -u +%Y%m%dT%H%M%SZ)}"
ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT

mkdir -p "$RESULTS"
chmod 700 "$RESULTS"
chmod 600 "$ENVFILE"
git -C "$WORKTREE" fetch origin codex/autoresearch-a2a
git -C "$WORKTREE" checkout --detach FETCH_HEAD
test -f "$WORKTREE/autoresearch/agent/runRuntimeNodeReplacementSkillTrial.js"

docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' n8n-chatbot-1 | grep '^OLLAMA_' > "$ENVFILE"
test -s "$ENVFILE"
IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"

docker run --rm --network container:n8n-chatbot-1 --read-only \
  --env-file "$ENVFILE" \
  -e RUNTIME_REPLACEMENT_SKILL_OUTPUT_PATH=/results/runtime-node-replacement-report.json \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "$WORKTREE:/work:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" \
  node /work/autoresearch/agent/runRuntimeNodeReplacementSkillTrial.js

printf 'REVISION=%s\n' "$(git -C "$WORKTREE" rev-parse --short HEAD)"
printf 'RESULTS_DIR=%s\n' "$RESULTS"
