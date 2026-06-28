'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite');
const maxmind = require('maxmind');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

// Probe catalog (DNS / ISP / Cloud). Targets come from the flat, user-editable
// probes.conf; country/city/AS/PTR are auto-filled at startup. We ping ALL of
// them every second via fping; the UI chooses which to visualise.
const PROBES_CONF = process.env.PROBES_CONF || path.join(__dirname, 'probes.conf');
let PROBES = [];          // built in main() after geo DBs load
let PROBE_BY_IP = new Map();
let PRESELECTED = [];

const TICK_MS = Number(process.env.TICK_MS || 1000);  // one measurement per second
const PINGS_PER_TICK = Number(process.env.PINGS_PER_TICK || 5);  // pings/host/tick
const FPING_PERIOD_MS = Number(process.env.FPING_PERIOD_MS || 120); // spacing
const HISTORY = 600;           // seconds of history replayed to a fresh client

// Parse the flat config — "type | ip-or-hostname | display name | flags".
function parseConf(text) {
  const specs = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 3) continue;
    const [type, host, name, flagStr = ''] = parts;
    if (!['dns', 'isp', 'cloud'].includes(type) || !host || !name) continue;
    const flags = flagStr.toLowerCase().split(/\s+/).filter(Boolean);
    specs.push({ type, host, name, default: flags.includes('default'), anycast: flags.includes('anycast') });
  }
  return specs;
}

// Resolve hostnames, then enrich each probe with geo + reverse DNS (offline).
async function buildCatalog() {
  const specs = parseConf(fs.readFileSync(PROBES_CONF, 'utf8'));
  await Promise.all(specs.map(async (s) => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(s.host)) { s._ip = s.host; return; }
    try { s._ip = (await dns.lookup(s.host, { family: 4 })).address; }
    catch { s._ip = null; console.warn('  probe: cannot resolve', s.host); }
  }));
  await Promise.all(specs.map(async (s) => { if (s._ip) s._ptr = await reverseDns(s._ip).catch(() => null); }));

  const out = [], seen = new Set();
  for (const s of specs) {
    const ip = s._ip;
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);
    const g = s.anycast ? null : geoLookup(ip);
    out.push({
      id: `${s.type}-${ip.replace(/\./g, '-')}`,
      type: s.type, ip, host: s.host !== ip ? s.host : undefined,
      provider: s.name, label: s.name, anycast: !!s.anycast,
      country: s.anycast ? 'Anycast' : ((g && g.country) || 'Unknown'),
      cc: s.anycast ? '' : ((g && g.cc) || ''),
      city: s.anycast ? '' : ((g && g.city) || ''),
      as: (g && g.asn) ? `AS${g.asn}` : '', asName: (g && g.org) || '',
      ptr: s._ptr || null,
      default: !!s.default,
    });
  }
  return out;
}

