#!/usr/bin/env bash
set -eu

# Bounded Qwen tool-skill trial on three saved runtime-aware candidates. No
# n8n API, workflow creation, or execution is permitted.

WORKTREE="${AUTORESEARCH_WORKTREE:-/home/daniel/n8n-worktrees/autoresearch-easy100}"
INPUT="${EASY100_INPUT:-/home/daniel/autoresearch-data/easy100/testing_data_low_100.jsonl}"
SOURCE_RESULTS="${RUNTIME_AWARE_RESULTS:?RUNTIME_AWARE_RESULTS is required}"
PREDICTIONS="$SOURCE_RESULTS/private/runtime-aware-predictions.jsonl"
RESULTS="${AUTORESEARCH_RESULTS:-/home/daniel/autoresearch-data/easy100/authoritative-schema-skill-$(date -u +%Y%m%dT%H%M%SZ)}"
ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT

mkdir -p "$RESULTS"
chmod 700 "$RESULTS"
chmod 600 "$ENVFILE"
git -C "$WORKTREE" fetch origin codex/autoresearch-a2a
git -C "$WORKTREE" checkout --detach FETCH_HEAD
test -r "$INPUT"
test -r "$PREDICTIONS"

docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' n8n-chatbot-1 | grep '^OLLAMA_' > "$ENVFILE"
test -s "$ENVFILE"
IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"

docker run --rm --network container:n8n-chatbot-1 --read-only \
  --env-file "$ENVFILE" \
  -e EASY100_INPUT_PATH=/data/input.jsonl \
  -e RUNTIME_AWARE_PREDICTIONS_PATH=/data/predictions.jsonl \
  -e SCHEMA_REPAIR_OUTPUT_DIR=/results \
  -e SCHEMA_REPAIR_CASE_IDS="${SCHEMA_REPAIR_CASE_IDS:-0,1,2}" \
  -e SCHEMA_REPAIR_MODEL=qwen3.8:27b \
  -e SCHEMA_REPAIR_REASONING_EFFORT=none \
  -e SCHEMA_REPAIR_MAX_TOOL_ROUNDS=4 \
  -e SCHEMA_REPAIR_TIMEOUT_MS=120000 \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "$WORKTREE:/work:ro" \
  -v "$INPUT:/data/input.jsonl:ro" \
  -v "$PREDICTIONS:/data/predictions.jsonl:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" \
  node /work/autoresearch/experiments/easy100/runAuthoritativeSchemaRepairSmoke.js

printf 'REVISION=%s\n' "$(git -C "$WORKTREE" rev-parse --short HEAD)"
printf 'RESULTS_DIR=%s\n' "$RESULTS"
