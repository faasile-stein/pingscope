'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { DatabaseSync } = require('node:sqlite');
const maxmind = require('maxmind');
const helmet = require('helmet');
const { Resvg } = require('@resvg/resvg-js');

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
let ORIGIN = null;        // this server's location (globe view origin)

const TICK_MS = Number(process.env.TICK_MS || 1000);  // one measurement per second
const PINGS_PER_TICK = Number(process.env.PINGS_PER_TICK || 5);  // pings/host/tick
const FPING_PERIOD_MS = Number(process.env.FPING_PERIOD_MS || 120); // spacing
const HISTORY = 600;           // seconds of history replayed to a fresh client

// ---------------------------------------------------------------------------
// IP classification — shared by the ping engine, MTR, and geo (IPv4 + IPv6)
// ---------------------------------------------------------------------------

// Resolve a hostname to an address, preferring IPv4 (broadest reachability, and
// community agents may lack IPv6) but falling back to IPv6-only hosts.
async function lookupHost(host) {
  try { return await dns.lookup(host, { family: 4 }); }
  catch { return await dns.lookup(host, { family: 6 }); }
}

// Public unicast IPv4? (rejects this-net, private, loopback, CGNAT, link-local,
// multicast/reserved.)
function isPublicIpv4(ip) {
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

// Public (globally routable) unicast IPv6? Rejects loopback/unspecified,
// link-local (fe80::/10), unique-local (fc00::/7), multicast (ff00::/8) and the
// documentation range; v4-mapped tails fall through to the IPv4 rules.
function isPublicIpv6(ip) {
  const a = ip.toLowerCase();
  const mapped = a.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPublicIpv4(mapped[1]);
  if (a === '::' || a === '::1') return false;
  const first = a.startsWith('::') ? 0 : parseInt(a.split(':')[0] || '0', 16);
  if (Number.isNaN(first)) return false;
  if ((first & 0xffc0) === 0xfe80) return false;   // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return false;   // fc00::/7  unique-local
  if ((first & 0xff00) === 0xff00) return false;   // ff00::/8  multicast
  if (first === 0x2001 && parseInt(a.split(':')[1] || '', 16) === 0x0db8) return false; // docs
  return true;
}

// Public routable address of either family.
function isPublicIp(ip) {
  const f = net.isIP(ip);
  if (f === 4) return isPublicIpv4(ip);
  if (f === 6) return isPublicIpv6(ip);
  return false;
}

// Non-routable / special-use address (used to skip reverse-DNS + mark geo).
function isPrivateIp(ip) {
  const f = net.isIP(ip);
  if (f === 4) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 10 || a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    );
  }
  if (f === 6) return !isPublicIpv6(ip);
  return false;
}

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
    if (net.isIP(s.host)) { s._ip = s.host; return; }   // IPv4 or IPv6 literal
    try { s._ip = (await lookupHost(s.host)).address; }
    catch { s._ip = null; console.warn('  probe: cannot resolve', s.host); }
  }));
  await Promise.all(specs.map(async (s) => { if (s._ip) s._ptr = await reverseDns(s._ip).catch(() => null); }));

  const out = [], seen = new Set();
  for (const s of specs) {
    const ip = s._ip;
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);
    const g = s.anycast ? null : geoLookup(ip);
    const coords = geoLookup(ip); // always resolve lat/lon (incl. anycast) for the globe
    out.push({
      id: `${s.type}-${ip.replace(/[.:]/g, '-')}`,
      type: s.type, ip, host: s.host !== ip ? s.host : undefined,
      provider: s.name, label: s.name, anycast: !!s.anycast,
      country: s.anycast ? 'Anycast' : ((g && g.country) || 'Unknown'),
      cc: s.anycast ? '' : ((g && g.cc) || ''),
      city: s.anycast ? '' : ((g && g.city) || ''),
      lat: coords.lat ?? null, lon: coords.lon ?? null,
      as: (g && g.asn) ? `AS${g.asn}` : '', asName: (g && g.org) || '',
      ptr: s._ptr || null,
      default: !!s.default,
    });
  }
  return out;
}

// This server's own location (origin of every arc on the globe). Configure via
// env (SERVER_LAT/SERVER_LON/SERVER_CITY, or SERVER_IP to geolocate it);
// defaults to the fr1 region — OVH Gravelines, where the deployment egresses.
function computeOrigin() {
  const lat = process.env.SERVER_LAT, lon = process.env.SERVER_LON;
  if (lat && lon) return { lat: +lat, lon: +lon, city: process.env.SERVER_CITY || 'server', country: process.env.SERVER_COUNTRY || '', cc: process.env.SERVER_CC || '' };
  if (process.env.SERVER_IP) {
    const g = geoLookup(process.env.SERVER_IP);
    if (g && g.lat != null) return { lat: g.lat, lon: g.lon, city: g.city || 'server', country: g.country || '', cc: g.cc || '' };
  }
  return { lat: 50.9871, lon: 1.5897, city: process.env.SERVER_CITY || 'fr1', country: 'France', cc: 'FR' };
}

