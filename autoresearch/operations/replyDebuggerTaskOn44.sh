#!/usr/bin/env bash
set -euo pipefail

test "$#" -eq 2 || { echo "Usage: replyDebuggerTaskOn44.sh <task-id> <reply-file>" >&2; exit 1; }
REPO_DIR="${A2A_REPO_DIR:-/data/$USER/autoresearch-a2a}"
BROKER_ENV="${A2A_CONFIG_DIR:-$HOME/.config/autoresearch-a2a}/broker.env"
test -r "$BROKER_ENV" || { echo "missing broker environment" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$BROKER_ENV"
set +a
export A2A_BROKER_URL="${A2A_BROKER_URL:-http://127.0.0.1:8787}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(find "$HOME/.vscode-server/cli/servers" -type f -path '*/server/node' -perm -u+x 2>/dev/null | sort | tail -n 1 || true)"
fi
test -n "$NODE_BIN" || { echo "node runtime was not found" >&2; exit 1; }
cd "$REPO_DIR"
exec "$NODE_BIN" autoresearch/client/reply-task.js --task "$1" --reply "$2"
