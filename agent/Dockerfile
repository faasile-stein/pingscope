# PingScope community agent — tiny: just Node + mtr.
# Exact Node release pinned (22.23.4 = Oct 2026 security release).
FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

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
# Install the committed lockfile; fail the build if it is stale or unavailable.
# Optional `proxy_ca` build secret: CA of a TLS-inspecting proxy on the build host
# (see ../Dockerfile); trusted for this step only, never stored in a layer.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev
COPY agent.js healthcheck.js ./
RUN chown -R node:node /app

# Run unprivileged.
ENV NODE_ENV=production
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "healthcheck.js"]
CMD ["node", "agent.js"]