// Default visualised set on open: any probe flagged `default`, plus one ISP and
// one cloud provider per country — a geographic spread without overwhelming the
// view. (Anycast probes have no fixed country, so they're left out of the spread.)
function computePreselected() {
  const sel = new Set(PROBES.filter((p) => p.default).map((p) => p.id));
  const seen = new Set();
  for (const type of ['isp', 'cloud']) {
    for (const p of PROBES) {
      if (p.type !== type || p.anycast) continue;
      const key = `${type}|${p.cc || p.country}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sel.add(p.id);
    }
  }
  return [...sel];
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

// One fping process over a single-family batch. `-4`/`-6` picks the family;
// fping can't mix families in one invocation. Returns Map(ip -> summary).
function fpingBatch(ips, familyFlag) {
  return new Promise((resolve) => {
    if (!ips.length) return resolve(new Map());
    // -q summary to stderr; -c N pings each host N times; -p spacing; -t timeout.
    const args = [familyFlag, '-q', '-c', String(PINGS_PER_TICK), '-p', String(FPING_PERIOD_MS), '-t', '1000', ...ips];
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
        // (IPv6 first token: "2001:4860:4860::8888 : xmt/rcv/…")
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

// Sweep every probe IP, one fping process per family. Returns Map(ip -> summary).
async function fpingSweep(ips) {
  const v4 = ips.filter((ip) => net.isIP(ip) === 4);
  const v6 = ips.filter((ip) => net.isIP(ip) === 6);
  const [m4, m6] = await Promise.all([fpingBatch(v4, '-4'), fpingBatch(v6, '-6')]);
  return new Map([...m4, ...m6]);
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

// Open the DB and verify it isn't corrupt. A malformed image (e.g. from a
// container killed mid-write during a redeploy) would otherwise crash the
// process at boot and take the whole site down. On failure we move the bad
// files aside and start fresh — both tables here (ping history + the
// sovereignty ranking) are regenerable, so a reset restores service.
let db;
function openDatabase(pathToDb) {
  const d = new DatabaseSync(pathToDb);
  d.exec('PRAGMA journal_mode = WAL;');
  const row = d.prepare('PRAGMA quick_check').get();
  if (!row || String(row.quick_check).toLowerCase() !== 'ok') {
    throw new Error(`quick_check → ${row ? row.quick_check : 'no result'}`);
  }
  return d;
}
try {
  db = openDatabase(DB_PATH);
} catch (e) {
  console.error(`  db: existing database is corrupt/unreadable (${e.message}) — resetting`);
  try { db && db.close(); } catch { /* ignore */ }
  const stamp = Date.now();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      if (fs.existsSync(DB_PATH + suffix)) fs.renameSync(DB_PATH + suffix, `${DB_PATH}.corrupt-${stamp}${suffix}`);
    } catch { /* ignore */ }
  }
  db = new DatabaseSync(DB_PATH);          // fresh, empty database
  db.exec('PRAGMA journal_mode = WAL;');
  console.warn(`  db: started a fresh database (old one saved as ${DB_PATH}.corrupt-${stamp})`);
}
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

// Persisted sovereignty scans → power the /ranking leaderboard and survive
// restarts (also re-seed the in-memory result cache on boot).
db.exec(`
  CREATE TABLE IF NOT EXISTS sov_scores (
    domain TEXT PRIMARY KEY,
    web    INTEGER,
    mail   INTEGER,
    data   TEXT NOT NULL,
    at     INTEGER NOT NULL
  );
`);
const sovUpsertStmt = db.prepare(`
  INSERT INTO sov_scores (domain, web, mail, data, at) VALUES ($domain, $web, $mail, $data, $at)
  ON CONFLICT(domain) DO UPDATE SET web=$web, mail=$mail, data=$data, at=$at
`);
const sovSeedStmt = db.prepare('SELECT domain, data, at FROM sov_scores');
const sovRankStmt = db.prepare('SELECT domain, web, mail, at FROM sov_scores');
// SQL-level ranking pagination — scales past a handful of rows. Composite score
// = mean of web & mail (or the one that exists); ORDER done in SQL so we never
// pull the whole table into memory.
const sovCountStmt = db.prepare('SELECT COUNT(*) c FROM sov_scores');
const sovPageStmt = db.prepare(`
  SELECT domain, web, mail, at FROM sov_scores
  ORDER BY (COALESCE(web, mail, 0) + COALESCE(mail, web, 0)) DESC, at DESC
  LIMIT $limit OFFSET $offset
`);

// If a previous database was set aside as *.corrupt-* (see the boot self-heal
// above), try to salvage its sovereignty ranking into the live DB. The
// corruption is typically in the large `samples` tree, so a targeted read of
// the small `sov_scores` tree usually still succeeds. Runs once; the file is
// renamed afterwards so it isn't re-imported.
function recoverCorruptRanking() {
  let files;
  try {
    const dir = path.dirname(DB_PATH), base = path.basename(DB_PATH);
    files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(base + '.corrupt-') && !f.endsWith('-wal') && !f.endsWith('-shm'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch { return; }
  for (const src of files) {
    let rows = [];
    try {
      const cdb = new DatabaseSync(src);
      rows = cdb.prepare('SELECT domain, web, mail, data, at FROM sov_scores').all();
      cdb.close();
    } catch (e) {
      console.warn(`  db: could not salvage ranking from ${path.basename(src)} — ${e.message}`);
      try { fs.renameSync(src, src.replace('.corrupt-', '.unrecovered-')); } catch { /* ignore */ }
      continue;
    }
    let n = 0;
    for (const r of rows) {
      try { sovUpsertStmt.run({ domain: r.domain, web: r.web, mail: r.mail, data: r.data, at: r.at }); n++; } catch { /* skip bad row */ }
    }
    console.log(`  db: recovered ${n} sovereignty score(s) from ${path.basename(src)}`);
    try { fs.renameSync(src, src.replace('.corrupt-', '.imported-')); } catch { /* ignore */ }
  }
}
recoverCorruptRanking();

// Best-effort BACKGROUND salvage of ping history (`samples`) from a set-aside
// *.imported-* file (that's the corrupt table, so it's tolerant to damage:
// reads recent→older in rowid chunks, skips ranges that error, only keeps rows
// inside the retention window, throttles between chunks so it never blocks the
// health check, and renames the file when done so it runs once). Fire-and-
// forget from main() AFTER the server is listening.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function salvageSamples() {
  let files;
  try {
    const dir = path.dirname(DB_PATH), base = path.basename(DB_PATH);
    files = fs.readdirSync(dir)
      .filter((f) => (f.startsWith(base + '.imported-') || f.startsWith(base + '.samples-src-')) && !f.endsWith('-wal') && !f.endsWith('-shm'))
      .map((f) => path.join(dir, f));
  } catch { return; }
  for (const file of files) {
    // claim *.imported-* by renaming so a restart won't reprocess it; a
    // *.samples-src-* file is an interrupted run being resumed.
    let claim = file;
    if (file.includes('.imported-')) {
      claim = file.replace('.imported-', '.samples-src-');
      try { fs.renameSync(file, claim); } catch { continue; }
    }
    let src;
    try { src = new DatabaseSync(claim); } catch (e) { console.warn('  db: samples salvage — open failed:', e.message); continue; }
    let maxRowid = 0;
    try { maxRowid = (src.prepare('SELECT max(rowid) m FROM samples').get() || {}).m || 0; } catch { maxRowid = 0; }

    const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
    const CHUNK = 8000, THROTTLE = 50, DEADLINE = Date.now() + 30 * 60_000;
    const sel = src.prepare('SELECT target_id,t,loss,sent,recv,min,max,median,p25,p75,avg FROM samples WHERE rowid >= ? AND rowid < ?');
    const stats = { recovered: 0, skipped: 0 };
    // insert one chunk's in-window rows in a single transaction; returns kept count
    const insertBatch = (rows) => {
      const batch = rows.filter((r) => r.t >= cutoff);
      if (!batch.length) return 0;
      try {
        db.exec('BEGIN');
        for (const r of batch) insertStmt.run(r.target_id, r.t, r.loss, r.sent, r.recv, r.min, r.max, r.median, r.p25, r.p75, r.avg);
        db.exec('COMMIT');
        stats.recovered += batch.length;
      } catch { try { db.exec('ROLLBACK'); } catch { /* ignore */ } }
      return batch.length;
    };
    console.log(`  db: salvaging ping history from ${path.basename(claim)} (maxRowid≈${maxRowid || 'unknown'})…`);

    if (maxRowid > 0) {
      // known top: walk recent → older, stop once whole chunks fall below retention
      let belowStreak = 0;
      for (let hi = maxRowid + 1; hi > 0 && Date.now() < DEADLINE; hi -= CHUNK) {
        let rows;
        try { rows = sel.all(Math.max(0, hi - CHUNK), hi); } catch { stats.skipped += CHUNK; continue; }
        if (rows.length) { belowStreak = insertBatch(rows) ? 0 : belowStreak + 1; if (belowStreak >= 3) break; }
        await sleep(THROTTLE);
      }
    } else {
      // unknown top: forward scan, stop after a run of empty chunks
      let emptyStreak = 0;
      for (let lo = 0; Date.now() < DEADLINE; lo += CHUNK) {
        let rows;
        try { rows = sel.all(lo, lo + CHUNK); } catch { stats.skipped += CHUNK; emptyStreak = 0; continue; }
        if (!rows.length) { if (++emptyStreak >= 8) break; await sleep(THROTTLE); continue; }
        emptyStreak = 0; insertBatch(rows);
        await sleep(THROTTLE);
      }
    }
    try { src.close(); } catch { /* ignore */ }
    try { fs.renameSync(claim, claim.replace('.samples-src-', '.samples-done-')); } catch { /* ignore */ }
    console.log(`  db: ping-history salvage done — recovered ${stats.recovered} row(s), skipped ~${stats.skipped} corrupt rowid(s)`);
  }
}

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

// prune anything older than the retention window (never fatal)
function prune() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
    db.prepare('DELETE FROM samples WHERE t < ?').run(cutoff);
  } catch (e) {
    console.warn('  db: prune failed —', e.message);
  }
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
app.set('trust proxy', true); // behind bootload's proxy → correct req.protocol/host

// Content-Security-Policy. Allows: our own assets; the Three.js modules on unpkg
// (resolved via the inline import-map, which gets a per-request nonce); the
// world-atlas TopoJSON fetched from jsdelivr; same-origin WebSocket. `nonce`
// null = the strict baseline used for static assets (no inline script allowed).
function csp(nonce) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' https://unpkg.com${nonce ? ` 'nonce-${nonce}'` : ''}`,
    "connect-src 'self' https://cdn.jsdelivr.net",
    "font-src 'self'",
  ].join('; ');
}

// Standard security headers via Helmet (X-Frame-Options, HSTS, nosniff,
// Referrer-Policy, COOP, etc. — and it strips X-Powered-By). We keep our OWN
// Content-Security-Policy: it carries a per-request nonce for the inline
// import-map, which Helmet's static CSP can't express — so Helmet's CSP is
// disabled here. COEP is left off so the Three.js ES modules load from unpkg.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' },
}));

