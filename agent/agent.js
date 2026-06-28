'use strict';
// PingScope community probe agent.
// Runs at a volunteer's home, connects OUTBOUND to the PingScope server over
// WSS (NAT-friendly), and — only when asked — runs `mtr` to a validated PUBLIC
// target and reports the hops. It never accepts inbound connections, never runs
// anything but `mtr`, and rate-limits itself.

const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER = process.env.PINGSCOPE_URL || 'wss://pingscope.net/agent';
// Public community join token for pingscope.net. The agent is sandboxed (only
// runs `mtr` to validated public IPs), so this gate is intentionally open — set
// AGENT_TOKEN to override when pointing at your own server.
const TOKEN = process.env.AGENT_TOKEN || 'UktngTqbL-YVYL2mpKEhEdfPvWhpopNd';
const NAME = (process.env.AGENT_NAME || '').replace(/[^\w .\-]/g, '').slice(0, 32);
const MAX_CONCURRENT = Number(process.env.AGENT_MAX_CONCURRENT || 2);
const MAX_PER_MIN = Number(process.env.AGENT_MAX_PER_MIN || 20);

if (!TOKEN) { console.error('AGENT_TOKEN is required. Set it and restart.'); process.exit(1); }

// --- target safety: only public unicast IPv4 ---
function isPublicIp(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;        // this-net, private, loopback, multicast/reserved
  if (a === 169 && b === 254) return false;                              // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;                     // private
  if (a === 192 && b === 168) return false;                              // private
  if (a === 100 && b >= 64 && b <= 127) return false;                    // CGNAT
  return true;
}

// --- self rate limiting ---
const recent = [];
function allowed() {
  const now = Date.now();
  while (recent.length && now - recent[0] > 60_000) recent.shift();
  if (recent.length >= MAX_PER_MIN) return false;
  recent.push(now);
  return true;
}
let active = 0;

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function runMtr(ws, reqId, target) {
  if (typeof target !== 'string' || !isPublicIp(target)) {
    return send(ws, { type: 'mtr-result', reqId, error: 'invalid/!public target' });
  }
  if (active >= MAX_CONCURRENT) return send(ws, { type: 'mtr-result', reqId, error: 'busy' });
  if (!allowed()) return send(ws, { type: 'mtr-result', reqId, error: 'rate limited' });

  active++;
  // Fixed args, arg array (no shell). Numeric only; the server geolocates.
  const proc = spawn('mtr', ['--json', '-n', '-i', '0.5', '-c', '5', '-m', '30', '--', target]);
  let out = '';
  const kill = setTimeout(() => proc.kill('SIGKILL'), 25_000);
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', () => {});
  proc.on('error', () => { clearTimeout(kill); active--; send(ws, { type: 'mtr-result', reqId, error: 'mtr failed' }); });
  proc.on('close', () => {
    clearTimeout(kill); active--;
    let hubs = [];
    try { hubs = (JSON.parse(out).report || {}).hubs || []; } catch { /* partial */ }
    const hops = hubs.map((h) => ({
      idx: h.count,
      host: h.host === '???' ? null : h.host,
      loss: h['Loss%'] ?? 0, snt: h.Snt ?? 0,
      last: h.Last ?? null, avg: h.Avg ?? null, best: h.Best ?? null, wrst: h.Wrst ?? null, stdev: h.StDev ?? null,
    }));
    send(ws, { type: 'mtr-result', reqId, hops });
  });
}

// --- connection with auto-reconnect ---
function connect() {
  const ws = new WebSocket(SERVER, { handshakeTimeout: 10_000, maxPayload: 256 * 1024 });
  let hb;
  ws.on('open', () => {
    console.log('connected →', SERVER);
    send(ws, { type: 'hello', token: TOKEN, name: NAME, version: '1' });
    hb = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 25_000);
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'welcome') console.log(`registered as ${m.id} — ${m.country || '?'} · ${m.asName || '?'}`);
    else if (m.type === 'reject') { console.error('rejected:', m.reason); ws.close(); process.exitCode = 1; }
    else if (m.type === 'mtr') runMtr(ws, m.reqId, m.target);
  });
  ws.on('close', () => { clearInterval(hb); console.log('disconnected; retrying in 5s'); setTimeout(connect, 5000); });
  ws.on('error', (e) => console.error('ws error:', e.message));
}

console.log(`PingScope agent starting${NAME ? ' (' + NAME + ')' : ''}…`);
connect();
