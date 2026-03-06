#!/bin/sh
set -e

CAMERA_HOST="${CAMERA_HOST:-}"
CAMERA_PORT="${CAMERA_PORT:-554}"
CAMERA_USERNAME="${CAMERA_USERNAME:-}"
CAMERA_PASSWORD="${CAMERA_PASSWORD:-}"
CAMERA_STREAM_PATH="${CAMERA_STREAM_PATH:-stream1}"

if [ "$CAMERA_HOST" = "test" ] || [ -z "$CAMERA_HOST" ]; then
    echo "[recorder] No camera configured — using test pattern"
    INPUT_ARGS="-f lavfi -i testsrc2=size=1920x1080:rate=10"
else
    RTSP_URL="rtsp://${CAMERA_USERNAME}:${CAMERA_PASSWORD}@${CAMERA_HOST}:${CAMERA_PORT}/${CAMERA_STREAM_PATH}"
    echo "[recorder] Starting ffmpeg capture from ${CAMERA_HOST}:${CAMERA_PORT}/${CAMERA_STREAM_PATH}"
    INPUT_ARGS="-rtsp_transport tcp -i ${RTSP_URL}"
fi

while true; do
    TODAY=$(date -u +%Y-%m-%d)
    DAY_DIR="/recordings/${TODAY}"
    mkdir -p "$DAY_DIR"

    echo "[recorder] Recording to ${DAY_DIR}"

    ffmpeg $INPUT_ARGS \
        -c:v libx264 -preset slow -crf 30 -tune stillimage \
        -vf scale=1920:1080 \
        -an \
        -f hls \
        -hls_time 10 \
        -hls_list_size 0 \
        -hls_segment_filename "${DAY_DIR}/segment_%H-%M-%S.ts" \
        -strftime 1 \
        "${DAY_DIR}/playlist.m3u8" \
    || echo "[recorder] ffmpeg exited with code $?, restarting in 5s..."

    sleep 5
done
