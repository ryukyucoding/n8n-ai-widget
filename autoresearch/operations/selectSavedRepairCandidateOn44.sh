#!/usr/bin/env bash
set -eu

# Read-only classification of prior Easy-100 predictions. It runs no model
# and never creates or executes an n8n workflow.

WORKTREE="${AUTORESEARCH_WORKTREE:-/home/daniel/n8n-worktrees/autoresearch-easy100}"
INPUT="${EASY100_INPUT:-/home/daniel/autoresearch-data/easy100/testing_data_low_100.jsonl}"
PREDICTIONS="${EASY100_PREDICTIONS:-/home/daniel/autoresearch-data/easy100/batch-json-mode-off-20260818T083257Z/private/predictions.jsonl}"
RESULTS="${AUTORESEARCH_RESULTS:-/home/daniel/autoresearch-data/easy100/repair-candidate-selection-$(date -u +%Y%m%dT%H%M%SZ)}"

mkdir -p "$RESULTS"
chmod 700 "$RESULTS"
git -C "$WORKTREE" fetch origin codex/autoresearch-a2a
git -C "$WORKTREE" checkout --detach FETCH_HEAD
test -f "$WORKTREE/autoresearch/experiments/easy100/selectSavedRepairCandidate.js"
test -r "$INPUT"
test -r "$PREDICTIONS"
IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"

docker run --rm --network none --read-only \
  -e EASY100_INPUT_PATH=/data/input.jsonl \
  -e EASY100_PREDICTIONS_PATH=/data/predictions.jsonl \
  -e EASY100_SELECTION_OUTPUT_PATH=/results/selection-report.json \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "$WORKTREE:/work:ro" \
  -v "$INPUT:/data/input.jsonl:ro" \
  -v "$PREDICTIONS:/data/predictions.jsonl:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" \
  node /work/autoresearch/experiments/easy100/selectSavedRepairCandidate.js

printf 'REVISION=%s\n' "$(git -C "$WORKTREE" rev-parse --short HEAD)"
printf 'RESULTS_DIR=%s\n' "$RESULTS"
