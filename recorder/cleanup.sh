#!/bin/sh
# Delete recording directories older than 14 days
echo "[cleanup] Running cleanup at $(date '+%Y-%m-%d %H:%M:%S %Z')"
find /recordings -maxdepth 1 -type d -name "20*" -mtime +14 -exec rm -rf {} +
echo "[cleanup] Done"
