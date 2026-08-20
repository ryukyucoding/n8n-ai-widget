#!/usr/bin/env bash
set -euo pipefail

WORKTREE="${AUTORESEARCH_WORKTREE:-/data/$USER/autoresearch-a2a}"
RESULTS="${AUTORESEARCH_RESULTS:-$HOME/autoresearch-data/easy100/todo-compiler-smoke-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$RESULTS"
chmod 700 "$RESULTS"

git -C "$WORKTREE" fetch origin codex/autoresearch-a2a
git -C "$WORKTREE" checkout --detach FETCH_HEAD
IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"

docker run --rm --network none --read-only \
  -e TODO_COMPILER_OUTPUT_PATH=/results/todo-compiler-smoke.json \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  -v "$WORKTREE:/work:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" node /work/autoresearch/nodewise/runTodoCompilerSmoke.js

printf 'REVISION=%s\n' "$(git -C "$WORKTREE" rev-parse --short HEAD)"
printf 'RESULTS_DIR=%s\n' "$RESULTS"
