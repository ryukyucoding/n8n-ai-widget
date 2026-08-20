#!/usr/bin/env bash
set -eu

# Offline analysis of a completed runtime-aware batch. It reads private
# candidates but emits only de-identified aggregate runtime findings.

WORKTREE="${AUTORESEARCH_WORKTREE:-/home/daniel/n8n-worktrees/autoresearch-easy100}"
INPUT="${EASY100_INPUT:-/home/daniel/autoresearch-data/easy100/testing_data_low_100.jsonl}"
if [ -n "${RUNTIME_AWARE_RESULTS:-}" ]; then
  RESULTS="$RUNTIME_AWARE_RESULTS"
else
  RESULTS="$(ls -dt \
    /home/daniel/autoresearch-data/easy100/runtime-aware-batch-platform-filter-* \
    /home/daniel/autoresearch-data/easy100/runtime-aware-batch-* 2>/dev/null | head -1 || true)"
fi
test -n "$RESULTS"
PREDICTIONS="$RESULTS/private/runtime-aware-predictions.jsonl"

git -C "$WORKTREE" fetch origin codex/autoresearch-a2a
git -C "$WORKTREE" checkout --detach FETCH_HEAD
test -r "$INPUT"
test -r "$PREDICTIONS"

IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"
docker run --rm --network none --read-only \
  -e EASY100_INPUT_PATH=/data/input.jsonl \
  -e RUNTIME_AWARE_PREDICTIONS_PATH=/data/predictions.jsonl \
  -e RUNTIME_AWARE_SUMMARY_OUTPUT_PATH=/results/offline-finding-summary.json \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "$WORKTREE:/work:ro" \
  -v "$INPUT:/data/input.jsonl:ro" \
  -v "$PREDICTIONS:/data/predictions.jsonl:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" \
  node /work/autoresearch/experiments/easy100/summarizeRuntimeAwareBatch.js

printf 'REVISION=%s\n' "$(git -C "$WORKTREE" rev-parse --short HEAD)"
printf 'SOURCE_RESULTS=%s\n' "$RESULTS"
printf 'RESULTS_DIR=%s\n' "$RESULTS"