// Our CSP (baseline; the '/' route re-sets it with a nonce) + Permissions-Policy
// (which Helmet doesn't set).
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', csp(null));
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  next();
});

// ---- shareable MTR views: inject Open Graph tags + a dynamic preview image ----
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cleanTarget = (s) => String(s || '').replace(/[^a-zA-Z0-9.:-]/g, '').slice(0, 64);

function ogTags({ title, desc, image, url }) {
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="PingScope">`,
    `<meta property="og:title" content="${xmlEsc(title)}">`,
    `<meta property="og:description" content="${xmlEsc(desc)}">`,
    `<meta property="og:url" content="${xmlEsc(url)}">`,
    `<meta property="og:image" content="${xmlEsc(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${xmlEsc(title)}">`,
    `<meta name="twitter:description" content="${xmlEsc(desc)}">`,
    `<meta name="twitter:image" content="${xmlEsc(image)}">`,
  ].join('\n  ');
}

app.get('/', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const target = cleanTarget(req.query.mtr);
  let tags;
  if (target) {
    const vps = String(req.query.vp || '').split(',').filter(Boolean).length;
    const vantages = 1 + vps; // this server + community vantages
    const title = `MTR ⟶ ${target} · PingScope`;
    const desc = `Live multi-point traceroute to ${target} from ${vantages} vantage point${vantages !== 1 ? 's' : ''} — latency, loss and geographic route.`;
    const image = `${base}/og?mtr=${encodeURIComponent(target)}&n=${vantages}`;
    tags = ogTags({ title, desc, image, url: `${base}/?mtr=${encodeURIComponent(target)}` });
  } else {
    tags = ogTags({
      title: 'PingScope — live latency observatory',
      desc: 'A modern SmokePing: 3D latency smoke graph, live distributed MTR with community vantage points, offline GeoIP/AS.',
      image: `${base}/og`, url: base,
    });
  }
  // never cache the shell, so new builds (and their JS/CSS) show up on reload
  res.set('Cache-Control', 'no-store');
  // per-request nonce authorises the inline import-map without 'unsafe-inline'
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('Content-Security-Policy', csp(nonce));
  res.type('html').send(
    INDEX_HTML.replace('<!--OG-->', tags).replace(/__CSP_NONCE__/g, nonce),
  );
});

// Dynamic Open Graph preview image (SVG, 1200×630).
app.get('/og', (req, res) => {
  const target = cleanTarget(req.query.mtr);
  const n = Math.max(1, Math.min(99, Number(req.query.n) || 1));
  const headline = target ? `MTR ⟶ ${target}` : 'live latency observatory';
  const sub = target ? `${n} vantage point${n !== 1 ? 's' : ''} · latency · loss · geographic route` : 'distributed traceroute · 3D smoke graph';
  const nodes = Array.from({ length: 7 }, (_, i) => {
    const x = 150 + i * 145, y = 430 + Math.sin(i * 0.9) * 28;
    const c = i === 6 ? '#ff8a3d' : (i < 2 ? '#7e88ab' : '#4ad8ff');
    return `<circle cx="${x}" cy="${y.toFixed(0)}" r="9" fill="${c}"/>`;
  }).join('');
  const path = Array.from({ length: 7 }, (_, i) => `${i ? 'L' : 'M'}${150 + i * 145},${(430 + Math.sin(i * 0.9) * 28).toFixed(0)}`).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#0a0e1c"/><stop offset="1" stop-color="#05060c"/></linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.2" r="0.8"><stop offset="0" stop-color="#4ad8ff" stop-opacity="0.18"/><stop offset="1" stop-color="#4ad8ff" stop-opacity="0"/></radialGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/><rect width="1200" height="630" fill="url(#glow)"/>
  <text x="80" y="120" font-family="monospace" font-size="34" fill="#4ad8ff" letter-spacing="10">◵ PINGSCOPE</text>
  <text x="80" y="300" font-family="monospace" font-size="${target && target.length > 22 ? 64 : 86}" font-weight="bold" fill="#e7ecff">${xmlEsc(headline)}</text>
  <text x="80" y="360" font-family="monospace" font-size="30" fill="#7e88ab">${xmlEsc(sub)}</text>
  <path d="${path}" fill="none" stroke="#4ad8ff" stroke-width="3" stroke-opacity="0.6"/>${nodes}
  <text x="80" y="570" font-family="monospace" font-size="26" fill="#7e88ab">pingscope.net</text>
</svg>`;
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
});

