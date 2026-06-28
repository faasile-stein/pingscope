# PingScope community agent

Run a **vantage point** for PingScope from your home. When someone on the
PingScope site runs a multi-point MTR, they can include your location, and the
combined paths from every selected vantage are drawn together.

## What it does (and doesn't)

- Connects **outbound** to the PingScope server over WSS. It never opens a port,
  never accepts inbound connections — safe behind your home router.
- The only thing it ever runs is **`mtr` to a public IP** the server asks about.
  It cannot run any other command. Private/loopback/reserved targets are refused.
- It rate-limits itself and runs at most a couple of traceroutes at a time.
- The site shows your **country and AS (ISP) only** — never your IP address.

## Run it

You need the community **token** from the maintainer.

```sh
AGENT_TOKEN=the-community-token \
AGENT_NAME="Brussels home" \
docker compose up -d --build
```

Or plain Docker:

```sh
docker build -t pingscope-agent .
docker run -d --restart unless-stopped \
  --cap-drop ALL --cap-add NET_RAW --security-opt no-new-privileges:true \
  -e AGENT_TOKEN=the-community-token \
  -e AGENT_NAME="Brussels home" \
  pingscope-agent
```

Check it registered:

```sh
docker logs -f pingscope-agent
# → connected → wss://…/agent
# → registered as agent-3 — Belgium · Proximus
```

## Configuration

| Env var               | Default                                            | Meaning                          |
| --------------------- | -------------------------------------------------- | -------------------------------- |
| `AGENT_TOKEN`         | *(required)*                                       | community token from maintainer  |
| `AGENT_NAME`          | *(empty)*                                          | optional public label            |
| `PINGSCOPE_URL`       | `wss://pingscope.be/agent`| server endpoint                  |
| `AGENT_MAX_CONCURRENT`| `2`                                                | max simultaneous traceroutes     |
| `AGENT_MAX_PER_MIN`   | `20`                                               | max traceroutes per minute       |

Stop any time with `docker compose down`. Thanks for contributing a vantage! 🌍
