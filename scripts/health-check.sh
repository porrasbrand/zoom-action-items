#!/bin/bash
#
# Health check script for Zoom Pipeline
# Exit 0 if healthy, 1 if unhealthy

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DB_PATH="$PROJECT_DIR/data/zoom-action-items.db"
LOG_DIR="$PROJECT_DIR/logs"

echo "=== Zoom Pipeline Health Check ==="

# Check 1: PM2 process running
echo -n "PM2 process: "
if pm2 describe zoom-pipeline 2>/dev/null | grep -q "status.*online"; then
    echo "OK (online)"
else
    echo "FAIL (not running)"
    exit 1
fi

# Check 2: Database exists
echo -n "Database: "
if [ -f "$DB_PATH" ]; then
    # Use node to query the database instead of sqlite3 CLI
    MEETING_COUNT=$(cd "$PROJECT_DIR" && node -e "
      import('better-sqlite3').then(m => {
        const db = new m.default('$DB_PATH');
        const result = db.prepare('SELECT COUNT(*) as count FROM meetings').get();
        console.log(result.count);
        db.close();
      }).catch(e => console.log('error'));
    " 2>/dev/null || echo "error")
    if [ "$MEETING_COUNT" != "error" ] && [ -n "$MEETING_COUNT" ]; then
        echo "OK ($MEETING_COUNT meetings)"
    else
        # Fallback: just check file exists and has size > 0
        FILE_SIZE=$(stat -c%s "$DB_PATH" 2>/dev/null || echo 0)
        if [ "$FILE_SIZE" -gt 0 ]; then
            echo "OK (file exists, ${FILE_SIZE} bytes)"
        else
            echo "FAIL (cannot access)"
            exit 1
        fi
    fi
else
    echo "WARN (no database yet - may be first run)"
fi

# Check 3: Recent log activity (within last 10 minutes)
echo -n "Recent activity: "
TODAY=$(date +%Y-%m-%d)
DAILY_LOG="$LOG_DIR/$TODAY.log"

if [ -f "$DAILY_LOG" ]; then
    LAST_LOG_TIME=$(tail -1 "$DAILY_LOG" 2>/dev/null | grep -oP '^\[\K[^\]]+' || echo "")
    if [ -n "$LAST_LOG_TIME" ]; then
        LAST_EPOCH=$(date -d "$LAST_LOG_TIME" +%s 2>/dev/null || echo 0)
        NOW_EPOCH=$(date +%s)
        AGE_SECONDS=$((NOW_EPOCH - LAST_EPOCH))
        if [ "$AGE_SECONDS" -lt 600 ]; then
            echo "OK (last log ${AGE_SECONDS}s ago)"
        else
            echo "WARN (last log ${AGE_SECONDS}s ago, >10min)"
        fi
    else
        echo "WARN (cannot parse log time)"
    fi
else
    # Check PM2 logs as fallback
    if pm2 logs zoom-pipeline --lines 1 --nostream 2>/dev/null | grep -q .; then
        echo "OK (PM2 logs present)"
    else
        echo "WARN (no logs found)"
    fi
fi

# Check 4: No recent FATAL errors in logs
echo -n "Recent errors: "
ERROR_COUNT=0
if [ -f "$DAILY_LOG" ]; then
    ERROR_COUNT=$(grep -c "FATAL" "$DAILY_LOG" 2>/dev/null || echo 0)
fi
if [ "$ERROR_COUNT" -eq 0 ]; then
    echo "OK (no FATAL errors today)"
else
    echo "WARN ($ERROR_COUNT FATAL errors in today's log)"
fi

echo "=== Health Check PASSED ==="
exit 0
