#!/usr/bin/env bash
set -eu

# Sequential, resumable runtime-aware Easy-100 measurement. It calls Ollama
# but never contacts n8n, creates a workflow, or runs one.

WORKTREE="${AUTORESEARCH_WORKTREE:-/home/daniel/n8n-worktrees/autoresearch-easy100}"
INPUT="${EASY100_INPUT:-/home/daniel/autoresearch-data/easy100/testing_data_low_100.jsonl}"
RESULTS="${AUTORESEARCH_RESULTS:-/home/daniel/autoresearch-data/easy100/runtime-aware-batch-$(date -u +%Y%m%dT%H%M%SZ)}"
ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT

mkdir -p "$RESULTS"
chmod 700 "$RESULTS"
chmod 600 "$ENVFILE"
git -C "$WORKTREE" fetch origin codex/autoresearch-a2a
git -C "$WORKTREE" checkout --detach FETCH_HEAD
test -r "$INPUT"
test -f "$WORKTREE/autoresearch/experiments/easy100/runRuntimeAwareEasy100Batch.js"

docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' n8n-chatbot-1 | grep '^OLLAMA_' > "$ENVFILE"
test -s "$ENVFILE"
IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"

docker run --rm --network container:n8n-chatbot-1 --read-only \
  --env-file "$ENVFILE" \
  -e EASY100_INPUT_PATH=/data/input.jsonl \
  -e EASY100_OUTPUT_DIR=/results \
  -e EASY100_LIMIT="${EASY100_LIMIT:-100}" \
  -e RUNTIME_AWARE_MODEL="${RUNTIME_AWARE_MODEL:-qwen3.8:27b}" \
  -e RUNTIME_AWARE_MAX_ATTEMPTS="${RUNTIME_AWARE_MAX_ATTEMPTS:-1}" \
  -e RUNTIME_AWARE_REASONING_EFFORT="${RUNTIME_AWARE_REASONING_EFFORT:-none}" \
  -e RUNTIME_AWARE_TIMEOUT_MS="${RUNTIME_AWARE_TIMEOUT_MS:-120000}" \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "$WORKTREE:/work:ro" \
  -v "$INPUT:/data/input.jsonl:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" \
  node /work/autoresearch/experiments/easy100/runRuntimeAwareEasy100Batch.js

printf 'REVISION=%s\n' "$(git -C "$WORKTREE" rev-parse --short HEAD)"
printf 'RESULTS_DIR=%s\n' "$RESULTS"
