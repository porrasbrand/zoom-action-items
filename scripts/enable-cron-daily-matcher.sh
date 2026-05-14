#!/usr/bin/env bash
# Installs the daily AI↔PH matcher cron entry.
# IDEMPOTENT — skips if the entry is already present.
# Run AFTER user-gated review of acceptance test results.
#
#   ./scripts/enable-cron-daily-matcher.sh
#
# Removes:
#   crontab -l | grep -v 'cron-daily-matcher.sh' | crontab -

set -e
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CRON_LINE="0 3 * * * ${REPO_DIR}/scripts/cron-daily-matcher.sh"

if crontab -l 2>/dev/null | grep -qF 'cron-daily-matcher.sh'; then
  echo "[enable-cron] already installed in crontab — nothing to do"
  exit 0
fi

(crontab -l 2>/dev/null; echo "${CRON_LINE}") | crontab -
echo "[enable-cron] installed: ${CRON_LINE}"
echo "[enable-cron] verify with: crontab -l | grep cron-daily-matcher.sh"