// ---- sovereignty share: per-domain OG image + tag injection ----
const SOV_HTML = fs.readFileSync(path.join(__dirname, 'public', 'sovereignty.html'), 'utf8');
const SOV_FONT = { fontDirs: ['/usr/share/fonts'], loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' };
const clampScore = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null; };
const sovScoreColor = (s) => {
  if (s == null) return '#8b95b8';
  const p = (100 - s) / 100; // sovereign green #35e0a1 → non-sovereign red #ff6272
  return `rgb(${[53 + (255 - 53) * p, 224 + (98 - 224) * p, 161 + (114 - 161) * p].map(Math.round).join(',')})`;
};
const sovVerdict = (s) => (s == null ? 'no mail' : s >= 80 ? 'sovereign' : s >= 50 ? 'partial' : 'non-sovereign');

// 1200×630 share card: "European sovereignty check of <domain>" + web/mail scores.
function sovOgSvg({ domain, web, mail }) {
  let dRaw = String(domain || 'a domain');
  if (dRaw.length > 34) dRaw = dRaw.slice(0, 33) + '…';
  const d = xmlEsc(dRaw);
  const dSize = dRaw.length <= 14 ? 70 : dRaw.length <= 22 ? 56 : dRaw.length <= 28 ? 46 : 38;
  const F = 'DejaVu Sans', M = 'DejaVu Sans Mono';
  const tile = (x, label, score) => {
    const col = sovScoreColor(score), v = sovVerdict(score);
    return `
    <text x="${x + 26}" y="474" font-family="${M}" font-size="15" letter-spacing="2" fill="#8b95b8">${label}</text>
    <text x="${x + 24}" y="536" font-family="${M}" font-size="60" font-weight="bold" fill="${col}">${score == null ? '—' : score}<tspan font-size="19" fill="#626c94"> /100</tspan></text>
    <rect x="${x + 25}" y="552" width="${(v.length * 8.6) + 22}" height="27" rx="13.5" fill="none" stroke="${col}"/>
    <text x="${x + 36}" y="570" font-family="${M}" font-size="14" fill="${col}">${v}</text>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#06070e"/>
  <line x1="64" y1="106" x2="1136" y2="106" stroke="#1a2138"/>
  <g transform="translate(64,52)"><circle cx="17" cy="17" r="15" fill="none" stroke="#4ad8ff" stroke-width="3.5"/><path d="M17 17 L17 32 A15 15 0 0 1 2 17 Z" fill="#4ad8ff"/></g>
  <text x="112" y="78" font-family="${F}" font-size="22" font-weight="bold" letter-spacing="6" fill="#e9edfb">PINGSCOPE</text>
  <rect x="905" y="52" width="231" height="38" rx="19" fill="none" stroke="#4ad8ff" stroke-opacity="0.4"/>
  <text x="932" y="77" font-family="${M}" font-size="17" fill="#4ad8ff">sovereignty check</text>
  <text x="64" y="252" font-family="${M}" font-size="20" letter-spacing="5" fill="#626c94">EUROPEAN SOVEREIGNTY CHECK OF</text>
  <text x="62" y="328" font-family="${F}" font-size="${dSize}" font-weight="800" fill="#4ad8ff">${d}</text>
  <text x="64" y="406" font-family="${F}" font-size="25" fill="#c1cae8">Where its web &amp; mail are hosted — and who controls them.</text>
  <rect x="662" y="430" width="474" height="164" rx="20" fill="#0d1120" stroke="#232c48"/>
  <line x1="899" y1="454" x2="899" y2="570" stroke="#232c48"/>
  ${tile(662, 'WEB', web)}${tile(899, 'MAIL', mail)}
  <text x="64" y="560" font-family="${M}" font-size="23" font-weight="bold" fill="#4ad8ff">pingscope.net/sovereignty</text>
</svg>`;
}

// Per-domain share image (PNG). Scores come from the URL — no scan at crawl time.
app.get('/og/sovereignty', (req, res) => {
  const domain = cleanTarget(req.query.d) || 'a domain';
  const svg = sovOgSvg({ domain, web: clampScore(req.query.web), mail: clampScore(req.query.mail) });
  try {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: SOV_FONT }).render().asPng();
    res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(png);
  } catch (e) {
    res.status(500).type('text/plain').send('render failed');
  }
});

// Standalone sovereignty page — injects per-domain OG tags when shared with ?d.
app.get('/sovereignty', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const d = cleanTarget(req.query.d);
  let tags;
  if (d) {
    const web = clampScore(req.query.w), mail = clampScore(req.query.m);
    const q = `d=${encodeURIComponent(d)}${web != null ? `&web=${web}` : ''}${mail != null ? `&mail=${mail}` : ''}`;
    const shareQ = `d=${encodeURIComponent(d)}${web != null ? `&w=${web}` : ''}${mail != null ? `&m=${mail}` : ''}`;
    const fmt = (s) => (s != null ? `${s}/100` : '—');
    tags = ogTags({
      title: `European sovereignty check of ${d}`,
      desc: `${d} — web ${fmt(web)} · mail ${fmt(mail)}. See where a site's web & mail are hosted, and who ultimately controls them.`,
      image: `${base}/og/sovereignty?${q}`,
      url: `${base}/sovereignty?${shareQ}`,
    });
  } else {
    tags = ogTags({
      title: 'Is your website actually European?',
      desc: "Run any domain through the European sovereignty check: where its web & mail really live, and who ultimately controls them.",
      image: `${base}/og-sovereignty.png`,
      url: `${base}/sovereignty`,
    });
  }
  res.set('Cache-Control', 'no-store');
  res.type('html').send(SOV_HTML.replace('<!--SOVOG-->', tags));
});

