# PingScope community agent — tiny: just Node + mtr.
# Exact Node release pinned (22.23.4 = Oct 2026 security release).
FROM node:22.23.4-bookworm-slim

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
# Optional `npm_ca` build secret: CA of a TLS-inspecting proxy on the build host
# (see ../Dockerfile); trusted for this step only, never stored in a layer.
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev || npm install --omit=dev
COPY agent.js ./
RUN chown -R node:node /app

# Run unprivileged.
ENV NODE_ENV=production
USER node
CMD ["node", "agent.js"]
