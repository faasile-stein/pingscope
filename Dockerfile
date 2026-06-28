# PingScope — runs the Node server plus ping/traceroute inside the container.
FROM node:22-slim
# Verify the toolchain matches the image architecture (guards against a poisoned
# cross-arch build cache producing "Exec format error").
RUN node -v && npm -v

# Network tools used by the measurement engine (+ curl/ca-certs/gzip to fetch
# the offline geo databases at build time).
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping traceroute mtr-tiny fping libcap2-bin curl ca-certificates gzip \
    && rm -rf /var/lib/apt/lists/*

# Strip cap_net_raw from the ping binary. Debian ships ping with `cap_net_raw+ep`,
# which makes it FAIL TO EXEC on runtimes that don't grant NET_RAW (e.g. bootload,
# which forbids cap_add). Without the file cap, ping falls back to unprivileged
# ICMP datagram sockets (SOCK_DGRAM) — allowed here because the kernel's
# net.ipv4.ping_group_range is wide open. Works with or without NET_RAW.
RUN setcap -r "$(command -v ping)" 2>/dev/null || true

WORKDIR /app

# Offline IP geolocation: bundle DB-IP Lite databases (CC-BY, no API key) so the
# app makes NO external geo calls at runtime. Tries the current month, falling
# back to the previous one if this month isn't published yet. Cached layer —
# refresh with a --no-cache rebuild.
RUN set -eu; mkdir -p geo; \
    for ym in "$(date +%Y-%m)" "$(date -d 'last month' +%Y-%m)"; do \
      if curl -fsSL "https://download.db-ip.com/free/dbip-asn-lite-${ym}.mmdb.gz" -o /tmp/asn.gz \
      && curl -fsSL "https://download.db-ip.com/free/dbip-city-lite-${ym}.mmdb.gz" -o /tmp/city.gz; then \
        gunzip -c /tmp/asn.gz  > geo/dbip-asn.mmdb; \
        gunzip -c /tmp/city.gz > geo/dbip-city.mmdb; \
        rm -f /tmp/asn.gz /tmp/city.gz; \
        echo "geo dbs: $ym"; break; \
      fi; \
    done; \
    curl -fsSL "https://raw.githubusercontent.com/ipverse/asn-info/master/as.csv" -o geo/asn-names.csv \
      || echo "WARN: asn-names download failed (falls back to DB-IP org)"; \
    ls -l geo

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# History lives on a mounted volume so it survives container restarts.
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/pingscope.db
VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]
