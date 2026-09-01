#!/usr/bin/env bash
set -eu

# Runs one research-only Plan -> Create preflight on .44. The mounted source
# remains read-only; this script never contacts an n8n API or executes a
# workflow. It needs only the existing chatbot container's OLLAMA settings.

WORKTREE="${AUTORESEARCH_WORKTREE:-/home/daniel/n8n-worktrees/autoresearch-easy100}"
INPUT="${EASY100_INPUT:-/home/daniel/autoresearch-data/easy100/testing_data_low_100.jsonl}"
REQUIRED_FEATURE_REVISION="4ac8aed"
RESULTS="${AUTORESEARCH_RESULTS:-/home/daniel/autoresearch-data/easy100/plan-first-$(date -u +%Y%m%dT%H%M%SZ)}"
ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT

mkdir -p "$RESULTS"
chmod 700 "$RESULTS"
chmod 600 "$ENVFILE"

git -C "$WORKTREE" fetch origin codex/autoresearch-a2a
git -C "$WORKTREE" checkout --detach FETCH_HEAD
git -C "$WORKTREE" merge-base --is-ancestor "$REQUIRED_FEATURE_REVISION" HEAD || {
  echo "required_feature_revision_not_present" >&2
  exit 1
}

docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' n8n-chatbot-1 |
  grep '^OLLAMA_' > "$ENVFILE"
test -s "$ENVFILE"
IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"

docker run --rm --network container:n8n-chatbot-1 --read-only \
  --env-file "$ENVFILE" \
  -e PLAN_FIRST_INPUT_PATH=/data/testing_data_low_100.jsonl \
  -e PLAN_FIRST_OUTPUT_PATH=/results/plan-first-create-report.json \
  -e PLAN_FIRST_PLANNER_MODEL=qwen3.8:27b \
  -e PLAN_FIRST_PLANNER_REASONING_EFFORT=none \
  -e PLAN_FIRST_PLANNER_TIMEOUT_MS=60000 \
  -e PLAN_FIRST_CREATE_MODEL=qwen2.5-coder-32b-ft-original:latest \
  -e PLAN_FIRST_CREATE_TIMEOUT_MS=180000 \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "$WORKTREE:/work:ro" \
  -v "$INPUT:/data/testing_data_low_100.jsonl:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" \
  node /work/autoresearch/planning/runPlanFirstCreatePreflight.js

printf 'RESULTS_DIR=%s\n' "$RESULTS"
