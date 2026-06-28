# PingScope

**A modern, interactive SmokePing.** It pings a catalog of public targets every
second, stores the history in a durable SQLite store, and renders the latency
"smoke" in a custom **Three.js** 3D visualisation — plus a live **MTR** map and
SmokePing-style historic browsing (1h / 6h / 24h / 7d / 30d).

🌐 **Live:** <https://pingscope.net>

![status](https://img.shields.io/badge/status-live-36f1a3) ![license](https://img.shields.io/badge/license-MIT-4ad8ff)

## Highlights

- **3D smoke graph** — every probe is a flowing lane of nested latency-percentile
  bands under a glowing median ribbon; orbit/zoom/hover for detail.
- **3D globe** — an arc from the server to each selected destination; colour grades
  green→red with loss, line width grows with latency variance, each shows live RTT,
  and clicking a line opens its MTR.
- **Live MTR** — full-screen latency map; hops spaced by RTT, with reverse-DNS
  name, AS network and country/flag per hop (fully offline GeoIP — no API calls).
- **Distributed MTR** — combine the server's trace with traces from **community
  agents** running at volunteers' homes (see below).
- **Editable catalog** — targets live in a flat [`probes.conf`](probes.conf).
- **Durable history** — SQLite on a persistent volume; browse any past window.

## Quick start (run the whole app)

Requires Docker. From the repo root:

```sh
docker compose up --build
```

Then open <http://localhost:3000>. `ping` / `traceroute` / `mtr` / `fping` all run
**inside the container**; history persists to the `pingscope-data` volume.

> Want to contribute a vantage point instead of hosting the whole thing? Jump to
> [Community vantage points](#community-vantage-points-distributed-mtr) — it's a
> one-command container.

## Probe catalog — `probes.conf`

Targets live in **`probes.conf`**, a flat, editable list. One probe per line:

```
type | ip-or-hostname | display name | flags
```

- **type** — `dns`, `isp`, or `cloud`
- **flags** (optional, space-separated):
  - `default` — preselect this probe when the page opens
  - `anycast` — global anycast IP (shown as "Anycast", no fixed country)

Lines starting with `#` and blank lines are ignored. Example:

```
cloud | faastic.com    | faastic.com | default
cloud | 95.135.167.100 | bootload.io | default
dns   | 8.8.8.8        | Google DNS  | anycast
isp   | 75.75.75.75    | Comcast
```

**Country, city, AS name and PTR are filled in automatically** at startup from
the bundled offline GeoIP databases + reverse DNS — so you only ever type the
four columns above. Hostnames are resolved to IPs on boot. Edit the file and
restart; point elsewhere with `PROBES_CONF=/path/to/probes.conf`.

All probes are pinged every second with **`fping`** (one process for the whole
set). The left-hand **selector** chooses which to visualise (default = whatever
is flagged `default`, else the top 5 per type × country). Each row has an `mtr`
button (live latency map) and links the name to the probe's PTR.

## How it works

- **Measurement** — every second each target gets a burst of 7 concurrent ICMP
  probes. Their distribution (min / p25 / median / p75 / max + packet loss)
  becomes one "smoke" sample.
- **Storage** — every sample is written to SQLite via Node's built-in
  `node:sqlite`. Old rows are pruned after `RETENTION_DAYS` (default 30).
- **Live feed** — samples stream to the browser over a WebSocket.
- **History** — `GET /api/history?target=all&from=<ms>&to=<ms>&buckets=N` returns
  aggregated buckets for any past window; the "time machine" bar drives it.
- **3D graph** — each target is a flowing lane: nested translucent percentile
  bands (the smoke) under a glowing median ribbon, with neon bloom. Drag to
  orbit, scroll to zoom, hover any point for exact stats.
- **MTR** — type a host and run a live `mtr` (My TraceRoute): each round probes
  every hop, and the **latency map** lays the responding hops out horizontally by
  their RTT (ms), as glowing nodes coloured by packet loss with light "packets"
  flowing along the path. Each hop shows its **reverse-DNS name, AS network
  (`ipwho.is`) and country/flag**. No-reply hops are hidden. Hop IPs are
  geolocated over HTTPS and reverse-resolved server-side (both cached).

### Note on path visibility under Docker Desktop (macOS/Windows)

Inside a Docker Desktop container the network is NAT'd through a userspace proxy
(gVisor/vpnkit), which terminates TTL — so **intermediate internet routers don't
reply** and MTR shows only the Docker gateway and the destination. This is a
platform limitation. Deployed on bootload (Firecracker microVM) or run with
`network_mode: host` / directly via `npm start`, the **full real path** appears.

## Community vantage points (distributed MTR)

PingScope can run an MTR from **multiple origins at once** — the server plus
volunteer "agents" running at people's homes — and draw the combined paths.

- Volunteers run the tiny container in [`agent/`](agent/). It connects **outbound**
  over WSS (works behind home NAT), authenticates with a shared **token**, and only
  ever runs `mtr` to a **validated public IP** the server asks about — nothing else.
- The site lists each agent by **country + AS only** (never the home IP) and lets a
  user pick vantage points before running an MTR. Each vantage becomes a track in
  the latency map.
- Safety: token-gated registration (constant-time check), public-target-only
  validation on both ends, per-browser cooldown, capped vantage count, and the
  agent self-limits its rate/concurrency. The agent container runs with
  `cap_drop: ALL` + only `NET_RAW`, `read_only`, `no-new-privileges`.

Enable it by setting **`AGENT_TOKEN`** on the server and sharing that token with
trusted contributors (see [`agent/README.md`](agent/README.md)). Without the token,
the feature is simply off.

## Configuration (env vars)

| Var              | Default               | Meaning                          |
| ---------------- | --------------------- | -------------------------------- |
| `PORT`             | `3000`                | HTTP / WebSocket port                         |
| `DB_PATH`          | `/data/pingscope.db`  | SQLite file location                          |
| `RETENTION_DAYS`   | `30`                  | how long history is kept                      |
| `PINGS_PER_TICK`   | `5`                   | probes per measurement (the "smoke" spread)   |
| `PROBE_SPACING_MS` | `150`                 | gap between probes — staggered, not a volley  |
| `TICK_MS`          | `1000`                | measurement interval                          |
| `AGENT_TOKEN`      | *(unset)*             | enables community agents; shared join token   |
| `MAX_VANTAGES`     | `8`                   | max agents combined in one distributed MTR    |
| `MAX_AGENTS`       | `300`                 | max simultaneously connected agents           |

## Run without Docker (dev)

Requires Node ≥ 22.5 (for `node:sqlite`). On Linux you may need
`sudo setcap cap_net_raw+ep $(which ping)` or run as root for ICMP.

```sh
npm install
npm start
```
