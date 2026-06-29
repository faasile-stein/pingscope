// 2D "show all" overview — a SmokePing-style grid of small multiples. Each probe
// gets its own graph: grey "smoke" (min–max + p25–p75 spread) under a median line
// coloured by packet loss (green → yellow → orange → red → purple, SmokePing
// style), with ms gridlines, a time axis and a stats line.

// SmokePing-like loss colour ramp (fraction 0..1)
const LOSS_STOPS = [
  [0.00, [46, 204, 64]],   // green — no loss
  [0.05, [255, 220, 0]],   // yellow
  [0.20, [255, 133, 27]],  // orange
  [0.50, [255, 65, 54]],   // red
  [1.00, [177, 13, 201]],  // purple — heavy loss
];
function lossRGB(loss) {
  const f = Math.min(1, Math.max(0, loss || 0));
  for (let i = 1; i < LOSS_STOPS.length; i++) {
    if (f <= LOSS_STOPS[i][0]) {
      const [t0, c0] = LOSS_STOPS[i - 1], [t1, c1] = LOSS_STOPS[i];
      const k = (f - t0) / (t1 - t0 || 1);
      return c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
    }
  }
  return LOSS_STOPS[LOSS_STOPS.length - 1][1];
}
function niceMax(v) {
  if (v <= 1) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v))), n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
const flag = (cc) => (!cc || cc.length !== 2) ? '🌐'
  : cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ms = (v) => (v == null ? '—' : (v < 10 ? v.toFixed(1) : Math.round(v)) + 'ms');

const PADL = 30, PADB = 14, PADT = 6, PADR = 4; // axis margins inside each canvas

class Overview {
  constructor() { this.cells = new Map(); this.live = true; this.spanMs = 120000; this.end = 0; this.visible = false; }

  init(container) {
    this.container = container;
    this.legend = document.createElement('div');
    this.legend.className = 'ov-legend';
    this.legend.innerHTML = '<span>packet loss</span>'
      + '<i style="background:linear-gradient(90deg,#2ecc40,#ffdc00,#ff851b,#ff4136,#b10dc9)"></i>'
      + '<span class="ov-lg0">0%</span><span class="ov-lg1">100%</span>';
  }
  setLiveWindow(sec) { this.live = true; this.spanMs = sec * 1000; }
  setHistoryWindow(from, to) { this.live = false; this.end = to; this.spanMs = Math.max(1000, to - from); }
  show() { this.visible = true; this.container.style.display = ''; }
  hide() { this.visible = false; this.container.style.display = 'none'; }

  // probes: [{ id, label, net, cc, anycast, samples }] in display order
  render(probes) {
    if (!this.visible) return;
    const want = new Set(probes.map((p) => p.id));
    for (const [id, cell] of [...this.cells]) {
      if (!want.has(id)) { cell.root.remove(); this.cells.delete(id); }
    }
    if (this.legend.parentNode !== this.container) this.container.appendChild(this.legend);
    for (const p of probes) {
      let cell = this.cells.get(p.id);
      if (!cell) { cell = this._makeCell(p); this.cells.set(p.id, cell); }
      this.container.appendChild(cell.root);
      this._draw(cell, p);
    }
  }

  _makeCell(p) {
    const root = document.createElement('div');
    root.className = 'ov-cell';
    root.innerHTML =
      `<div class="ov-head"><span class="ov-name" title="${esc(p.label || p.id)}">${esc(p.label || p.id)}</span>`
      + `<span class="ov-now"></span></div>`;
    const canvas = document.createElement('canvas');
    canvas.className = 'ov-canvas';
    root.appendChild(canvas);
    const foot = document.createElement('div');
    foot.className = 'ov-foot';
    root.appendChild(foot);
    return { root, canvas, now: root.querySelector('.ov-now'), foot };
  }

