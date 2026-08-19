#!/usr/bin/env bash
set -eu

# One bounded Qwen3.8 workflow-engineer experiment on .44. It calls Ollama
# only, keeps the mounted source read-only, and never calls n8n.

WORKTREE="${AUTORESEARCH_WORKTREE:-/home/daniel/n8n-worktrees/autoresearch-easy100}"
INPUT="${EASY100_INPUT:-/home/daniel/autoresearch-data/easy100/testing_data_low_100.jsonl}"
RESULTS="${AUTORESEARCH_RESULTS:-/home/daniel/autoresearch-data/easy100/runtime-agent-$(date -u +%Y%m%dT%H%M%SZ)}"
MAX_ATTEMPTS="${AGENT_PREFLIGHT_MAX_ATTEMPTS:-1}"
REASONING_EFFORT="${AGENT_PREFLIGHT_REASONING_EFFORT:-none}"
CASE_INDEX="${AGENT_PREFLIGHT_CASE_INDEX:-0}"
ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT

mkdir -p "$RESULTS"
chmod 700 "$RESULTS"
chmod 600 "$ENVFILE"

git -C "$WORKTREE" fetch origin codex/autoresearch-a2a
git -C "$WORKTREE" checkout --detach FETCH_HEAD
test -f "$WORKTREE/autoresearch/agent/runRuntimeAwareWorkflowAgent.js" || {
  echo "runtime_agent_runner_not_present" >&2
  exit 1
}

docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' n8n-chatbot-1 |
  grep '^OLLAMA_' > "$ENVFILE"
test -s "$ENVFILE"
IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"

docker run --rm --network container:n8n-chatbot-1 --read-only \
  --env-file "$ENVFILE" \
  -e AGENT_PREFLIGHT_INPUT_PATH=/data/testing_data_low_100.jsonl \
  -e AGENT_PREFLIGHT_OUTPUT_PATH=/results/runtime-agent-report.json \
  -e AGENT_PREFLIGHT_MODEL=qwen3.8:27b \
  -e AGENT_PREFLIGHT_CASE_INDEX="$CASE_INDEX" \
  -e AGENT_PREFLIGHT_MAX_ATTEMPTS="$MAX_ATTEMPTS" \
  -e AGENT_PREFLIGHT_REASONING_EFFORT="$REASONING_EFFORT" \
  -e AGENT_PREFLIGHT_TIMEOUT_MS=180000 \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "$WORKTREE:/work:ro" \
  -v "$INPUT:/data/testing_data_low_100.jsonl:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" \
  node /work/autoresearch/agent/runRuntimeAwareWorkflowAgent.js

printf 'REVISION=%s\n' "$(git -C "$WORKTREE" rev-parse --short HEAD)"
printf 'RESULTS_DIR=%s\n' "$RESULTS"
