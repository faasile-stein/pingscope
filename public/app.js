import Graph from './graph.js';
import MtrMap from './mtr.js';

const canvas = document.getElementById('scene');
Graph.init(canvas);

const TYPE_COLOR = { dns: '#4ad8ff', isp: '#ff8a3d', cloud: '#b78bff' };
const laneColor = (p) => (p.anycast ? '#ffd23f' : (TYPE_COLOR[p.type] || '#4ad8ff'));
const ccFlag = (cc) => (!cc || cc.length !== 2) ? '🌐'
  : cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));

const state = {
  probes: [],
  byId: new Map(),
  selected: new Set(),
  latest: new Map(),   // id -> last sample (for selector live stats)
  live: new Map(),     // id -> rolling buffer (selected probes)
  paused: false,
  tickMs: 1000,
  view: { mode: 'live', rangeMs: null, to: null },
  filterType: 'all',
  search: '',
};
const selectedProbes = () => state.probes.filter((p) => state.selected.has(p.id));

// ---------------------------------------------------------------------------
// Probe selector
// ---------------------------------------------------------------------------
const selList = document.getElementById('sel-list');
const selCount = document.getElementById('sel-count');

// mobile drawer
const selectorEl = document.getElementById('selector');
const selBackdrop = document.getElementById('sel-backdrop');
function setDrawer(open) {
  selectorEl.classList.toggle('open', open);
  selBackdrop.classList.toggle('show', open);
}
document.getElementById('menu-toggle').addEventListener('click', () => setDrawer(!selectorEl.classList.contains('open')));
selBackdrop.addEventListener('click', () => setDrawer(false));

function buildSelector() {
  selList.innerHTML = '';
  for (const type of ['dns', 'isp', 'cloud']) {
    const inType = state.probes.filter((p) => p.type === type);
    if (!inType.length) continue;
    const byCC = new Map();
    for (const p of inType) {
      const k = p.anycast ? 'Anycast' : (p.country || 'Unknown');
      if (!byCC.has(k)) byCC.set(k, []);
      byCC.get(k).push(p);
    }
    const tEl = document.createElement('div');
    tEl.className = 'sel-type'; tEl.dataset.type = type;
    tEl.innerHTML = `<div class="sel-type-h" style="--c:${TYPE_COLOR[type]}">${type.toUpperCase()}<span class="sel-type-n">${inType.length}</span></div>`;
    for (const [cc, list] of byCC) {
      const g = document.createElement('div');
      g.className = 'sel-grp';
      const flag = list[0].anycast ? '🌐' : ccFlag(list[0].cc);
      g.innerHTML = `<div class="sel-grp-h">${flag} ${cc}</div>`;
      for (const p of list) g.appendChild(rowEl(p));
      tEl.appendChild(g);
    }
    selList.appendChild(tEl);
  }
  refreshCount();
}

function rowEl(p) {
  const r = document.createElement('div');
  r.className = 'sel-row'; r.dataset.id = p.id;
  r.style.setProperty('--c', laneColor(p));
  const ptrHref = p.ptr ? `//${p.ptr}` : `https://bgp.he.net/ip/${p.ip}`;
  const ptrTitle = p.ptr ? `open PTR: ${p.ptr}` : `lookup ${p.ip}`;
  r.innerHTML =
    `<input type="checkbox" class="sel-cb"${state.selected.has(p.id) ? ' checked' : ''}>` +
    `<span class="sel-dot"></span>` +
    `<a class="sel-name" href="${ptrHref}" target="_blank" rel="noopener" title="${ptrTitle}">${p.provider}</a>` +
    `<button class="sel-mtr" title="run MTR → ${p.ip}">mtr</button>` +
    `<span class="sel-loc">${p.city ? p.city + ', ' : ''}${p.anycast ? 'anycast' : (p.cc || '')}</span>` +
    `<span class="sel-ms">—</span><span class="sel-loss"></span>`;
  return r;
}

selList.addEventListener('change', (e) => {
  if (!e.target.classList.contains('sel-cb')) return;
  toggleSelect(e.target.closest('.sel-row').dataset.id, e.target.checked);
});
selList.addEventListener('click', (e) => {
  const btn = e.target.closest('.sel-mtr');
  if (!btn) return;
  e.preventDefault();
  const p = state.byId.get(btn.closest('.sel-row').dataset.id);
  if (p) { mtrIp.value = p.ip; setDrawer(false); openMtr(p.ip); }
});

