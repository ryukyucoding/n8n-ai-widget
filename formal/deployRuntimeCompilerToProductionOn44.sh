#!/usr/bin/env bash
set -euo pipefail

# Replaces only the chatbot container after candidate tests pass. It does not
# rebuild or restart n8n, and retains the previous chatbot as a rollback
# container and image tag.
WORKTREE="${RUNTIME_COMPILER_WORKTREE:-/data/$USER/n8n-worktrees/runtime-compiler-integration}"
SOURCE_CHATBOT="${SOURCE_CHATBOT_CONTAINER:-n8n-chatbot-1}"
FORMAL_PORT="${FORMAL_CHATBOT_PORT:-3001}"
PUBLIC_N8N_URL="${N8N_PUBLIC_URL:-https://widm-n8n.csie.ncu.edu.tw}"
REVISION="$(git -C "$WORKTREE" rev-parse --short HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CANDIDATE_IMAGE="n8n-chatbot-runtime-compiler:${REVISION}"
ROLLBACK_TAG="n8n-chatbot:rollback-runtime-compiler-${REVISION}-${STAMP}"
ROLLBACK_CONTAINER="${SOURCE_CHATBOT}-rollback-${STAMP}"
ENVFILE="$(mktemp)"
OLD_RENAMED=false
NEW_STARTED=false

cleanup() {
  rm -f "$ENVFILE"
}

rollback_on_error() {
  local status=$?
  trap - ERR
  if [ "$OLD_RENAMED" = true ]; then
    echo "deployment_failed_restoring_previous_chatbot"
    if [ "$NEW_STARTED" = true ]; then
      docker rm -f "$SOURCE_CHATBOT" >/dev/null 2>&1 || true
    fi
    docker rename "$ROLLBACK_CONTAINER" "$SOURCE_CHATBOT" >/dev/null 2>&1 || true
    docker start "$SOURCE_CHATBOT" >/dev/null 2>&1 || true
  fi
  cleanup
  exit "$status"
}

trap cleanup EXIT
trap rollback_on_error ERR

test -d "$WORKTREE/chatbot"
docker inspect "$SOURCE_CHATBOT" >/dev/null
test "$(docker inspect -f '{{.State.Running}}' "$SOURCE_CHATBOT")" = "true"

NETWORK="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$SOURCE_CHATBOT" | head -n 1)"
test -n "$NETWORK"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SOURCE_CHATBOT" > "$ENVFILE"
grep -q '^N8N_API_KEY=' "$ENVFILE"
grep -q '^N8N_BASE_URL=' "$ENVFILE"

docker build --label "org.opencontainers.image.revision=${REVISION}" --tag "$CANDIDATE_IMAGE" "$WORKTREE/chatbot"
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --entrypoint node "$CANDIDATE_IMAGE" --test \
  /app/src/runtimeCompilerBeta.test.js \
  /app/src/chatProgress.test.js \
  /app/src/workflowCreatePayload.test.js

OLD_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$SOURCE_CHATBOT")"
docker tag "$OLD_IMAGE" "$ROLLBACK_TAG"
docker stop "$SOURCE_CHATBOT"
docker rename "$SOURCE_CHATBOT" "$ROLLBACK_CONTAINER"
OLD_RENAMED=true

docker run -d --name "$SOURCE_CHATBOT" --restart unless-stopped \
  --network "$NETWORK" --publish "${FORMAL_PORT}:3001" \
  --env-file "$ENVFILE" \
  -e PORT=3001 \
  -e RUNTIME_COMPILER_BETA_ENABLED=true \
  -e BETA_CHAT_STANDALONE=false \
  -e N8N_PUBLIC_URL="$PUBLIC_N8N_URL" \
  "$CANDIDATE_IMAGE" >/dev/null
NEW_STARTED=true

for _ in $(seq 1 10); do
  if curl --fail --silent --show-error "http://127.0.0.1:${FORMAL_PORT}/health" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error "http://127.0.0.1:${FORMAL_PORT}/health"
curl --fail --silent --show-error "http://127.0.0.1:${FORMAL_PORT}/models" | grep -q '"compilerBeta":{"enabled":true,"standalone":false'

echo "revision=${REVISION}"
echo "rollback_tag=${ROLLBACK_TAG}"
echo "rollback_container=${ROLLBACK_CONTAINER}"
docker inspect -f 'status={{.State.Status}} restartCount={{.RestartCount}} image={{.Config.Image}}' "$SOURCE_CHATBOT"