// Leaderboard of every domain that's been checked, ranked by sovereignty.
app.get('/ranking', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').sendFile(path.join(__dirname, 'public', 'ranking.html'));
});
app.get('/api/rankings', (req, res) => {
  const total = sovCountStmt.get().c;
  const per = Math.min(200, Math.max(1, Number(req.query.per) || 100));
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
  const offset = (page - 1) * per;
  const rankings = sovPageStmt.all({ limit: per, offset }).map((r, i) => ({
    rank: offset + i + 1, domain: r.domain, web: r.web, mail: r.mail, at: r.at,
    composite: r.mail == null ? r.web : (r.web == null ? r.mail : Math.round((r.web + r.mail) / 2)),
  }));
  res.json({ total, page, per, pages, rankings });
});

app.use(express.static(path.join(__dirname, 'public')));
// Full probe catalog + the default-visualised set.
app.get('/api/probes', (_req, res) => res.json({ probes: PROBES, preselected: PRESELECTED }));
app.get('/api/targets', (_req, res) => res.json(PROBES)); // back-compat

// Sovereignty scan: enter a site → traceroute its web (A/AAAA) and mail (MX)
// endpoints and score how EU-sovereign the hosting + route is.
app.get('/api/sovereignty', async (req, res) => {
  const host = parseSiteHost(req.query.url || req.query.domain);
  if (!host) return res.status(400).json({ error: 'enter a domain, e.g. example.com' });
  logQuery('sov', host, clientIp(req));

  // Cache: once a domain has been scored, serve that result instantly. Only a
  // ?fresh=1 "retest" re-traces (and only that path consumes the rate limit).
  const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
  const cached = sovCache.get(host);
  const fresh_ok = cached && Date.now() - cached.at < SOV_TTL_MS;
  if (!fresh && fresh_ok) return res.json({ ...cached.data, cached: true, at: cached.at });

  const wait = rateLimit(clientIp(req));
  if (wait) {
    // rate-limited but we have a prior result → serve it rather than erroring
    if (cached) return res.json({ ...cached.data, cached: true, at: cached.at, rateLimited: true });
    return res.status(429).set('Retry-After', String(wait)).json({ error: `rate limited — one check per ${RATE_MS / 1000}s (try again in ${wait}s)` });
  }
  if (SOV.inflight >= SOV.maxInflight) {
    if (cached) return res.json({ ...cached.data, cached: true, at: cached.at });
    return res.status(429).json({ error: 'busy — try again shortly' });
  }
  SOV.inflight++;
  try {
    const t = await resolveWebMail(host);
    if (!t.web.length && !t.mail.length) {
      return res.status(404).json({ error: `could not resolve web or mail servers for ${host}` });
    }
    // trace the primary server of each category (the one that's scored)
    const [webHops, mailHops] = await Promise.all([
      t.web[0] ? traceOnce(t.web[0].ip).then((r) => r.hops) : Promise.resolve([]),
      t.mail[0] ? traceOnce(t.mail[0].ip).then((r) => r.hops) : Promise.resolve([]),
    ]);
    const web = scoreCategory(serversWithGeo(t.web), webHops);
    const mail = scoreCategory(serversWithGeo(t.mail), mailHops);
    const data = { domain: host, mailDomain: t.mailDomain, web, mail };
    const at = persistSov(data);
    res.json({ ...data, cached: false, at });
  } catch {
    res.status(500).json({ error: 'scan failed' });
  } finally {
    SOV.inflight--;
  }
});

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
  return {
    id: a.id, name: a.name || '', country: a.country || '', cc: a.cc || '', asName: a.asName || '',
    key: `${a.cc || 'xx'}:${a.asn || a.asName || ''}`.toLowerCase(), // stable across reconnects
  };
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

// Per-user (IP) rate limit: at most one trace OR sovereignty check per 20s.
const RATE_MS = Number(process.env.RATE_MS || 20_000);
const lastActionByIp = new Map();
// The edge sets `X-Forwarded-For: <client-ip>, <edge-vrack-ip>`, so the real
// client is the FIRST (leftmost) entry — that's the one we rate-limit on.
function clientIp(req) {
  const xff = (req && req.headers && req.headers['x-forwarded-for']) || '';
  return xff.split(',')[0].trim() || (req && req.socket && req.socket.remoteAddress) || 'unknown';
}
// 0 = allowed (records the hit); otherwise the seconds until the next allowed action.
function rateLimit(ip) {
  const now = Date.now();
  const last = lastActionByIp.get(ip) || 0;
  if (now - last < RATE_MS) return Math.ceil((RATE_MS - (now - last)) / 1000);
  lastActionByIp.set(ip, now);
  if (lastActionByIp.size > 5000) for (const [k, t] of lastActionByIp) if (now - t > RATE_MS) lastActionByIp.delete(k);
  return 0;
}

// Access log of user-entered targets (MTR traces + sovereignty checks). Written
// to stdout AND appended to a TSV on the data volume so it survives restarts.
// `kind` is 'sov' or 'mtr'.
const QUERY_LOG = path.join(path.dirname(DB_PATH), 'queries.log');
function logQuery(kind, value, ip) {
  const line = `${new Date().toISOString()}\t${kind}\t${ip || '-'}\t${String(value).slice(0, 100)}`;
  console.log(`[query] ${line}`);
  fs.appendFile(QUERY_LOG, line + '\n', () => { /* best-effort */ });
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
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
    origin: ORIGIN,
  }));

  const session = { mtr: null, reqs: new Set(), lastMtr: 0, ip };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'mtr') startDistributed(ws, session, msg.ip, msg.vantages);
    else if (msg.type === 'mtr-stop') stopMtr(session);
    else if (msg.type === 'sov') startSovScan(ws, session, msg.url);
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
  if (net.isIP(s)) return true; // IPv4 or IPv6 literal
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