function toggleSelect(id, on) {
  if (on) state.selected.add(id); else state.selected.delete(id);
  applySelection();
  if (on) { const buf = state.live.get(id); if (!buf || !buf.length) seedHistory(id); }
  refreshCount();
}

function applySelection() {
  const sel = selectedProbes();
  Graph.setSelection(sel);
  if (state.view.mode === 'live') {
    for (const p of sel) Graph.setHistory(p.id, state.live.get(p.id) || []);
    Graph.setLiveMode();
  } else {
    enterHistory(state.view.rangeMs, state.view.to);
  }
}

async function seedHistory(id) {
  try {
    const res = await fetch(`/api/history?target=${id}&from=${Date.now() - state.tickMs * 600}&to=${Date.now()}&buckets=300`);
    const pts = (await res.json()).targets[id] || [];
    state.live.set(id, pts.slice(-600));
    if (state.view.mode === 'live') Graph.setHistory(id, state.live.get(id));
  } catch { /* ignore */ }
}

function refreshCount() {
  selCount.textContent = `${state.selected.size} / ${state.probes.length}`;
  selList.querySelectorAll('.sel-row').forEach((r) => r.classList.toggle('on', state.selected.has(r.dataset.id)));
}

function updateRow(s) {
  const r = selList.querySelector(`.sel-row[data-id="${s.targetId}"]`);
  if (!r) return;
  const ms = r.querySelector('.sel-ms'), loss = r.querySelector('.sel-loss');
  ms.textContent = s.median != null ? s.median.toFixed(0) + 'ms' : '✕';
  ms.style.color = s.loss > 0 ? '#ff3b6b' : 'var(--muted)';
  loss.textContent = s.loss > 0 ? Math.round(s.loss * 100) + '%' : '';
}

// filter + bulk actions
const selSearch = document.getElementById('sel-search');
selSearch.addEventListener('input', () => { state.search = selSearch.value.toLowerCase(); applyFilter(); });
document.querySelectorAll('.sel-tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.sel-tab').forEach((x) => x.classList.remove('on'));
  t.classList.add('on'); state.filterType = t.dataset.type; applyFilter();
}));
function applyFilter() {
  selList.querySelectorAll('.sel-type').forEach((te) => {
    te.style.display = (state.filterType === 'all' || state.filterType === te.dataset.type) ? '' : 'none';
  });
  selList.querySelectorAll('.sel-row').forEach((r) => {
    const p = state.byId.get(r.dataset.id);
    const hay = `${p.provider} ${p.country} ${p.city} ${p.ip} ${p.asName}`.toLowerCase();
    r.style.display = hay.includes(state.search) ? '' : 'none';
  });
}
document.getElementById('sel-clear').addEventListener('click', () => {
  state.selected.clear();
  selList.querySelectorAll('.sel-cb').forEach((cb) => (cb.checked = false));
  applySelection(); refreshCount();
});

// ---------------------------------------------------------------------------
// Hover readout (3D graph)
// ---------------------------------------------------------------------------
const readout = document.getElementById('readout');
Graph.onHover = (info) => {
  if (!info) { readout.classList.add('hidden'); return; }
  const { lane, sample, ageSec, when, client } = info;
  const p = lane.probe || {};
  readout.classList.remove('hidden');
  readout.style.setProperty('--c', laneColor(p));
  readout.style.left = client.x + 'px';
  readout.style.top = client.y + 'px';
  const f = (v) => (v == null ? '—' : v.toFixed(1) + 'ms');
  const stamp = state.view.mode === 'history' || ageSec > 600
    ? new Date(when).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : `${ageSec}s ago`;
  readout.innerHTML =
    `<div><b>${p.provider || lane.label}</b> ${p.anycast ? 'anycast' : (p.cc || '')} · ${stamp}</div>` +
    `<div class="rt">${f(sample.median)}</div>` +
    `<div>min ${f(sample.min)} · max ${f(sample.max)} · loss ${Math.round(sample.loss * 100)}%</div>` +
    (p.asName ? `<div>${p.as || ''} ${p.asName}</div>` : '') +
    (p.ptr ? `<div class="muted">${p.ptr}</div>` : '');
};

