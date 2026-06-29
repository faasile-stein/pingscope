// 2D "show all" overview — a SmokePing-style grid of small multiples. Each
// selected probe gets a mini smoke graph: translucent min–max and p25–p75 bands
// under a median line, coloured green→orange→red by loss, with red loss ticks.

const GOOD = [54, 241, 163], ORANGE = [255, 157, 61], BAD = [255, 59, 107];
const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function lossRGB(loss) {
  const f = Math.min(1, Math.max(0, loss || 0));
  return f <= 0.5 ? lerp(GOOD, ORANGE, f / 0.5) : lerp(ORANGE, BAD, (f - 0.5) / 0.5);
}
function niceMax(v) {
  if (v <= 1) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v))), n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
const flag = (cc) => (!cc || cc.length !== 2) ? '🌐'
  : cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class Overview {
  constructor() { this.cells = new Map(); this.windowSec = 120; this.visible = false; }

  init(container) { this.container = container; }
  setWindow(sec) { this.windowSec = sec; }
  show() { this.visible = true; this.container.style.display = ''; }
  hide() { this.visible = false; this.container.style.display = 'none'; }

  // probes: [{ id, label, net, cc, anycast, samples }] in display order
  render(probes) {
    if (!this.visible) return;
    const want = new Set(probes.map((p) => p.id));
    for (const [id, cell] of [...this.cells]) {
      if (!want.has(id)) { cell.root.remove(); this.cells.delete(id); }
    }
    for (const p of probes) {
      let cell = this.cells.get(p.id);
      if (!cell) { cell = this._makeCell(p); this.cells.set(p.id, cell); }
      this.container.appendChild(cell.root); // keep DOM order == probe order
      this._draw(cell, p);
    }
  }

  _makeCell(p) {
    const root = document.createElement('div');
    root.className = 'ov-cell';
    root.innerHTML =
      `<div class="ov-head"><span class="ov-name">${esc(p.label || p.id)}</span>`
      + `<span class="ov-stat"></span></div>`
      + `<div class="ov-sub">${flag(p.cc)} ${esc(p.anycast ? 'anycast' : (p.net || ''))}</div>`;
    const canvas = document.createElement('canvas');
    canvas.className = 'ov-canvas';
    root.appendChild(canvas);
    return { root, canvas, stat: root.querySelector('.ov-stat') };
  }

  _draw(cell, p) {
    const canvas = cell.canvas;
    const cw = canvas.clientWidth || 240, ch = canvas.clientHeight || 96;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) { canvas.width = cw * dpr; canvas.height = ch * dpr; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const now = Date.now(), span = this.windowSec * 1000;
    const vis = (p.samples || []).filter((s) => now - s.t <= span + 1000);
    const last = vis.length ? vis[vis.length - 1] : null;
    cell.stat.innerHTML = last
      ? `<b>${last.median != null ? last.median.toFixed(0) + 'ms' : '✕'}</b>${last.loss > 0 ? ` <i>${Math.round(last.loss * 100)}%</i>` : ''}`
      : '<b>—</b>';
    if (vis.length < 2) return;

    let yMax = 1; for (const s of vis) if (s.max != null) yMax = Math.max(yMax, s.max);
    yMax = niceMax(yMax * 1.12);
    const padT = 4, padB = 4;
    const X = (t) => cw - ((now - t) / span) * cw;
    const Y = (ms) => ch - padB - (Math.min(ms, yMax) / yMax) * (ch - padB - padT);

    const avgLoss = vis.reduce((a, s) => a + (s.loss || 0), 0) / vis.length;
    const c = lossRGB(avgLoss);
    const band = (lowFn, highFn, alpha) => {
      ctx.beginPath(); let started = false;
      for (let i = 0; i < vis.length; i++) { const s = vis[i]; const h = highFn(s); if (h == null) continue; const px = X(s.t), py = Y(h); started ? ctx.lineTo(px, py) : ctx.moveTo(px, py); started = true; }
      for (let i = vis.length - 1; i >= 0; i--) { const s = vis[i]; const l = lowFn(s); if (l == null) continue; ctx.lineTo(X(s.t), Y(l)); }
      ctx.closePath(); ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha})`; ctx.fill();
    };
    band((s) => s.min, (s) => s.max, 0.12);                       // outer smoke
    band((s) => s.p25 ?? s.min, (s) => s.p75 ?? s.max, 0.24);     // inner

    // median line
    ctx.beginPath(); let st = false;
    for (const s of vis) { if (s.median == null) continue; const px = X(s.t), py = Y(s.median); st ? ctx.lineTo(px, py) : ctx.moveTo(px, py); st = true; }
    ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.lineWidth = 1.4; ctx.stroke();

    // red loss ticks
    for (const s of vis) {
      if (!(s.loss > 0)) continue;
      const f = Math.min(1, s.loss), px = X(s.t);
      ctx.strokeStyle = `rgba(255,70,90,${0.35 + 0.5 * f})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, ch - padB); ctx.lineTo(px, ch - padB - (ch - padB - padT) * (0.3 + 0.7 * f)); ctx.stroke();
    }

    // y-max label
    ctx.fillStyle = 'rgba(126,136,171,0.6)'; ctx.font = '9px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left';
    ctx.fillText(`${yMax}ms`, 3, 10);
  }
}

export default new Overview();
