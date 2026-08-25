#!/usr/bin/env bash
set -euo pipefail

# Deploys a separate beta container. It never replaces n8n-chatbot-1.
WORKTREE="${BETA_WORKTREE:-/data/$USER/n8n-worktrees/runtime-compiler-integration}"
SOURCE_CHATBOT="${SOURCE_CHATBOT_CONTAINER:-n8n-chatbot-1}"
BETA_CONTAINER="${BETA_CONTAINER:-n8n-chatbot-beta}"
BETA_IMAGE="${BETA_IMAGE:-n8n-chatbot-runtime-compiler-beta:latest}"
BETA_PORT="${BETA_PORT:-3002}"
PUBLIC_N8N_URL="${N8N_PUBLIC_URL:-https://widm-n8n.csie.ncu.edu.tw}"
ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT

test -d "$WORKTREE/chatbot"
if docker inspect "$BETA_CONTAINER" >/dev/null 2>&1; then
  echo "beta_container_already_exists"
  exit 1
fi

NETWORK="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$SOURCE_CHATBOT" | head -n 1)"
test -n "$NETWORK"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SOURCE_CHATBOT" |
  grep -E '^(N8N_|OLLAMA_|CREATE_MODELS=|OPENAI_|HTTP_PROXY=|HTTPS_PROXY=|ALL_PROXY=|NO_PROXY=|http_proxy=|https_proxy=|all_proxy=|no_proxy=)' > "$ENVFILE" || true
grep -q '^N8N_API_KEY=' "$ENVFILE"
grep -q '^N8N_BASE_URL=' "$ENVFILE"

docker build --tag "$BETA_IMAGE" "$WORKTREE/chatbot"
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --entrypoint node "$BETA_IMAGE" --test \
  /app/src/runtimeCompilerBeta.test.js \
  /app/src/chatProgress.test.js \
  /app/src/workflowCreatePayload.test.js
docker run -d --name "$BETA_CONTAINER" --restart unless-stopped \
  --network "$NETWORK" --publish "127.0.0.1:${BETA_PORT}:3001" \
  --env-file "$ENVFILE" \
  -e PORT=3001 \
  -e RUNTIME_COMPILER_BETA_ENABLED=true \
  -e BETA_CHAT_STANDALONE=true \
  -e N8N_PUBLIC_URL="$PUBLIC_N8N_URL" \
  "$BETA_IMAGE"

sleep 2
docker inspect -f 'status={{.State.Status}} restartCount={{.RestartCount}} image={{.Config.Image}}' "$BETA_CONTAINER"
curl --fail --silent --show-error "http://127.0.0.1:${BETA_PORT}/health"
printf 'BETA_URL=http://127.0.0.1:%s/chat (use an SSH tunnel from the test workstation)\n' "$BETA_PORT"
