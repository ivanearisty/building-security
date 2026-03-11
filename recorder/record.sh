#!/bin/sh

CAMERA_HOST="${CAMERA_HOST:-}"
CAMERA_PORT="${CAMERA_PORT:-554}"
CAMERA_USERNAME="${CAMERA_USERNAME:-}"
CAMERA_PASSWORD="${CAMERA_PASSWORD:-}"
CAMERA_STREAM_PATH="${CAMERA_STREAM_PATH:-stream1}"

RETRY_DELAY=5
MAX_RETRY_DELAY=60

if [ "$CAMERA_HOST" = "test" ] || [ -z "$CAMERA_HOST" ]; then
    echo "[recorder] No camera configured — using test pattern"
    INPUT_ARGS="-f lavfi -i testsrc2=size=1920x1080:rate=10"
else
    RTSP_URL="rtsp://${CAMERA_USERNAME}:${CAMERA_PASSWORD}@${CAMERA_HOST}:${CAMERA_PORT}/${CAMERA_STREAM_PATH}"
    echo "[recorder] Capturing from ${CAMERA_HOST}:${CAMERA_PORT}/${CAMERA_STREAM_PATH}"
    INPUT_ARGS="-rtsp_transport tcp -timeout 10000000 -i ${RTSP_URL}"
fi

while true; do
    TODAY=$(date +%Y-%m-%d)
    DAY_DIR="/recordings/${TODAY}"
    mkdir -p "$DAY_DIR"

    echo "[recorder] Recording to ${DAY_DIR} (retry delay: ${RETRY_DELAY}s)"

    # -t 3600: record max 1 hour per ffmpeg invocation, then restart.
    # This ensures the day directory rolls over and the playlist stays manageable.
    ffmpeg $INPUT_ARGS \
        -t 3600 \
        -c:v libx264 -preset slow -crf 30 -tune stillimage \
        -vf scale=1920:1080 \
        -an \
        -f hls \
        -hls_time 10 \
        -hls_list_size 0 \
        -hls_segment_filename "${DAY_DIR}/segment_%H-%M-%S.ts" \
        -strftime 1 \
        "${DAY_DIR}/playlist.m3u8" \
        2>&1

    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        # Clean exit (hit -t limit) — restart immediately with fresh day check
        echo "[recorder] Segment complete, restarting..."
        RETRY_DELAY=5
        continue
    fi

    echo "[recorder] ffmpeg exited with code ${EXIT_CODE}, retrying in ${RETRY_DELAY}s..."
    sleep "$RETRY_DELAY"

    # Exponential backoff up to MAX_RETRY_DELAY
    RETRY_DELAY=$((RETRY_DELAY * 2))
    if [ "$RETRY_DELAY" -gt "$MAX_RETRY_DELAY" ]; then
        RETRY_DELAY=$MAX_RETRY_DELAY
    fi
done