// Offline IP geolocation via bundled DB-IP Lite MMDB files (no runtime API
// calls). City DB → country/city/coords, ASN DB → AS number + organisation.
let cityReader = null, asnReader = null;
const asnNames = new Map(); // ASN -> registered AS name (the org running the AS)
const asnCC = new Map();    // ASN -> RIR registration country (a proxy for owner)
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
      const cc = line.slice(iLast + 1).trim().toUpperCase();
      if (asn && desc) { asnNames.set(asn, desc); if (cc.length === 2) asnCC.set(asn, cc); n++; }
    }
    console.log(`  geo: ${n} AS names loaded`);
  } catch (e) {
    console.warn('  geo: AS names not loaded —', e.message);
  }
}

function asnOrg(asn, fallback) {
  return (asn && asnNames.get(asn)) || fallback || '';
}

// Ultimate corporate owner outside the EU. Matched by AS org NAME (not just the
// registration country) because multinationals register EU-subsidiary ASNs
// inside the EU — e.g. "Amazon Data Services Ireland" (IE) is still US-owned,
// and Belgian "Telenet BV" (BE) is owned by US-listed Liberty Global. A server
// hosted in the EU but owned by such a company is only half-sovereign (subject
// to foreign jurisdiction like the US CLOUD Act). Unlisted orgs fall back to
// the AS registration country.
const NON_EU_OWNERS = [
  { re: /\bgoogle\b/i, cc: 'US' }, { re: /\bmicrosoft\b/i, cc: 'US' }, { re: /\bgithub\b/i, cc: 'US' },
  { re: /\bamazon\b|\baws\b/i, cc: 'US' }, { re: /\bmeta\b|\bfacebook\b/i, cc: 'US' }, { re: /\bapple\b/i, cc: 'US' },
  { re: /\bcloudflare\b/i, cc: 'US' }, { re: /\bakamai\b/i, cc: 'US' }, { re: /\bfastly\b/i, cc: 'US' },
  { re: /\boracle\b/i, cc: 'US' }, { re: /\bibm\b/i, cc: 'US' }, { re: /\bdigitalocean\b/i, cc: 'US' },
  { re: /\blinode\b/i, cc: 'US' }, { re: /\bvultr\b|\bchoopa\b/i, cc: 'US' }, { re: /\bsalesforce\b/i, cc: 'US' },
  { re: /\btelenet\b/i, cc: 'US', parent: 'Liberty Global', onlyReg: ['BE'] },
  { re: /liberty\s*global/i, cc: 'US', parent: 'Liberty Global' },
];

// Determine the effective owner country of an AS (and a parent label if the
// registration country hides the ultimate owner).
function ownerOf(asn, org, physicalCc) {
  const regCc = asnCC.get(asn) || '';
  for (const o of NON_EU_OWNERS) {
    if (o.re.test(org || '') && (!o.onlyReg || o.onlyReg.includes(regCc))) {
      return { cc: o.cc, parent: o.parent || null, euOwned: SOVEREIGN_CC.has(o.cc) };
    }
  }
  const cc = regCc || physicalCc || '';
  return { cc, parent: null, euOwned: !!cc && SOVEREIGN_CC.has(cc) };
}

function geoLookup(ip) {
  if (geoCache.has(ip)) return geoCache.get(ip);
  let g;
  if (!net.isIP(ip)) {                 // not an address (e.g. an unresolved host)
    g = { city: '', country: '', cc: '' };
  } else if (isPrivateIp(ip)) {
    g = { private: true, city: '', country: 'Private network', cc: '' };
  } else {                             // IPv4 or IPv6 — DB-IP MMDBs cover both
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

// Distributed MTR: our own live trace + a one-shot from each selected agent.
async function startDistributed(ws, session, rawTarget, vantages) {
  stopMtr(session);
  if (Date.now() - (session.lastMtr || 0) < 1500) return; // cooldown
  session.lastMtr = Date.now();

  if (!isValidHost(rawTarget)) {
    return ws.send(JSON.stringify({ type: 'mtr', source: 'local', done: true, error: `refused: "${String(rawTarget).slice(0, 64)}"` }));
  }
  logQuery('mtr', rawTarget, session.ip);
  // resolve to a public IP (v4 or v6) — agents require an IP and must never hit
  // private space. Hostnames prefer IPv4 for reachability, falling back to AAAA.
  let ip = rawTarget;
  if (!net.isIP(rawTarget)) {
    try { ip = (await lookupHost(rawTarget)).address; }
    catch { return ws.send(JSON.stringify({ type: 'mtr', source: 'local', done: true, error: 'cannot resolve' })); }
  }
  if (!isPublicIp(ip)) {
    return ws.send(JSON.stringify({ type: 'mtr', source: 'local', done: true, error: 'target must be a public IP' }));
  }
  const wait = rateLimit(session.ip);
  if (wait) {
    return ws.send(JSON.stringify({ type: 'mtr', source: 'local', done: true, error: `rate limited — one trace/check per ${RATE_MS / 1000}s (try again in ${wait}s)` }));
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
// Sovereignty score — resolve a site's web (A/AAAA) and mail (MX) endpoints,
// traceroute each from this server, and score how EU-sovereign the hosting +
// route is. 100 = EU-hosted and EU-routed; 0 = neither.
// ---------------------------------------------------------------------------

// EU-27 (matches the client-side route-sovereignty box).
const EU_CC = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
// Sovereignty set = EU-27 + Switzerland, UK and Iceland (EU adequacy / EEA ties).
const SOVEREIGN_CC = new Set([...EU_CC, 'CH', 'GB', 'IS']);

const SOV = { perCat: 3, inflight: 0, maxInflight: 4 }; // caps to bound fan-out / abuse
const SOV_TTL_MS = Number(process.env.SOV_TTL_MS || 6 * 3600 * 1000); // cache a score for 6h
const sovCache = new Map(); // domain -> { data, at }

// Persist a completed scan: in-memory cache (fast serve) + SQLite (durable,
// powers the ranking and survives restarts). Returns the timestamp.
function persistSov(result) {
  const at = Date.now();
  const web = result.web && result.web.score != null ? result.web.score : null;
  const mail = result.mail && result.mail.score != null ? result.mail.score : null;
  sovCache.set(result.domain, { data: result, at });
  if (sovCache.size > 2000) for (const [k, v] of sovCache) if (at - v.at > SOV_TTL_MS) sovCache.delete(k);
  try { sovUpsertStmt.run({ domain: result.domain, web, mail, data: JSON.stringify(result), at }); } catch { /* best-effort */ }
  return at;
}

// Re-seed the in-memory cache from the DB at startup so scores survive restarts.
function seedSovCache() {
  try {
    let n = 0;
    for (const row of sovSeedStmt.all()) {
      try { sovCache.set(row.domain, { data: JSON.parse(row.data), at: row.at }); n++; } catch { /* skip */ }
    }
    console.log(`  sovereignty: ${n} cached score(s) loaded from disk`);
  } catch (e) { console.warn('  sovereignty: cache seed failed —', e.message); }
}

// One bounded traceroute (no live loop). Returns located hops with geo.
// No sub-second -i: mtr refuses interval < 1s for non-root users.
function traceOnce(ip, { cycles = 3, maxHops = 30, timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn('mtr', ['--json', '-n', '-c', String(cycles), '-m', String(maxHops), '--', ip]); }
    catch { return resolve({ ip, hops: [], error: 'spawn failed' }); }
    let out = '';
    const kill = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', () => {});
    proc.on('error', () => { clearTimeout(kill); resolve({ ip, hops: [], error: 'trace failed' }); });
    proc.on('close', async () => {
      clearTimeout(kill);
      let hubs = [];
      try { hubs = (JSON.parse(out).report || {}).hubs || []; } catch { /* partial */ }
      const hostIps = hubs.map((h) => h.host).filter((h) => h && h !== '???');
      geolocate(hostIps);
      await resolveNames(hostIps);
      const hops = hubs.map((h) => {
        const real = h.host && h.host !== '???';
        return { idx: h.count, host: real ? h.host : null, geo: real ? geoLookup(h.host) : null };
      });
      resolve({ ip, hops });
    });
  });
}

// A registrable domain: ≥2 dot-separated labels ending in a real TLD (or a
// punycode xn-- TLD). Deliberately excludes bare IPs and single-label hosts —
// the sovereignty check is a domain tool.
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9]{2,59})$/;