// Default visualised set: probes flagged `default`; else top 5 per type×country.
function computePreselected() {
  const flagged = PROBES.filter((p) => p.default).map((p) => p.id);
  if (flagged.length) return flagged;
  const groups = new Map();
  for (const p of PROBES) {
    const key = `${p.type}|${p.anycast ? 'anycast' : p.cc || '??'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const sel = [];
  for (const list of groups.values()) sel.push(...list.slice(0, 5).map((p) => p.id));
  return sel;
}

// Non-ephemeral storage: a SQLite file. In Docker this lives on a mounted
// volume (DB_PATH=/data/pingscope.db) so history survives container restarts.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'pingscope.db');
// 74 probes pinged at 1 Hz = a lot of rows; keep a shorter window by default.
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 7);

// ---------------------------------------------------------------------------
// Ping engine — fping pings ALL probes in one process per tick (scales to 100s
// of hosts; a per-host ping spawn would not).
// ---------------------------------------------------------------------------

// Run one fping sweep over every probe IP. Returns Map(ip -> {sent,recv,loss,min,avg,max}).
function fpingSweep(ips) {
  return new Promise((resolve) => {
    if (!ips.length) return resolve(new Map());
    // -q summary to stderr; -c N pings each host N times; -p spacing; -t timeout.
    const args = ['-q', '-c', String(PINGS_PER_TICK), '-p', String(FPING_PERIOD_MS), '-t', '1000', ...ips];
    const fp = spawn('fping', args);
    let err = '';
    const kill = setTimeout(() => fp.kill('SIGKILL'), 8000);
    fp.stderr.on('data', (d) => (err += d));
    fp.on('error', () => { clearTimeout(kill); resolve(new Map()); });
    fp.on('close', () => {
      clearTimeout(kill);
      const m = new Map();
      for (const line of err.split('\n')) {
        // "8.8.8.8 : xmt/rcv/%loss = 5/5/0%, min/avg/max = 14.2/15.1/16.0"
        const mm = line.match(/^(\S+)\s*:\s*xmt\/rcv\/%loss\s*=\s*(\d+)\/(\d+)\/(\d+)%(?:,\s*min\/avg\/max\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+))?/);
        if (!mm) continue;
        m.set(mm[1], {
          sent: +mm[2], recv: +mm[3], loss: +mm[4] / 100,
          min: mm[5] ? +mm[5] : null, avg: mm[6] ? +mm[6] : null, max: mm[7] ? +mm[7] : null,
        });
      }
      resolve(m);
    });
  });
}

// Turn an fping result into a SmokePing-style sample. fping gives min/avg/max +
// loss (not the raw distribution), so the band is min..max and the line is avg.
function toSample(probe, r, t) {
  const min = r ? r.min : null, avg = r ? r.avg : null, max = r ? r.max : null;
  return {
    targetId: probe.id,
    t,
    loss: r ? r.loss : 1,
    sent: r ? r.sent : PINGS_PER_TICK,
    recv: r ? r.recv : 0,
    min, max, median: avg, avg,
    p25: (min != null && avg != null) ? (min + avg) / 2 : null,
    p75: (avg != null && max != null) ? (avg + max) / 2 : null,
    samples: [],
  };
}

// ---------------------------------------------------------------------------
// Persistent store (SQLite)
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS samples (
    target_id TEXT NOT NULL,
    t         INTEGER NOT NULL,
    loss      REAL NOT NULL,
    sent      INTEGER NOT NULL,
    recv      INTEGER NOT NULL,
    min       REAL, max REAL, median REAL,
    p25 REAL, p75 REAL, avg REAL
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_samples_target_t ON samples(target_id, t);');

const insertStmt = db.prepare(`
  INSERT INTO samples (target_id, t, loss, sent, recv, min, max, median, p25, p75, avg)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const recentStmt = db.prepare(
  'SELECT * FROM samples WHERE target_id = ? AND t >= ? ORDER BY t ASC'
);

function persist(r) {
  insertStmt.run(r.targetId, r.t, r.loss, r.sent, r.recv, r.min, r.max, r.median, r.p25, r.p75, r.avg);
}

function rowToSample(row) {
  return {
    targetId: row.target_id, t: row.t, loss: row.loss, sent: row.sent, recv: row.recv,
    min: row.min, max: row.max, median: row.median, p25: row.p25, p75: row.p75, avg: row.avg,
    samples: [],
  };
}

// prune anything older than the retention window
function prune() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  db.prepare('DELETE FROM samples WHERE t < ?').run(cutoff);
}
prune();
setInterval(prune, 3600_000);

// ---------------------------------------------------------------------------
// State + broadcast
// ---------------------------------------------------------------------------
// In-memory replay buffer, seeded from disk in main() so a restart keeps history.
let history = new Map();
function seedHistory() {
  const sinceTs = Date.now() - HISTORY * 1000;
  history = new Map(PROBES.map((p) => [p.id, recentStmt.all(p.id, sinceTs).map(rowToSample)]));
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// Full probe catalog + the default-visualised set.
app.get('/api/probes', (_req, res) => res.json({ probes: PROBES, preselected: PRESELECTED }));
app.get('/api/targets', (_req, res) => res.json(PROBES)); // back-compat

// Aggregated history for browsing the past (SmokePing-style day/week/month views).
// Rows are grouped into `buckets` equal time slices; each slice keeps the latency
// envelope (min/max), average percentiles and packet loss.
const bucketStmt = db.prepare(`
  SELECT
    CAST((t - $from) / $bucket AS INTEGER) AS b,
    MIN(min)    AS min,
    MAX(max)    AS max,
    AVG(median) AS median,
    AVG(p25)    AS p25,
    AVG(p75)    AS p75,
    AVG(loss)   AS loss,
    SUM(sent)   AS sent,
    SUM(recv)   AS recv,
    COUNT(*)    AS n
  FROM samples
  WHERE target_id = $tid AND t >= $from AND t < $to
  GROUP BY b ORDER BY b
`);

app.get('/api/history', (req, res) => {
  const now = Date.now();
  let to = Number(req.query.to) || now;
  let from = Number(req.query.from);
  if (!Number.isFinite(from)) from = to - 3600_000; // default: last hour
  if (to <= from) return res.status(400).json({ error: 'bad range' });
  const buckets = Math.min(1000, Math.max(10, Number(req.query.buckets) || 240));
  const bucket = Math.max(1000, Math.ceil((to - from) / buckets));

  // accept ?target=all, a single id, or a comma-separated list of ids
  const reqTarget = req.query.target;
  let ids;
  if (!reqTarget || reqTarget === 'all') ids = PROBES.map((p) => p.id);
  else ids = String(reqTarget).split(',').filter((id) => PROBES.some((p) => p.id === id));
  if (!ids.length) return res.status(404).json({ error: 'unknown target' });

  const out = {};
  for (const tid of ids) {
    const rows = bucketStmt.all({ tid, from, to, bucket });
    out[tid] = rows.map((r) => ({
      targetId: tid,
      t: from + (r.b + 0.5) * bucket,
      min: r.min, max: r.max, median: r.median,
      p25: r.p25, p75: r.p75,
      loss: r.loss, sent: r.sent, recv: r.recv,
      n: r.n, samples: [],
    }));
  }
  res.json({ from, to, bucket, targets: out });
});

const server = http.createServer(app);
// Two WebSocket endpoints on the same port: browsers at "/", community agents
// at "/agent". Route by path at upgrade time.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });   // browsers
const ass = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 }); // agents
server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* default */ }
  const target = pathname === '/agent' ? ass : wss;
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) if (client.readyState === 1) client.send(msg);
}