// ---------------------------------------------------------------------------
// WebSocket feed
// ---------------------------------------------------------------------------
const dot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');
let ws;

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => { dot.className = 'dot live'; connText.textContent = 'live'; };
  ws.onclose = () => { dot.className = 'dot dead'; connText.textContent = 'reconnecting…'; setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'init') {
      state.probes = msg.probes;
      state.byId = new Map(msg.probes.map((p) => [p.id, p]));
      state.tickMs = msg.tickMs || 1000;
      state.selected = new Set(msg.preselected);
      buildSelector();
      const sel = selectedProbes();
      Graph.setSelection(sel);
      for (const p of sel) {
        const h = msg.history[p.id] || [];
        state.live.set(p.id, h.slice(-600));
        Graph.setHistory(p.id, h);
      }
      state.agents = msg.agents || [];
      renderVantages();
      if (!state.shareApplied) { state.shareApplied = true; applyShareParams(); }
    } else if (msg.type === 'agents') {
      state.agents = msg.agents || [];
      renderVantages();
    } else if (msg.type === 'samples') {
      for (const s of msg.data) {
        state.latest.set(s.targetId, s);
        updateRow(s);
        if (state.selected.has(s.targetId)) {
          const buf = state.live.get(s.targetId) || [];
          buf.push(s); if (buf.length > 600) buf.shift();
          state.live.set(s.targetId, buf);
          if (state.view.mode === 'live' && !state.paused) Graph.pushSample(s);
        }
      }
    } else if (msg.type === 'mtr') {
      handleMtr(msg);
    }
  };
}
connect();

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
const btnRotate = document.getElementById('btn-rotate');
btnRotate.onclick = () => Graph.setAutoRotate(btnRotate.classList.toggle('on'));
const btnPause = document.getElementById('btn-pause');
btnPause.onclick = () => {
  state.paused = btnPause.classList.toggle('on');
  btnPause.textContent = state.paused ? 'resume feed' : 'pause feed';
};
const windowRange = document.getElementById('window-range');
const windowVal = document.getElementById('window-val');
windowRange.oninput = () => { windowVal.textContent = windowRange.value + 's'; Graph.setWindow(+windowRange.value); };

// ---------------------------------------------------------------------------
// Time machine — browse historic stats like SmokePing
// ---------------------------------------------------------------------------
const tmBar = document.getElementById('timemachine');
const tmLabel = document.getElementById('tm-label');
const tmPrev = document.getElementById('tm-prev');
const tmNext = document.getElementById('tm-next');

function setActiveButton(range) {
  tmBar.querySelectorAll('.tm:not(.nav)').forEach((b) => b.classList.toggle('on', b.dataset.range === range));
}

function goLive() {
  state.view = { mode: 'live', rangeMs: null, to: null };
  setActiveButton('live');
  tmPrev.disabled = tmNext.disabled = true;
  tmLabel.textContent = 'streaming live';
  windowRange.disabled = false;
  for (const p of selectedProbes()) Graph.setHistory(p.id, state.live.get(p.id) || []);
  Graph.setWindow(+windowRange.value);
  Graph.setLiveMode();
}

const fmt = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function enterHistory(rangeMs, toOverride) {
  const to = toOverride ?? Date.now();
  const from = to - rangeMs;
  state.view = { mode: 'history', rangeMs, to };
  setActiveButton(String(rangeMs));
  windowRange.disabled = true;
  tmPrev.disabled = false;
  tmNext.disabled = to >= Date.now();
  tmLabel.textContent = `${fmt(from)} → ${fmt(to)}`;
  const ids = [...state.selected];
  if (!ids.length) { Graph.setHistoryWindow(from, to); return; }
  try {
    const res = await fetch(`/api/history?target=${ids.join(',')}&from=${from}&to=${to}&buckets=240`);
    const data = await res.json();
    for (const id of ids) Graph.setHistory(id, data.targets[id] || []);
    Graph.setHistoryWindow(from, to);
  } catch (e) {
    tmLabel.textContent = 'history fetch failed';
  }
}

tmBar.querySelectorAll('.tm:not(.nav)').forEach((btn) => {
  btn.onclick = () => (btn.dataset.range === 'live' ? goLive() : enterHistory(Number(btn.dataset.range)));
});
tmPrev.onclick = () => { if (state.view.mode === 'history') enterHistory(state.view.rangeMs, state.view.to - state.view.rangeMs); };
tmNext.onclick = () => { if (state.view.mode === 'history') enterHistory(state.view.rangeMs, Math.min(Date.now(), state.view.to + state.view.rangeMs)); };

