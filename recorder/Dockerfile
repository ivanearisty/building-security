FROM alpine:3.19

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY record.sh cleanup.sh entrypoint.sh ./
RUN chmod +x record.sh cleanup.sh entrypoint.sh

VOLUME /recordings

ENTRYPOINT ["/app/entrypoint.sh"]