// ---------------------------------------------------------------------------
// Community agent registry (distributed vantage points)
// ---------------------------------------------------------------------------
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const MAX_AGENTS = Number(process.env.MAX_AGENTS || 300);
const MAX_VANTAGES = Number(process.env.MAX_VANTAGES || 8);
const agents = new Map();        // agentId -> {id,name,ip,cc,country,asn,asName,ws}
const agentReplies = new Map();  // reqId -> {ws (browser), agentId, timer}
let agentSeq = 0, reqSeq = 0;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
// public view of an agent — country + AS only, NEVER the home IP
function publicAgent(a) {
  return { id: a.id, name: a.name || '', country: a.country || '', cc: a.cc || '', asName: a.asName || '' };
}
function publicAgents() { return [...agents.values()].map(publicAgent); }
function broadcastAgents() { broadcast({ type: 'agents', agents: publicAgents() }); }

ass.on('connection', (ws, req) => {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  let agent = null;
  const helloTimer = setTimeout(() => ws.close(), 5000); // must authenticate quickly

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'hello') {
      clearTimeout(helloTimer);
      if (!AGENT_TOKEN || !safeEqual(m.token || '', AGENT_TOKEN)) {
        ws.send(JSON.stringify({ type: 'reject', reason: 'invalid token' })); return ws.close();
      }
      if (agents.size >= MAX_AGENTS) {
        ws.send(JSON.stringify({ type: 'reject', reason: 'registry full' })); return ws.close();
      }
      const g = geoLookup(ip);
      agent = {
        id: `agent-${++agentSeq}`, name: String(m.name || '').replace(/[^\w .\-]/g, '').slice(0, 32),
        ip, cc: g.cc || '', country: g.country || 'Unknown', asn: g.asn || null, asName: g.org || '', ws,
      };
      agents.set(agent.id, agent);
      ws.send(JSON.stringify({ type: 'welcome', id: agent.id, country: agent.country, cc: agent.cc, asName: agent.asName }));
      console.log(`agent + ${agent.id} ${agent.country} · ${agent.asName} (${agents.size} online)`);
      broadcastAgents();
    } else if (m.type === 'mtr-result' && agent) {
      handleAgentResult(agent, m);
    }
  });
  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (agent) { agents.delete(agent.id); console.log(`agent - ${agent.id} (${agents.size} online)`); broadcastAgents(); }
  });
  ws.on('error', () => {});
});

