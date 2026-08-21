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
NETWORK_INFO_DIR="$(mktemp -d)"
OLD_RENAMED=false
NEW_STARTED=false

cleanup() {
  rm -f "$ENVFILE"
  rm -rf "$NETWORK_INFO_DIR"
}

connect_with_saved_aliases() {
  local index="$1"
  local target="$2"
  local -a args=(docker network connect)
  while IFS= read -r alias; do
    [ -n "$alias" ] && args+=(--alias "$alias")
  done < "$NETWORK_INFO_DIR/${index}.aliases"
  args+=("${NETWORKS[$index]}" "$target")
  "${args[@]}"
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
    for index in "${!NETWORKS[@]}"; do
      connect_with_saved_aliases "$index" "$SOURCE_CHATBOT" >/dev/null 2>&1 || true
    done
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

mapfile -t NETWORKS < <(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$SOURCE_CHATBOT" | sed '/^[[:space:]]*$/d')
test "${#NETWORKS[@]}" -gt 0
for index in "${!NETWORKS[@]}"; do
  docker inspect -f "{{with index .NetworkSettings.Networks \"${NETWORKS[$index]}\"}}{{range .Aliases}}{{println .}}{{end}}{{end}}" "$SOURCE_CHATBOT" > "$NETWORK_INFO_DIR/${index}.aliases"
done
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
for index in "${!NETWORKS[@]}"; do
  docker network disconnect "${NETWORKS[$index]}" "$ROLLBACK_CONTAINER"
done

PRIMARY_NETWORK_ARGS=(--network "${NETWORKS[0]}")
while IFS= read -r alias; do
  [ -n "$alias" ] && PRIMARY_NETWORK_ARGS+=(--network-alias "$alias")
done < "$NETWORK_INFO_DIR/0.aliases"

docker run -d --name "$SOURCE_CHATBOT" --restart unless-stopped \
  "${PRIMARY_NETWORK_ARGS[@]}" --publish "${FORMAL_PORT}:3001" \
  --env-file "$ENVFILE" \
  -e PORT=3001 \
  -e RUNTIME_COMPILER_BETA_ENABLED=true \
  -e BETA_CHAT_STANDALONE=false \
  -e N8N_PUBLIC_URL="$PUBLIC_N8N_URL" \
  "$CANDIDATE_IMAGE" >/dev/null
NEW_STARTED=true
for index in "${!NETWORKS[@]}"; do
  [ "$index" -eq 0 ] || connect_with_saved_aliases "$index" "$SOURCE_CHATBOT"
done

for _ in $(seq 1 10); do
  if curl --fail --silent --show-error "http://127.0.0.1:${FORMAL_PORT}/health" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error "http://127.0.0.1:${FORMAL_PORT}/health"
curl --fail --silent --show-error "http://127.0.0.1:${FORMAL_PORT}/models" | grep -q '"compilerBeta":{"enabled":true,"standalone":false'
curl --fail --silent --show-error "${PUBLIC_N8N_URL%/}/widget.js" | grep -q 'n8n-ai-widget'

echo "revision=${REVISION}"
echo "rollback_tag=${ROLLBACK_TAG}"
echo "rollback_container=${ROLLBACK_CONTAINER}"
docker inspect -f 'status={{.State.Status}} restartCount={{.RestartCount}} image={{.Config.Image}}' "$SOURCE_CHATBOT"
