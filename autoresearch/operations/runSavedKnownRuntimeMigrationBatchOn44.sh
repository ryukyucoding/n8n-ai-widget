#!/usr/bin/env bash
set -eu

# Offline aggregate: saved predictions only, with no model, n8n API, create, or execution.
WORKTREE="${AUTORESEARCH_WORKTREE:-/home/daniel/n8n-worktrees/autoresearch-easy100}"
INPUT="${EASY100_INPUT:-/home/daniel/autoresearch-data/easy100/testing_data_low_100.jsonl}"
PREDICTIONS="${EASY100_PREDICTIONS:-/home/daniel/autoresearch-data/easy100/batch-json-mode-off-20260818T083257Z/private/predictions.jsonl}"
RESULTS="${AUTORESEARCH_RESULTS:-/home/daniel/autoresearch-data/easy100/known-runtime-migration-batch-$(date -u +%Y%m%dT%H%M%SZ)}"

mkdir -p "$RESULTS"
chmod 700 "$RESULTS"
git -C "$WORKTREE" fetch origin codex/autoresearch-a2a
git -C "$WORKTREE" checkout --detach FETCH_HEAD
test -r "$INPUT"
test -r "$PREDICTIONS"

IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"
docker run --rm --network none --read-only \
  -e EASY100_INPUT_PATH=/data/input.jsonl \
  -e EASY100_PREDICTIONS_PATH=/data/predictions.jsonl \
  -e EASY100_MIGRATION_BATCH_OUTPUT_PATH=/results/migration-batch-report.json \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "$WORKTREE:/work:ro" \
  -v "$INPUT:/data/input.jsonl:ro" \
  -v "$PREDICTIONS:/data/predictions.jsonl:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" \
  node /work/autoresearch/experiments/easy100/runSavedKnownRuntimeMigrationBatch.js

printf 'REVISION=%s\n' "$(git -C "$WORKTREE" rev-parse --short HEAD)"
printf 'RESULTS_DIR=%s\n' "$RESULTS"
