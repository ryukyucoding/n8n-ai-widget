#!/usr/bin/env bash
set -eu

# Bounded 3-case Plan -> Create diagnosis. It calls Ollama only and never
# creates or executes an n8n workflow.

WORKTREE="${AUTORESEARCH_WORKTREE:-/home/daniel/n8n-worktrees/autoresearch-easy100}"
INPUT="${EASY100_INPUT:-/home/daniel/autoresearch-data/easy100/testing_data_low_100.jsonl}"
RESULTS="${AUTORESEARCH_RESULTS:-/home/daniel/autoresearch-data/easy100/plan-first-smoke-$(date -u +%Y%m%dT%H%M%SZ)}"
ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT
mkdir -p "$RESULTS"
chmod 700 "$RESULTS"
chmod 600 "$ENVFILE"

git -C "$WORKTREE" fetch origin codex/autoresearch-a2a
git -C "$WORKTREE" checkout --detach FETCH_HEAD
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' n8n-chatbot-1 | grep '^OLLAMA_' > "$ENVFILE"
test -s "$ENVFILE"
IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"

docker run --rm --network container:n8n-chatbot-1 --read-only \
  --env-file "$ENVFILE" \
  -e PLAN_FIRST_INPUT_PATH=/data/input.jsonl \
  -e PLAN_FIRST_OUTPUT_DIR=/results \
  -e PLAN_FIRST_CASE_INDICES="${PLAN_FIRST_CASE_INDICES:-0,1,2}" \
  -e PLAN_FIRST_PLANNER_MODEL=qwen3.8:27b \
  -e PLAN_FIRST_PLANNER_REASONING_EFFORT=none \
  -e PLAN_FIRST_PLANNER_TIMEOUT_MS=60000 \
  -e PLAN_FIRST_CREATE_MODEL=qwen2.5-coder-32b-ft-original:latest \
  -e PLAN_FIRST_CREATE_TIMEOUT_MS=180000 \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "$WORKTREE:/work:ro" \
  -v "$INPUT:/data/input.jsonl:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" \
  node /work/autoresearch/planning/runPlanFirstCreateSmoke.js

printf 'REVISION=%s\n' "$(git -C "$WORKTREE" rev-parse --short HEAD)"
printf 'RESULTS_DIR=%s\n' "$RESULTS"
