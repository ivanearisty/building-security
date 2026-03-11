FROM alpine:3.19

RUN apk add --no-cache ffmpeg tzdata

ENV TZ=America/New_York

WORKDIR /app
COPY record.sh cleanup.sh entrypoint.sh ./
RUN chmod +x record.sh cleanup.sh entrypoint.sh

VOLUME /recordings

ENTRYPOINT ["/app/entrypoint.sh"]
