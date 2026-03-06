#!/bin/sh
set -e

mkdir -p /data /var/log/nginx

echo "[entrypoint] Starting FastAPI..."
uvicorn auth:app --host 127.0.0.1 --port 8000 --log-level info &

echo "[entrypoint] Starting nginx..."
exec nginx -g 'daemon off;'
