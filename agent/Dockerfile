# PingScope community agent — tiny: just Node + mtr.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends mtr-tiny ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY agent.js ./

# Drop all privileges except what raw-socket ICMP needs.
ENV NODE_ENV=production
CMD ["node", "agent.js"]