// A URL or bare domain → the domain (scheme/path/port/www stripped). Returns
// null for anything that isn't a valid domain (IPs included).
function parseSiteHost(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { try { s = new URL(s).hostname; } catch { return null; } }
  else s = s.split(/[/?#]/)[0];
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1); // [v6] → rejected below
  else s = s.replace(/:\d+$/, '');                              // host:port
  s = s.toLowerCase();
  if (net.isIP(s)) return null;                                 // domains only, not bare IPs
  return DOMAIN_RE.test(s) ? s : null;
}

// Common two-label public suffixes — for these the registrable domain is the
// last THREE labels (e.g. bbc.co.uk), otherwise the last two (example.com).
const TWO_LABEL_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.za', 'org.za', 'com.br', 'com.cn', 'com.mx', 'com.tr', 'com.sg', 'com.hk',
  'com.tw', 'com.ua', 'com.pl', 'com.ar', 'com.co',
  'co.jp', 'or.jp', 'ne.jp', 'go.jp', 'ac.jp',
  'co.in', 'co.kr', 'co.il', 'co.id', 'co.th',
]);

// Registrable apex of a hostname (strips sub-domains; MX lives on the apex).
function apexOf(host) {
  if (net.isIP(host)) return host;
  const p = String(host).split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  return TWO_LABEL_TLDS.has(p.slice(-2).join('.')) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}

// Resolve a site's web endpoints (A/AAAA of the host) and mail endpoints (each
// MX's A/AAAA, by priority) — MX is looked up on the apex domain only. Only
// public IPs are kept; counts are capped.
async function resolveWebMail(host) {
  const isIp = !!net.isIP(host);
  const mailDomain = apexOf(host);

  const ipsOf = async (name) => {
    if (net.isIP(name)) return [name];
    const [a, aaaa] = await Promise.all([
      dns.resolve4(name).catch(() => []),
      dns.resolve6(name).catch(() => []),
    ]);
    return [...a, ...aaaa];
  };

  const web = (await ipsOf(host).catch(() => [])).filter(isPublicIp).slice(0, SOV.perCat)
    .map((ip) => ({ ip }));

  const mail = [];
  if (!isIp) {
    const mx = (await dns.resolveMx(mailDomain).catch(() => []))
      .sort((x, y) => x.priority - y.priority).slice(0, SOV.perCat);
    for (const rec of mx) {
      const ips = (await ipsOf(rec.exchange).catch(() => [])).filter(isPublicIp);
      if (ips.length) mail.push({ ip: ips[0], exchange: rec.exchange, priority: rec.priority });
    }
  }
  return { host, mailDomain, web, mail };
}

// Attach geo + corporate ownership to a list of resolved targets. A server is
// fully sovereign (sov=1) only when it's BOTH hosted in the EU AND owned by an
// EU company; EU-hosted but foreign-owned counts half (sov=0.5); non-EU-hosted
// is sov=0.
function serversWithGeo(targets) {
  return targets.map((t) => {
    const g = geoLookup(t.ip) || {};
    const cc = (g.cc || '').toUpperCase();
    const physEu = !!cc && SOVEREIGN_CC.has(cc);
    const owner = ownerOf(g.asn, g.org, cc);
    const sov = !physEu ? 0 : (owner.euOwned ? 1 : 0.5);
    return {
      ip: t.ip, exchange: t.exchange || null, priority: t.priority ?? null,
      cc, country: g.country || '', city: g.city || '',
      as: g.asn ? `AS${g.asn}` : '', asName: g.org || '',
      eu: physEu, ownerCc: owner.cc, ownerParent: owner.parent, euOwned: owner.euOwned, sov,
    };
  });
}

// Score one category (web | mail) from its geo-tagged servers + the traced
// route to the primary server. Hosting sovereignty dominates (70%, and is
// halved for EU-hosted-but-foreign-owned servers); transit route refines it (30%).
function scoreCategory(servers, hops) {
  const located = servers.filter((s) => s.cc);
  const serversFrac = located.length ? located.reduce((a, s) => a + s.sov, 0) / located.length : null;

  let n = 0, hopsNonEu = 0; const asCc = new Map();
  for (const h of hops || []) {
    const g = h.geo; if (!g || g.private) continue;
    const cc = (g.cc || '').toUpperCase(); if (!cc) continue;
    n++; if (!SOVEREIGN_CC.has(cc)) hopsNonEu++;
    if (g.asn && !asCc.has(g.asn)) asCc.set(g.asn, cc);
  }
  const nets = [...asCc.values()];
  const netsNonEu = nets.filter((cc) => !SOVEREIGN_CC.has(cc)).length;
  const hopsNonEuFrac = n ? hopsNonEu / n : null;
  const netsNonEuFrac = nets.length ? netsNonEu / nets.length : null;

  let score = null;
  if (serversFrac != null && n > 0) {
    const transit = 1 - 0.5 * hopsNonEuFrac - 0.5 * netsNonEuFrac;
    score = Math.round(100 * (0.7 * serversFrac + 0.3 * transit));
  } else if (serversFrac != null) {
    score = Math.round(100 * serversFrac);
  }
  return {
    score,
    servers,
    transit: n ? {
      hops: n, nets: nets.length,
      hopsNonEuPct: Math.round(100 * hopsNonEuFrac),
      netsNonEuPct: Math.round(100 * netsNonEuFrac),
    } : null,
  };
}