wss.on('connection', (ws) => {
  // Send the catalog + default selection + current agent list. Replay recent
  // history only for the preselected probes (sending all would be heavy).
  const preHistory = {};
  for (const id of PRESELECTED) preHistory[id] = history.get(id) || [];
  ws.send(JSON.stringify({
    type: 'init',
    probes: PROBES,
    preselected: PRESELECTED,
    tickMs: TICK_MS,
    history: preHistory,
    agents: publicAgents(),
  }));

  const session = { mtr: null, reqs: new Set(), lastMtr: 0 };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'mtr') startDistributed(ws, session, msg.ip, msg.vantages);
    else if (msg.type === 'mtr-stop') stopMtr(session);
  });
  ws.on('close', () => stopMtr(session));
});

// Measurement loop ----------------------------------------------------------
async function tick() {
  const t = Date.now();
  const res = await fpingSweep(PROBES.map((p) => p.ip));
  const results = PROBES.map((p) => toSample(p, res.get(p.ip), t));
  for (const r of results) {
    persist(r);
    const h = history.get(r.targetId);
    h.push(r);
    if (h.length > HISTORY) h.shift();
  }
  broadcast({ type: 'samples', data: results });
}

// Self-scheduling loop: keeps ~TICK_MS cadence when probing is fast, but never
// overlaps measurements (a spaced burst can legitimately take >1s under loss).
async function loop() {
  const started = Date.now();
  try { await tick(); } catch (e) { console.error('tick error:', e.message); }
  setTimeout(loop, Math.max(0, TICK_MS - (Date.now() - started)));
}

// ---------------------------------------------------------------------------
// MTR (My TraceRoute) — live per-hop loss/latency, with hop geolocation
// ---------------------------------------------------------------------------
function isValidHost(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 253) return false;
  // IPv4 with octet range check
  if (/^(\d{1,3})(\.\d{1,3}){3}$/.test(s)) {
    return s.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  }
  // Hostname: letters/digits/dot/hyphen only (no shell metacharacters)
  return /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(s);
}

// --- hop geolocation + reverse DNS (cached) ---
const geoCache = new Map();
const rdnsCache = new Map();

async function reverseDns(ip) {
  if (rdnsCache.has(ip)) return rdnsCache.get(ip);
  let name = null;
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
    ]);
    name = (names && names[0]) || null;
  } catch { name = null; }
  rdnsCache.set(ip, name);
  return name;
}

function resolveNames(ips) {
  return Promise.all([...new Set(ips)].filter((ip) => ip && !isPrivateIp(ip)).map(reverseDns));
}

function isPrivateIp(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 || a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}

// Offline IP geolocation via bundled DB-IP Lite MMDB files (no runtime API
// calls). City DB → country/city/coords, ASN DB → AS number + organisation.
let cityReader = null, asnReader = null;
const asnNames = new Map(); // ASN -> registered AS name (the org running the AS)
const GEO_DIR = process.env.GEO_DIR || path.join(__dirname, 'geo');
async function loadGeo() {
  try { cityReader = await maxmind.open(path.join(GEO_DIR, 'dbip-city.mmdb')); console.log('  geo: city DB loaded'); }
  catch (e) { console.warn('  geo: city DB not loaded —', e.message); }
  try { asnReader = await maxmind.open(path.join(GEO_DIR, 'dbip-asn.mmdb')); console.log('  geo: ASN DB loaded'); }
  catch (e) { console.warn('  geo: ASN DB not loaded —', e.message); }
  loadAsnNames();
}

// Map ASN -> the AS's registered name (ipverse asn-info). DB-IP's lite ASN field
// often gives the IP-range/netblock owner; this gives the actual AS organisation.
function loadAsnNames() {
  try {
    const txt = fs.readFileSync(path.join(GEO_DIR, 'asn-names.csv'), 'utf8');
    let n = 0;
    for (const line of txt.split('\n')) {
      if (!line || line.startsWith('asn,')) continue;
      // asn,handle,description,country-code  (country is the trailing field)
      const i1 = line.indexOf(',');
      const i2 = line.indexOf(',', i1 + 1);
      const iLast = line.lastIndexOf(',');
      if (i1 < 0 || i2 < 0 || iLast <= i2) continue;
      const asn = Number(line.slice(0, i1));
      const desc = line.slice(i2 + 1, iLast).replace(/^"|"$/g, '').trim();
      if (asn && desc) { asnNames.set(asn, desc); n++; }
    }
    console.log(`  geo: ${n} AS names loaded`);
  } catch (e) {
    console.warn('  geo: AS names not loaded —', e.message);
  }
}

