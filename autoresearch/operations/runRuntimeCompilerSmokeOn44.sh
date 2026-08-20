#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${AUTORESEARCH_WORKTREE:-}" ]]; then
  WORKTREE="$AUTORESEARCH_WORKTREE"
elif [[ -d "/data/$USER/autoresearch-a2a" ]]; then
  WORKTREE="/data/$USER/autoresearch-a2a"
else
  WORKTREE="$HOME/n8n-worktrees/autoresearch-easy100"
fi
RESULTS="${AUTORESEARCH_RESULTS:-$HOME/autoresearch-data/easy100/runtime-compiler-smoke-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$RESULTS"
chmod 700 "$RESULTS"

git -C "$WORKTREE" fetch origin codex/autoresearch-a2a
git -C "$WORKTREE" checkout --detach FETCH_HEAD
IMAGE="$(docker inspect -f '{{.Config.Image}}' n8n-chatbot-1)"

docker run --rm --network none --read-only \
  -e RUNTIME_COMPILER_OUTPUT_PATH=/results/runtime-compiler-smoke.json \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  -v "$WORKTREE:/work:ro" \
  -v "$RESULTS:/results" \
  -w /work/chatbot \
  "$IMAGE" node /work/autoresearch/nodewise/runRuntimeCompilerSmoke.js

printf 'REVISION=%s\n' "$(git -C "$WORKTREE" rev-parse --short HEAD)"
printf 'RESULTS_DIR=%s\n' "$RESULTS"
