#!/usr/bin/env bash
set -euo pipefail

# Submit a bounded planning-only trial. It never starts a model, n8n, or a
# workflow; the interactive .44 Codex session consumes the submitted tasks.
REPO_DIR="${A2A_REPO_DIR:-$HOME/n8n-worktrees/autoresearch-easy100}"
INPUT_PATH="${EASY100_INPUT_PATH:-$HOME/autoresearch-data/easy100/testing_data_low_100.jsonl}"
TASK_DIR="${NODEWISE_TASK_DIR:-$HOME/autoresearch-data/easy100/nodewise-intent-tasks-$(date -u +%Y%m%dT%H%M%SZ)}"
BROKER_ENV="${A2A_CONFIG_DIR:-$HOME/.config/autoresearch-a2a}/broker.env"

test -r "$BROKER_ENV" || { echo "missing broker environment" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$BROKER_ENV"
set +a
export A2A_BROKER_URL="${A2A_BROKER_URL:-http://127.0.0.1:8787}"

cd "$REPO_DIR"
node autoresearch/nodewise/createEasy100IntentTasks.js --input "$INPUT_PATH" --output "$TASK_DIR" --limit "${NODEWISE_LIMIT:-5}"
for request in "$TASK_DIR"/task-*.json; do
  node autoresearch/client/task-client.js --request "$request" >/dev/null
done
printf 'TASK_DIR=%s\n' "$TASK_DIR"
printf 'NEXT=.44 Codex should run node autoresearch/client/debugger-inbox.js and reply to each nodewise_intent_plan task.\n'
