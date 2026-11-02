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
set). The left-hand **selector** chooses which to visualise; on open it
preselects any `default`-flagged probe plus **one ISP and one cloud provider per
country** (a geographic spread). Each row has an `mtr` button (live latency map)
and links the name to the probe's PTR.

### Want your network in the default catalog?

If you'd like your **IP(s) / network (AS)** added to the shared default
`probes.conf` on **pingscope.net**, open a
[**GitHub issue**](https://github.com/faasile-stein/pingscope/issues/new) with:

- the **IP address(es)** to ping (pingable, public, stable),
- the **network / AS name** and **country**,
- the **type** (`dns`, `isp`, or `cloud`).

We'll review and add them. (Running your own instance? Just edit `probes.conf`.)

## How it works

- **Measurement** — every second each target gets a burst of 7 concurrent ICMP
  probes. Their distribution (min / p25 / median / p75 / max + packet loss)
  becomes one "smoke" sample.
- **Storage** — every sample is written to SQLite via Node's built-in
  `node:sqlite`. Old rows are pruned after `RETENTION_DAYS` (default 30).
- **Live feed** — samples stream to the browser over a WebSocket.
- **History** — `GET /api/history?target=all&from=<ms>&to=<ms>&buckets=N` returns
  aggregated buckets for any past window; the "time machine" bar drives it.
  `target` accepts one catalog ID, comma-separated IDs, or `all` (the default).
  `id`, `probe`, and `host` are not history filters. Unknown `target` IDs return
  404 if none match; responses always identify the selected targets.
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
| `TRUST_PROXY`      | *(unset: none)*        | comma-separated trusted proxy IPs/CIDRs for forwarded HTTP/WebSocket client/protocol headers |

## Run without Docker (dev)

Use Node 22.23.4, matching the pinned Docker image and tested `node:sqlite`
runtime. On Linux you may need
`sudo setcap cap_net_raw+ep $(which ping)` or run as root for ICMP.

```sh
npm install
npm start
```

## Security regression checks

History aggregation runs in one read-only SQLite child process, with at most eight
pending requests and a five-second deadline including queue time. Overloaded
or slow requests receive HTTP 503 with `Retry-After: 5`; other API and live-feed
work remains on the main thread. Large valid history ranges may reach that
deadline, so check representative retention volumes in staging. At the deadline
the parent kills the child with `SIGKILL`, including native SQLite work, and
waits for process closure before starting a replacement. This keeps both request
waiting and database execution bounded. Configure service shutdown to terminate
the whole container/process group: abruptly terminating only the parent can
bypass its JavaScript cleanup while native work is running.

History also has a per-client budget of 100,000 potential returned samples,
refilling over one minute. Cost is the number of selected targets multiplied
by the maximum buckets in the requested range; small graph requests cost less
than whole-catalog downloads. Exceeding the available budget returns HTTP 429
with `Retry-After` before SQLite work starts. A single query exceeding 100,000
samples returns 400; select fewer targets or buckets. The client-state map is
capped at 5,000 entries and rejects new clients while full rather than evicting
active limits. Public catalog access and the live feed remain available.

Before deploying behind a proxy, set `TRUST_PROXY` to the exact intermediary
IPs/CIDRs (including every trusted hop in its forwarded chain). For a proxy on
the same host, `TRUST_PROXY=loopback` is sufficient. Keep the backend port
private and have the edge overwrite client-supplied forwarding headers.
Without this setting, HTTP and WebSocket budgets use the socket peer, and
share URLs and Origin checks use the socket protocol: clients behind one proxy
share a budget. Agent registration also uses this trusted client-IP lookup.
The quickstart Compose port mapping is for direct local development; it does
not configure a production TLS ingress or firewall.

The browser WebSocket endpoint checks explicit Origins against the request's
scheme and host. A TLS-terminating proxy must preserve `Host`, overwrite
`X-Forwarded-Proto` and `X-Forwarded-For`, and keep the backend port private.
Same-origin browsers and native clients without an Origin remain supported;
`/agent` continues to authenticate its hello token. These checks do not turn
the public API into an authenticated service.

Live MTR admits at most eight sessions, including pending DNS and processes
that are still stopping. Its shared per-client 20-second measurement cooldown
is checked before DNS; changing untrusted forwarding headers cannot create a
new client identity. Disconnecting or stopping a pending lookup prevents a
later process launch. The cooldown map holds at most 5,000 clients.

Public traces retain hop positions and measurements, but redact nonpublic
transit IPs, reverse-DNS names and geographic details in local, community and
sovereignty output. Destination validation covers equivalent IPv6 and embedded
IPv4 notation on both server and agent. Non-object message frames are ignored
by the server; community hop rows are normalized before enrichment. Ranking
pagination truncates fractional page/size values before SQLite LIMIT/OFFSET.

Three.js remains at version 0.160.0 and is served from the committed npm
lockfile through `/vendor/three/`. CSP allows scripts from this origin and a
fresh import-map nonce; styles come from local CSS files. Map JSON still comes
from jsDelivr under `connect-src`, which does not authorize CDN scripts.

Both images declare container health checks. The server checks HTTP liveness
on loopback `/api/probes`; the agent checks recent registration/pong activity
without opening a listener. Read-only agent deployments need the `/tmp` tmpfs
shown in `agent/docker-compose.yml`. Configure platform alerts/recovery
separately: Docker's restart policy alone does not restart an unhealthy process.

Use Node 22.23.4, matching the application's pinned and tested runtime:

```sh
npm ci
npm test
docker build --check .
docker build --check agent/
bash tests/build-context.sh
# Optional browser regression, using an already installed Chromium binary:
PINGSCOPE_CHROMIUM=/path/to/chrome node --experimental-sqlite tests/browser-csp.cjs
```

The tests use temporary databases, loopback HTTP/WebSocket listeners, local
fixtures, and stubbed DNS/probe processes. They do not start the measurement
loop or contact monitored targets. Frontend checks exercise renderer output
with a minimal DOM fixture; they are not full browser tests.

The security review's per-result evidence, callback outcomes, verification
commands, and deployment retest instructions are in
[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) and the current
[`security-findings-2026-11-01-followup.json`](security-findings-2026-11-01-followup.json)
ledger for all 112 results in the 20:19 UTC handoff. Earlier reviews remain in
`security-findings-2026-11-01.json` and `security-findings.json`. Local fixes still require
a separate Provenby retest after the reviewed revision is deployed.