// ---------------------------------------------------------------------------
// MTR (live latency map)
// ---------------------------------------------------------------------------
const mtrForm = document.getElementById('mtr-form');
const mtrIp = document.getElementById('mtr-ip');
const mtrGo = document.getElementById('mtr-go');
const mtrStage = document.getElementById('mtr-stage');
const stageTarget = document.getElementById('stage-target');
const stageMeta = document.getElementById('stage-meta');
const stageClose = document.getElementById('stage-close');

MtrMap.init(document.getElementById('mtr-canvas'));

// hover detail card: full per-hop info (name, AS, city, loss, jitter)
const mtrTip = document.getElementById('mtr-tip');
const cc2flag = (cc) => (!cc || cc.length !== 2) ? '🌐'
  : cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
function lossCss(loss) {
  const f = Math.max(0, Math.min(1, loss / 100));
  const lerp = (a, b) => Math.round(a + (b - a) * (f < 0.5 ? f / 0.5 : (f - 0.5) / 0.5));
  const [a, b] = f < 0.5 ? [[54, 241, 163], [255, 210, 63]] : [[255, 210, 63], [255, 59, 107]];
  return `rgb(${lerp(a[0], b[0])},${lerp(a[1], b[1])},${lerp(a[2], b[2])})`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- vantage points (this server + community agents) ----
const VANTAGE_COLORS = ['#ff8a3d', '#b78bff', '#36f1a3', '#ff3b6b', '#ffd23f', '#ff6ad5', '#9aff66', '#4adcff'];
state.vantages = state.vantages || new Set();
const colorBySource = new Map([['local', '#4ad8ff']]);
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function colorFor(source) {
  if (!colorBySource.has(source)) colorBySource.set(source, VANTAGE_COLORS[(colorBySource.size - 1) % VANTAGE_COLORS.length]);
  return colorBySource.get(source);
}
function trackMeta(source, agent) {
  if (source === 'local') return { label: '◉ this server (fr1)', color: hexRgb('#4ad8ff'), cc: '' };
  const a = agent || {};
  const fe = a.cc ? cc2flag(a.cc) : '🌐';
  const label = `${fe} ${a.country || 'agent'}${a.asName ? ' · ' + a.asName : ''}${a.name ? ' (' + a.name + ')' : ''}`;
  return { label, color: hexRgb(colorFor(source)), cc: a.cc || '' };
}

const vantagesEl = document.getElementById('mtr-vantages');
let currentMtrTarget = '';
function renderVantages() {
  const agents = state.agents || [];
  state.agentById = new Map(agents.map((a) => [a.id, a]));
  for (const id of [...state.vantages]) if (!agents.some((a) => a.id === id)) state.vantages.delete(id);
  let html = `<span class="vh">vantages — ◉ this server + ${agents.length} community online</span>`;
  html += `<span class="vchip fixed" title="the PingScope server">◉ this server</span>`;
  for (const a of agents) {
    const fe = a.cc ? cc2flag(a.cc) : '🌐';
    html += `<span class="vchip${state.vantages.has(a.id) ? ' on' : ''}" data-id="${a.id}" style="--c:${colorFor(a.id)}" title="${esc(a.asName || '')}">${fe} ${esc(a.country || '?')}${a.name ? ' · ' + esc(a.name) : ''}</span>`;
  }
  if (!agents.length) html += `<span class="vchip" style="pointer-events:none;opacity:.55">no community vantages online</span>`;
  vantagesEl.innerHTML = html;
  vantagesEl.querySelectorAll('.vchip[data-id]').forEach((chip) => chip.onclick = () => {
    const id = chip.dataset.id;
    state.vantages.has(id) ? state.vantages.delete(id) : state.vantages.add(id);
    chip.classList.toggle('on');
  });
}
renderVantages();

MtrMap.onHover = (info) => {
  if (!info) { mtrTip.classList.add('hidden'); return; }
  const h = info.hop, g = h.geo || {};
  const priv = g.private;
  const f = (v) => (v != null ? v.toFixed(1) : '—');
  const fe = priv ? '🏠' : (g.cc ? cc2flag(g.cc) : '🌐');
  const country = priv ? 'Private network' : (g.country || 'Unknown');
  const city = (!priv && g.city) ? ' · ' + g.city : '';
  const name = h.rdns || h.host || '';
  const as = (!priv && (g.asn || g.org)) ? `${g.asn ? 'AS' + g.asn + ' ' : ''}${g.org || ''}` : '';
  const loss = Math.round(h.loss || 0);
  mtrTip.style.setProperty('--c', lossCss(h.loss || 0));
  mtrTip.style.left = Math.max(120, Math.min(window.innerWidth - 120, info.cx)) + 'px';
  mtrTip.style.top = Math.max(140, info.cy) + 'px';
  mtrTip.innerHTML =
    (info.track && info.track.label ? `<div class="tip-row" style="margin-bottom:3px">${esc(info.track.label)}</div>` : '') +
    `<div class="tip-head"><span>#${h.idx} · ${fe} ${esc(country)}${esc(city)}</span><span class="tip-rt">${f(h.last)}ms</span></div>` +
    `<div class="tip-name">${esc(name)}</div>` +
    (as ? `<div class="tip-as">${esc(as)}</div>` : '') +
    `<div class="tip-row">avg <b>${f(h.avg)}ms</b> · loss <b class="${loss > 0 ? 'tip-loss' : ''}">${loss}%</b> · jitter <b>${f(h.stdev)}ms</b></div>` +
    `<div class="tip-row">best <b>${f(h.best)}</b> · worst <b>${f(h.wrst)}</b> · last <b>${f(h.last)}ms</b></div>`;
  mtrTip.classList.remove('hidden');
};

function openMtr(ip) {
  if (!ip || ws.readyState !== 1) return;
  currentMtrTarget = ip;
  stageTarget.textContent = ip;
  stageMeta.textContent = 'starting…';
  mtrStage.classList.remove('hidden');
  document.body.classList.add('mtr-open');
  MtrMap.open(ip);
  ws.send(JSON.stringify({ type: 'mtr', ip, vantages: [...state.vantages] }));
  mtrGo.disabled = true;
  mtrGo.textContent = '● live';
}

function closeMtr() {
  mtrStage.classList.add('hidden');
  document.body.classList.remove('mtr-open');
  mtrTip.classList.add('hidden');
  MtrMap.close();
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'mtr-stop' }));
  mtrGo.disabled = false;
  mtrGo.textContent = '▶ run';
}