// Live traceroute (mtr --raw) that streams hops as they're discovered. Calls
// onUpdate(hops[]) as hops/latencies arrive (throttled); resolves with the
// final hop list. Raw lines: `h <hop> <ip>`, `p <hop> <rtt_usec> <seq>`.
function traceStream(ip, onUpdate, { cycles = 3, maxHops = 30, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    // no sub-second -i: mtr refuses interval < 1s for non-root users
    try { proc = spawn('mtr', ['--raw', '-n', '-c', String(cycles), '-m', String(maxHops), '--', ip]); }
    catch { return resolve([]); }
    const hops = new Map();           // hopIndex -> { idx, host, last }
    let buf = '', settle = null, done = false;
    const kill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);

    const snapshot = () => [...hops.values()].sort((a, b) => a.idx - b.idx)
      .map((h) => ({ idx: h.idx, host: h.host || null, last: h.last ?? null, geo: h.host ? geoLookup(h.host) : null }));
    const flush = () => { settle = null; if (!done) onUpdate(snapshot()); };
    const throttled = () => { if (!settle) settle = setTimeout(flush, 140); };

    proc.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      let changed = false;
      for (const line of lines) {
        const p = line.trim().split(/\s+/);
        if (p.length < 3) continue;
        const n = Number(p[1]);
        if (!Number.isInteger(n) || n < 0 || n > maxHops) continue;
        const cur = hops.get(n) || { idx: n + 1 };
        if (p[0] === 'h' && cur.host !== p[2]) { cur.host = p[2]; hops.set(n, cur); changed = true; }
        else if (p[0] === 'p') { const ms = Number(p[2]) / 1000; if (Number.isFinite(ms)) { cur.last = ms; hops.set(n, cur); changed = true; } }
      }
      if (changed) throttled();
    });
    proc.stderr.on('data', () => {});
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(kill); if (settle) clearTimeout(settle);
      resolve(snapshot());
    };
    proc.on('error', finish);
    proc.on('close', finish);
  });
}

// Streamed sovereignty scan (over the browser WS): resolve → live hops per
// primary route → final scores.
async function startSovScan(ws, session, rawUrl) {
  const sendMsg = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'sov', ...o })); };
  const host = parseSiteHost(rawUrl);
  if (!host) return sendMsg({ phase: 'error', error: 'enter a domain, e.g. example.com' });
  logQuery('sov', host, session.ip);
  const wait = rateLimit(session.ip);
  if (wait) return sendMsg({ phase: 'error', error: `rate limited — one trace/check per ${RATE_MS / 1000}s (try again in ${wait}s)` });
  if (SOV.inflight >= SOV.maxInflight) return sendMsg({ phase: 'error', error: 'busy — try again shortly' });
  SOV.inflight++;
  try {
    const t = await resolveWebMail(host);
    if (!t.web.length && !t.mail.length) return sendMsg({ phase: 'error', error: `could not resolve web or mail servers for ${host}` });
    const webServers = serversWithGeo(t.web), mailServers = serversWithGeo(t.mail);
    sendMsg({ phase: 'resolved', domain: host, mailDomain: t.mailDomain, web: webServers, mail: mailServers });

    // trace the primary server of each category, streaming hops as they arrive
    const [webHops, mailHops] = await Promise.all([
      t.web[0] ? traceStream(t.web[0].ip, (hops) => sendMsg({ phase: 'trace', cat: 'web', hops })) : Promise.resolve([]),
      t.mail[0] ? traceStream(t.mail[0].ip, (hops) => sendMsg({ phase: 'trace', cat: 'mail', hops })) : Promise.resolve([]),
    ]);
    const web = t.web.length ? scoreCategory(webServers, webHops) : null;
    const mail = t.mail.length ? scoreCategory(mailServers, mailHops) : null;
    persistSov({ domain: host, mailDomain: t.mailDomain, web, mail });
    sendMsg({ phase: 'done', domain: host, mailDomain: t.mailDomain, web, mail });
  } catch {
    sendMsg({ phase: 'error', error: 'scan failed' });
  } finally {
    SOV.inflight--;
  }
}

// ---------------------------------------------------------------------------
// Startup: load geo DBs, build+enrich the catalog from probes.conf, then serve.
// ---------------------------------------------------------------------------
async function main() {
  await loadGeo();
  PROBES = await buildCatalog();
  PROBE_BY_IP = new Map(PROBES.map((p) => [p.ip, p]));
  PRESELECTED = computePreselected();
  ORIGIN = computeOrigin();
  seedHistory();
  seedSovCache();
  loop();
  server.listen(PORT, () => {
    console.log(`\n  PingScope running →  http://localhost:${PORT}\n`);
    const byType = (t) => PROBES.filter((p) => p.type === t).length;
    console.log(`  Catalog: ${PROBES.length} probes (dns=${byType('dns')} isp=${byType('isp')} cloud=${byType('cloud')}) · ${PRESELECTED.length} preselected`);
    console.log(`  Community agents: ${AGENT_TOKEN ? 'ENABLED (token set)' : 'disabled — set AGENT_TOKEN to allow agents'}`);
    console.log('');
    // Opt-in ping-history salvage (RECOVER_SAMPLES=1). It reads a 1GB+ corrupt
    // file and can saturate a small instance, so it is OFF by default and must
    // be enabled deliberately (ideally on a temporarily larger instance).
    if (process.env.RECOVER_SAMPLES === '1') {
      setTimeout(() => { salvageSamples().catch((e) => console.warn('  db: samples salvage error —', e.message)); }, 15_000);
    }
  });
}
main().catch((e) => { console.error('startup failed:', e); process.exit(1); });