function asnOrg(asn, fallback) {
  return (asn && asnNames.get(asn)) || fallback || '';
}

function geoLookup(ip) {
  if (geoCache.has(ip)) return geoCache.get(ip);
  let g;
  if (isPrivateIp(ip)) {
    g = { private: true, city: '', country: 'Private network', cc: '' };
  } else if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    g = { city: '', country: '', cc: '' };
  } else {
    const c = cityReader ? cityReader.get(ip) : null;
    const a = asnReader ? asnReader.get(ip) : null;
    g = {
      city: c?.city?.names?.en || '',
      country: c?.country?.names?.en || '',
      cc: c?.country?.iso_code || '',
      lat: c?.location?.latitude ?? null,
      lon: c?.location?.longitude ?? null,
      asn: a?.autonomous_system_number || null,
      // Prefer the registered AS name over DB-IP's IP-range owner.
      org: asnOrg(a?.autonomous_system_number, a?.autonomous_system_organization),
      isp: a?.autonomous_system_organization || '',
    };
  }
  geoCache.set(ip, g);
  return g;
}

function geolocate(ips) {
  const out = {};
  for (const ip of new Set(ips.filter(Boolean))) out[ip] = geoLookup(ip);
  return out;
}

function stopMtr(session) {
  if (session.mtr) {
    session.mtr.stopped = true;
    if (session.mtr.proc) session.mtr.proc.kill('SIGKILL');
    session.mtr = null;
  }
  if (session.reqs) {
    for (const reqId of session.reqs) {
      const p = agentReplies.get(reqId);
      if (p) { clearTimeout(p.timer); agentReplies.delete(reqId); }
    }
    session.reqs.clear();
  }
}

// public unicast IPv4 only (mirrors the agent's own guard)
function isPublicIp(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

// Distributed MTR: our own live trace + a one-shot from each selected agent.
async function startDistributed(ws, session, rawTarget, vantages) {
  stopMtr(session);
  if (Date.now() - (session.lastMtr || 0) < 1500) return; // cooldown
  session.lastMtr = Date.now();

  if (!isValidHost(rawTarget)) {
    return ws.send(JSON.stringify({ type: 'mtr', source: 'local', done: true, error: `refused: "${String(rawTarget).slice(0, 64)}"` }));
  }
  // resolve to a public IPv4 — agents require an IP and must never hit private space
  let ip = rawTarget;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(rawTarget)) {
    try { ip = (await dns.lookup(rawTarget, { family: 4 })).address; }
    catch { return ws.send(JSON.stringify({ type: 'mtr', source: 'local', done: true, error: 'cannot resolve' })); }
  }
  if (!isPublicIp(ip)) {
    return ws.send(JSON.stringify({ type: 'mtr', source: 'local', done: true, error: 'target must be a public IP' }));
  }

  startMtr(ws, ip, session, 'local');
  const ids = (Array.isArray(vantages) ? vantages : []).filter((id) => agents.has(id)).slice(0, MAX_VANTAGES);
  for (const id of ids) requestAgentMtr(ws, session, id, ip);
}

function requestAgentMtr(ws, session, agentId, ip) {
  const a = agents.get(agentId);
  if (!a || a.ws.readyState !== 1) return;
  const reqId = `r${++reqSeq}`;
  const timer = setTimeout(() => {
    if (agentReplies.has(reqId)) {
      agentReplies.delete(reqId); session.reqs.delete(reqId);
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'mtr', source: agentId, done: true, error: 'timeout' }));
    }
  }, 30000);
  agentReplies.set(reqId, { ws, agentId, timer });
  session.reqs.add(reqId);
  ws.send(JSON.stringify({ type: 'mtr', source: agentId, start: true, agent: publicAgent(a) }));
  a.ws.send(JSON.stringify({ type: 'mtr', reqId, target: ip }));
}