mtrForm.onsubmit = (e) => { e.preventDefault(); openMtr(mtrIp.value.trim()); };
stageClose.onclick = closeMtr;
document.querySelectorAll('.sv').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.sv').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  MtrMap.setMode(b.dataset.mode);
});

// ---- shareable MTR views ----
const shareBtn = document.getElementById('stage-share');
shareBtn.onclick = async () => {
  if (!currentMtrTarget) return;
  const keys = [...new Set([...state.vantages].map((id) => (state.agentById.get(id) || {}).key).filter(Boolean))];
  const url = `${location.origin}/?mtr=${encodeURIComponent(currentMtrTarget)}` + (keys.length ? `&vp=${encodeURIComponent(keys.join(','))}` : '');
  try { await navigator.clipboard.writeText(url); } catch { /* clipboard blocked */ }
  shareBtn.textContent = '✓ link copied'; shareBtn.classList.add('copied');
  setTimeout(() => { shareBtn.textContent = '⤴ share'; shareBtn.classList.remove('copied'); }, 1600);
};

// open a shared MTR from the URL: ?mtr=<target>&vp=<vantage keys>
function applyShareParams() {
  const p = new URLSearchParams(location.search);
  const t = p.get('mtr');
  if (!t) return;
  const keys = (p.get('vp') || '').split(',').filter(Boolean);
  state.vantages = new Set();
  for (const a of (state.agents || [])) if (keys.includes(a.key)) state.vantages.add(a.id);
  renderVantages();
  mtrIp.value = t;
  openMtr(t);
}

function updateStageMeta() {
  const n = MtrMap.order.length;
  stageMeta.textContent = `${n} vantage${n !== 1 ? 's' : ''} → ${stageTarget.textContent}`;
}
function handleMtr(msg) {
  const source = msg.source || 'local';
  const meta = trackMeta(source, msg.agent);
  if (msg.start) { MtrMap.ensureTrack(source, meta); updateStageMeta(); return; }
  if (msg.hops) { MtrMap.setHops(source, msg.hops, meta); updateStageMeta(); }
  if (msg.error) { MtrMap.setTrackError(source, msg.error, meta); }
}
