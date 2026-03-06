#!/bin/sh
# Delete recording directories older than 14 days
echo "[cleanup] Running cleanup at $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
find /recordings -maxdepth 1 -type d -name "20*" -mtime +14 -exec rm -rf {} +
echo "[cleanup] Done"
