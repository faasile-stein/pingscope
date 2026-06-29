# PingScope community agent — tiny: just Node + mtr.
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends mtr-tiny ca-certificates libcap2-bin \
    && rm -rf /var/lib/apt/lists/*

# Grant raw-socket capability to the mtr helper as a FILE capability so it works
# when the container runs as the unprivileged `node` user. The only capability in
# the container's bounding set is NET_RAW (see docker-compose.yml), so this is the
# most a process here could ever gain.
RUN setcap cap_net_raw+ep "$(command -v mtr-packet)"

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY agent.js ./
RUN chown -R node:node /app

# Run unprivileged.
ENV NODE_ENV=production
USER node
CMD ["node", "agent.js"]
