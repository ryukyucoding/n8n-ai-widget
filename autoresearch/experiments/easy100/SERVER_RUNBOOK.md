# Run Easy-100 on `.44`

Run these blocks in order from the lab workstation. Each fenced block is one
pasteable PowerShell command block. The process never invokes the n8n API; it
only calls the configured Create-model endpoint and runs local static checks.

## 1. Send the public input descriptions to `.44`

```powershell
$key = "$env:USERPROFILE\.ssh\id_ed25519_autoresearch_lab"
$source = "C:\Users\danie\Desktop\C.ai_project\workflow_template\S1_ft_original_description\testing_data_low_100.jsonl"
ssh -i $key -o IdentitiesOnly=yes daniel@140.115.54.44 "mkdir -p /home/daniel/autoresearch-data/easy100"
scp -i $key -o IdentitiesOnly=yes $source daniel@140.115.54.44:/home/daniel/autoresearch-data/easy100/testing_data_low_100.jsonl
```

## 2. Prepare an isolated worktree on `.44`

```powershell
$key = "$env:USERPROFILE\.ssh\id_ed25519_autoresearch_lab"
ssh -i $key -o IdentitiesOnly=yes daniel@140.115.54.44 @'
set -eu
repo=/home/daniel/n8n-ai-widget
worktree=/home/daniel/n8n-worktrees/autoresearch-easy100
git -C "$repo" fetch origin codex/autoresearch-a2a
if [ ! -d "$worktree/.git" ]; then
  git -C "$repo" worktree add "$worktree" origin/codex/autoresearch-a2a
fi
git -C "$worktree" status --short
'@
```

## 3. Run the batch in a disposable container

The temporary env file receives **only** the existing container's `OLLAMA_`
variables. It is mode 600 and removed through the shell trap. Predictions stay
in the private result directory and are not printed.

```powershell
$key = "$env:USERPROFILE\.ssh\id_ed25519_autoresearch_lab"
ssh -i $key -o IdentitiesOnly=yes daniel@140.115.54.44 @'
set -eu
worktree=/home/daniel/n8n-worktrees/autoresearch-easy100
input=/home/daniel/autoresearch-data/easy100/testing_data_low_100.jsonl
results=/home/daniel/autoresearch-data/easy100/results-$(date -u +%Y%m%dT%H%M%SZ)
envfile=$(mktemp)
trap 'rm -f "$envfile"' EXIT
chmod 600 "$envfile"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' n8n-chatbot-1 | grep '^OLLAMA_' > "$envfile"
test -s "$envfile"
docker run --rm --network container:n8n-chatbot-1 --read-only \
  --env-file "$envfile" \
  -e EASY100_INPUT_PATH=/data/testing_data_low_100.jsonl \
  -e EASY100_OUTPUT_DIR=/results \
  -e EASY100_TIMEOUT_MS=180000 \
  -e PYTHON_BIN=python3 \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m \
  -v "$worktree:/work:ro" \
  -v "$input:/data/testing_data_low_100.jsonl:ro" \
  -v "$results:/results" \
  -w /work/chatbot \
  n8n-chatbot:latest \
  node /work/autoresearch/experiments/easy100/runEasy100Batch.js
python3 - <<PY
import json
p='$results/execution-readiness-report.json'
r=json.load(open(p))
print(json.dumps({'status':r['status'], 'aggregate':r['aggregate']}, ensure_ascii=False))
PY
printf 'RESULTS_DIR=%s\n' "$results"
'@
```

If the runner stops after two availability failures, retain the partial report;
do not rerun automatically. That result diagnoses model route availability,
not workflow quality.