async function handleAgentResult(agent, m) {
  const p = agentReplies.get(m.reqId);
  if (!p) return;
  clearTimeout(p.timer);
  agentReplies.delete(m.reqId);
  const { ws } = p;
  if (ws.readyState !== 1) return;
  if (m.error) return ws.send(JSON.stringify({ type: 'mtr', source: agent.id, done: true, error: m.error }));
  const hops = await enrichAgentHops(Array.isArray(m.hops) ? m.hops.slice(0, 40) : []);
  ws.send(JSON.stringify({ type: 'mtr', source: agent.id, round: 1, hops, agent: publicAgent(agent), done: true }));
}

// Server-side geo + reverse DNS for hops an agent reported numerically.
async function enrichAgentHops(hops) {
  const ips = hops.map((h) => h.host).filter(Boolean);
  geolocate(ips);
  await resolveNames(ips);
  return hops.map((h) => ({
    idx: h.idx, host: h.host || null,
    loss: h.loss ?? 0, snt: h.snt ?? 0, last: h.last ?? null, avg: h.avg ?? null,
    best: h.best ?? null, wrst: h.wrst ?? null, stdev: h.stdev ?? null,
    rdns: h.host ? rdnsCache.get(h.host) || null : null,
    geo: h.host ? geoLookup(h.host) : null,
  }));
}

// Our own live MTR (looping). `source` tags messages so the UI can combine vantages.
function startMtr(ws, ip, session, source = 'local') {
  const state = { stopped: false, proc: null };
  session.mtr = state;
  ws.send(JSON.stringify({ type: 'mtr', source, start: true, target: ip }));

  let round = 0;
  const runRound = () => {
    if (state.stopped || ws.readyState !== 1) return;
    const proc = spawn('mtr', ['--json', '-n', '-i', '0.5', '-c', '5', '-m', '30', '--', ip]);
    state.proc = proc;
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', () => {});
    proc.on('error', (e) => { if (!state.stopped) ws.send(JSON.stringify({ type: 'mtr', source, error: e.message, target: ip })); });
    proc.on('close', async () => {
      if (state.stopped || ws.readyState !== 1) return;
      let hubs = [];
      try { hubs = (JSON.parse(out).report || {}).hubs || []; } catch { /* partial */ }
      const ips = hubs.map((h) => h.host).filter((h) => h && h !== '???');
      const geo = geolocate(ips);
      await resolveNames(ips);
      const hops = hubs.map((h) => {
        const real = h.host && h.host !== '???';
        return {
          idx: h.count, host: real ? h.host : null, rdns: real ? rdnsCache.get(h.host) || null : null,
          loss: h['Loss%'] ?? 0, snt: h.Snt ?? 0, last: h.Last ?? null, avg: h.Avg ?? null,
          best: h.Best ?? null, wrst: h.Wrst ?? null, stdev: h.StDev ?? null,
          geo: real ? geo[h.host] || null : null,
        };
      });
      round += 1;
      if (!state.stopped && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'mtr', source, target: ip, round, hops }));
        if (round < 600) setTimeout(runRound, 250);
        else ws.send(JSON.stringify({ type: 'mtr', source, target: ip, done: true }));
      }
    });
  };
  runRound();
}

// ---------------------------------------------------------------------------
// Startup: load geo DBs, build+enrich the catalog from probes.conf, then serve.
// ---------------------------------------------------------------------------
async function main() {
  await loadGeo();
  PROBES = await buildCatalog();
  PROBE_BY_IP = new Map(PROBES.map((p) => [p.ip, p]));
  PRESELECTED = computePreselected();
  seedHistory();
  loop();
  server.listen(PORT, () => {
    console.log(`\n  PingScope running →  http://localhost:${PORT}\n`);
    const byType = (t) => PROBES.filter((p) => p.type === t).length;
    console.log(`  Catalog: ${PROBES.length} probes (dns=${byType('dns')} isp=${byType('isp')} cloud=${byType('cloud')}) · ${PRESELECTED.length} preselected`);
    console.log(`  Community agents: ${AGENT_TOKEN ? 'ENABLED (token set)' : 'disabled — set AGENT_TOKEN to allow agents'}`);
    console.log('');
  });
}
main().catch((e) => { console.error('startup failed:', e); process.exit(1); });
