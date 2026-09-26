#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
LOG="results/cloud/logs/batch-$(date +%Y%m%d-%H%M%S).log"
echo "Logging to $LOG"
{
  echo "=== delete 100 === $(date -Iseconds)"
  node run_cloud.mjs --operation delete --limit 100 --force
  echo "=== insert 100 === $(date -Iseconds)"
  node run_cloud.mjs --operation insert --limit 100 --force
  echo "=== score === $(date -Iseconds)"
  npm run score
  echo "=== report === $(date -Iseconds)"
  npm run report:cloud
  echo "=== done === $(date -Iseconds)"
} 2>&1 | tee "$LOG"
