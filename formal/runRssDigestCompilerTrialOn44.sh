#!/usr/bin/env bash
set -euo pipefail

# Ephemeral research trial: creates one inactive RSS digest workflow and
# verifies n8n readback. It never replaces the formal chatbot or restarts n8n.
WORKTREE="${RUNTIME_COMPILER_WORKTREE:-/data/$USER/n8n-worktrees/runtime-compiler-integration}"
SOURCE_CHATBOT="${SOURCE_CHATBOT_CONTAINER:-n8n-chatbot-1}"
REVISION="$(git -C "$WORKTREE" rev-parse --short HEAD)"
IMAGE="n8n-chatbot-rss-digest-trial:${REVISION}"
ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT

docker inspect "$SOURCE_CHATBOT" >/dev/null
test "$(docker inspect -f '{{.State.Running}}' "$SOURCE_CHATBOT")" = "true"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SOURCE_CHATBOT" | grep '^N8N_' > "$ENVFILE"
grep -q '^N8N_API_KEY=' "$ENVFILE"
grep -q '^N8N_BASE_URL=' "$ENVFILE"

docker build --label "org.opencontainers.image.revision=${REVISION}" --tag "$IMAGE" "$WORKTREE/chatbot" >&2
docker run --rm --network "container:${SOURCE_CHATBOT}" --env-file "$ENVFILE" \
  "$IMAGE" node /app/src/rssDigestCompilerTrial.js /app/tests/daily-rss-digest-spec.json
