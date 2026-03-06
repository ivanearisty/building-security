FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends nginx ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY auth.py nginx.conf entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Install nginx config
RUN cp /app/nginx.conf /etc/nginx/nginx.conf

VOLUME /recordings
VOLUME /data

EXPOSE 80

ENTRYPOINT ["/app/entrypoint.sh"]