  _draw(cell, p) {
    const canvas = cell.canvas;
    const cw = canvas.clientWidth || 280, ch = canvas.clientHeight || 120;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) { canvas.width = cw * dpr; canvas.height = ch * dpr; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const now = this.live ? Date.now() : this.end, span = this.spanMs;
    const vis = (p.samples || []).filter((s) => now - s.t <= span + 1000 && s.t <= now + 1000);
    const last = vis.length ? vis[vis.length - 1] : null;

    // header + footer stats
    cell.now.innerHTML = last
      ? `<b style="color:rgb(${lossRGB(last.loss).join(',')})">${ms(last.median)}</b>${last.loss > 0 ? ` <i>${Math.round(last.loss * 100)}%</i>` : ''}`
      : '<b>—</b>';
    const med = vis.filter((s) => s.median != null);
    const avg = med.length ? med.reduce((a, s) => a + s.median, 0) / med.length : null;
    const mx = vis.reduce((a, s) => Math.max(a, s.max ?? 0), 0) || null;
    const lossAvg = vis.length ? vis.reduce((a, s) => a + (s.loss || 0), 0) / vis.length : 0;
    cell.foot.innerHTML = `${flag(p.cc)} ${esc(p.anycast ? 'anycast' : (p.net || '—'))}`
      + ` · avg ${ms(avg)} · max ${ms(mx)} · <span class="ov-loss" style="color:rgb(${lossRGB(lossAvg).join(',')})">${Math.round(lossAvg * 100)}% loss</span>`;

    const plotW = cw - PADL - PADR, plotH = ch - PADT - PADB;
    const X = (t) => PADL + plotW - ((now - t) / span) * plotW;
    let yMax = 1; for (const s of vis) if (s.max != null) yMax = Math.max(yMax, s.max);
    yMax = niceMax(yMax * 1.12);
    const Y = (v) => PADT + plotH - (Math.min(v, yMax) / yMax) * plotH;

    // ---- axes: ms gridlines + labels (Y), time labels (X) ----
    ctx.font = '9px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 2; i++) {
      const v = (yMax / 2) * i, y = Y(v);
      ctx.strokeStyle = 'rgba(120,150,220,0.10)'; ctx.beginPath(); ctx.moveTo(PADL, y); ctx.lineTo(cw - PADR, y); ctx.stroke();
      ctx.fillStyle = 'rgba(126,136,171,0.7)'; ctx.textAlign = 'right'; ctx.fillText(v < 10 && v > 0 ? v.toFixed(1) : String(Math.round(v)), PADL - 4, y);
    }
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
    for (let i = 0; i <= 2; i++) {
      const frac = i / 2, x = PADL + frac * plotW;
      let t;
      if (this.live) {
        const ageSec = (1 - frac) * (span / 1000);
        t = ageSec < 1 ? 'now' : ageSec < 60 ? `-${Math.round(ageSec)}s` : `-${(ageSec / 60).toFixed(ageSec % 60 ? 1 : 0)}m`;
      } else {
        const d = new Date(now - (1 - frac) * span);
        t = span > 2 * 864e5 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      ctx.fillStyle = 'rgba(126,136,171,0.55)'; ctx.fillText(t, Math.min(cw - 16, Math.max(PADL + 12, x)), ch - 3);
    }
    if (vis.length < 2) return;

    // ---- grey smoke (min–max, then p25–p75) ----
    const band = (lowFn, highFn, alpha) => {
      ctx.beginPath(); let started = false;
      for (let i = 0; i < vis.length; i++) { const s = vis[i]; const h = highFn(s); if (h == null) continue; const px = X(s.t), py = Y(h); started ? ctx.lineTo(px, py) : ctx.moveTo(px, py); started = true; }
      for (let i = vis.length - 1; i >= 0; i--) { const s = vis[i]; const l = lowFn(s); if (l == null) continue; ctx.lineTo(X(s.t), Y(l)); }
      ctx.closePath(); ctx.fillStyle = `rgba(150,170,210,${alpha})`; ctx.fill();
    };
    band((s) => s.min, (s) => s.max, 0.10);
    band((s) => s.p25 ?? s.min, (s) => s.p75 ?? s.max, 0.16);

    // ---- median line, coloured per segment by loss ----
    ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    let prev = null;
    for (const s of vis) {
      if (s.median == null) { prev = null; continue; }
      const px = X(s.t), py = Y(s.median);
      if (prev) {
        const c = lossRGB(s.loss);
        ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(px, py); ctx.stroke();
      }
      prev = { x: px, y: py };
    }
  }
}

export default new Overview();
