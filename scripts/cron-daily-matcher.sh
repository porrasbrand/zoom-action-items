#!/usr/bin/env bash
# Daily AI↔PH matcher cron entry. STAGED — NOT yet installed in crontab.
# Install via scripts/enable-cron-daily-matcher.sh after user-gated review.
#
# Recommended schedule: 03:00 UTC daily, after overnight Zoom ingestion.
# Logs to logs/daily-matcher.log; rotate via logrotate later.

set -e
cd "$(dirname "$0")/.."

LOG_FILE="logs/daily-matcher.log"
mkdir -p logs

{
  echo "===== daily-matcher run @ $(date -u +%FT%TZ) ====="
  node scripts/run-matcher.mjs --client echelon
  echo "===== end @ $(date -u +%FT%TZ) ====="
  echo ""
} >> "$LOG_FILE" 2>&1
