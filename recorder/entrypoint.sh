#!/bin/sh
set -e

mkdir -p /recordings

# Install cron job for cleanup at midnight daily
echo "0 0 * * * /app/cleanup.sh >> /var/log/cleanup.log 2>&1" | crontab -
crond

echo "[entrypoint] Starting recorder..."
exec /app/record.sh
