// MTR latency map — supports MULTIPLE vantage points ("tracks"): our own server
// plus community agents. Each track is a horizontal band; within it the hops are
// laid out left→right by round-trip time, sharing one ms axis, so paths from
// different origins to the same target line up. Pure 2D canvas.

const GOOD = [54, 241, 163], MID = [255, 210, 63], BAD = [255, 59, 107];
const lerp = (a, b, t) => a + (b - a) * t;
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

function lossColor(loss) {
  const f = Math.max(0, Math.min(1, loss / 100));
  const [c1, c2, t] = f < 0.5 ? [GOOD, MID, f / 0.5] : [MID, BAD, (f - 0.5) / 0.5];
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
function flag(cc) {
  if (!cc || cc.length !== 2) return '🌐';
  return cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}
function niceMax(v) {
  if (v <= 1) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

const PAD_L = 60, PAD_R = 52, PAD_TOP = 54, PAD_BOT = 40;
const HEADER_H = 18;

class MtrMap {
  constructor() {
    this.tracks = new Map();   // source -> {source,label,color,cc,hops,nodes}
    this.order = [];
    this.target = '';
    this.maxAxis = 10;
    this.mode = 'latency';     // 'latency' | 'geo'
    this.running = false;
    this._raf = null;
    this.onHover = null;
    this.hover = null;
  }
  setMode(m) { this.mode = m; }

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._ptr = { x: -1, y: -1, cx: 0, cy: 0, inside: false };
    const setPtr = (e) => {
      const r = canvas.getBoundingClientRect();
      this._ptr = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY, inside: true };
    };
    canvas.addEventListener('pointermove', setPtr);
    canvas.addEventListener('pointerdown', setPtr);
    canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      this._ptr.inside = false; this.hover = null;
      if (this.onHover) this.onHover(null);
    });
    window.addEventListener('resize', () => this._resize());
  }

  open(target) {
    this.target = target;
    this.tracks.clear();
    this.order = [];
    this.running = true;
    this._t0 = performance.now();
    this._resize();
    if (!this._raf) this._loop();
  }
  close() { this.running = false; }

  ensureTrack(source, meta = {}) {
    if (!this.tracks.has(source)) {
      this.tracks.set(source, {
        source, hops: [], nodes: new Map(),
        label: meta.label || source, color: meta.color || [74, 216, 255], cc: meta.cc || '',
      });
      this.order.push(source);
    } else if (meta.label) {
      Object.assign(this.tracks.get(source), meta);
    }
  }
  setHops(source, hops, meta) {
    this.ensureTrack(source, meta);
    this.tracks.get(source).hops = (hops || []).filter((h) => h.host && h.avg != null);
  }
  setTrackError(source, msg, meta) { this.ensureTrack(source, meta); this.tracks.get(source).error = msg; }

  _resize() {
    const c = this.canvas, r = c.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = r.width; this.H = r.height;
  }

  _xFor(ms) { return PAD_L + (ms / this.maxAxis) * (this.W - PAD_L - PAD_R); }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const ctx = this.ctx;
    if (!this.W) { this._resize(); return; }
    const time = (performance.now() - this._t0) / 1000;
    ctx.clearRect(0, 0, this.W, this.H);
    this.hover = null;
    if (this.mode === 'geo') this._drawGeo(ctx, time);
    else this._drawLatency(ctx, time);
  }

  _drawLatency(ctx, time) {
    // global ms axis across all tracks
    let peak = 1;
    for (const t of this.tracks.values()) for (const h of t.hops) if (h.avg != null) peak = Math.max(peak, h.last ?? h.avg);
    this.maxAxis = niceMax(peak * 1.08);
    this._drawRuler(ctx);

    const n = Math.max(1, this.order.length);
    const bandH = (this.H - PAD_TOP - PAD_BOT) / n;
    this.order.forEach((source, i) => {
      const track = this.tracks.get(source);
      const top = PAD_TOP + i * bandH;
      this._layoutTrack(track, top, bandH);
      this._drawTrackHeader(ctx, track, top);
      const pts = this._orderedNodes(track);
      if (pts.length >= 2) { this._drawPath(ctx, pts, track.color); this._drawPackets(ctx, pts, time); }
      for (const node of pts) this._drawNode(ctx, node, track, time);
      this._pickTrack(track, pts);
      this._drawMiniLabels(ctx, track, pts, top, bandH);
      if (i < n - 1) { ctx.strokeStyle = 'rgba(120,150,220,0.08)'; ctx.beginPath(); ctx.moveTo(0, top + bandH); ctx.lineTo(this.W, top + bandH); ctx.stroke(); }
    });
  }

  // ---- geographic route view: hops plotted at their city lat/lon ----
  _drawGeo(ctx, time) {
    const GL = 24, GR = 24, GT = 56, GB = 26;
    const all = [];
    for (const source of this.order) {
      const track = this.tracks.get(source);
      track._geo = (track.hops || []).filter((h) => h.geo && h.geo.lat != null && h.geo.lon != null);
      for (const h of track._geo) all.push({ lon: h.geo.lon, lat: h.geo.lat });
    }
    if (!all.length) {
      ctx.save(); ctx.fillStyle = 'rgba(126,136,171,0.8)'; ctx.font = '13px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center'; ctx.fillText('waiting for geolocated hops…', this.W / 2, this.H / 2); ctx.restore();
      return;
    }
    // bounding box (+ margin, minimum span)
    let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
    for (const p of all) { lonMin = Math.min(lonMin, p.lon); lonMax = Math.max(lonMax, p.lon); latMin = Math.min(latMin, p.lat); latMax = Math.max(latMax, p.lat); }
    const cLon = (lonMin + lonMax) / 2, cLat = (latMin + latMax) / 2;
    const spanLon = Math.max(lonMax - lonMin, 3) * 1.25, spanLat = Math.max(latMax - latMin, 3) * 1.25;
    lonMin = cLon - spanLon / 2; lonMax = cLon + spanLon / 2; latMin = cLat - spanLat / 2; latMax = cLat + spanLat / 2;
    const cosLat = Math.cos(cLat * Math.PI / 180) || 1;
    const W = this.W - GL - GR, H = this.H - GT - GB;
    const scale = Math.min(W / (spanLon * cosLat), H / spanLat);
    const drawW = spanLon * cosLat * scale, drawH = spanLat * scale;
    const ox = GL + (W - drawW) / 2, oy = GT + (H - drawH) / 2;
    const project = (lon, lat) => ({ x: ox + (lon - lonMin) * cosLat * scale, y: oy + (latMax - lat) * scale });

    this._drawGraticule(ctx, lonMin, lonMax, latMin, latMax, project);

    // routes
    for (const source of this.order) {
      const track = this.tracks.get(source), g = track._geo;
      if (g.length >= 2) {
        ctx.save();
        ctx.strokeStyle = rgb(track.color, 0.85); ctx.lineWidth = 2; ctx.lineJoin = 'round';
        ctx.shadowColor = rgb(track.color, 0.55); ctx.shadowBlur = 8;
        ctx.beginPath();
        g.forEach((h, i) => { const p = project(h.geo.lon, h.geo.lat); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
        ctx.stroke(); ctx.restore();
        this._geoPackets(ctx, g, project, time);
      }
    }
    // dots + labels
    const placed = [];
    for (const source of this.order) {
      const track = this.tracks.get(source);
      (track._geo || []).forEach((h, i) => {
        const p = project(h.geo.lon, h.geo.lat);
        const hovered = this.hover && this.hover.idx === h.idx && this.hover.source === source;
        if (this._ptr.inside) {
          const dx = p.x - this._ptr.x, dy = p.y - this._ptr.y;
          if (dx * dx + dy * dy < 16 * 16) {
            this.hover = { source, idx: h.idx, hop: h };
            if (this.onHover) this.onHover({ hop: h, track: { label: track.label }, cx: this._ptr.cx, cy: this._ptr.cy });
          }
        }
        const col = lossColor(h.loss || 0);
        ctx.save();
        ctx.shadowColor = rgb(col, 0.9); ctx.shadowBlur = hovered ? 18 : 11;
        ctx.fillStyle = rgb(col, 1); ctx.beginPath(); ctx.arc(p.x, p.y, hovered ? 6 : 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // label: flag + city (de-collided)
        const city = h.geo.city || (h.geo.country || '');
        if (city) this._geoLabel(ctx, p, `${flag(h.geo.cc)} ${city}`, col, placed);
      });
    }
    this._geoLegend(ctx);
  }

  _drawGraticule(ctx, lonMin, lonMax, latMin, latMax, project) {
    const step = (s) => { const r = s / 6, m = Math.pow(10, Math.floor(Math.log10(r || 1))), n = r / m; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * m; };
    const sLon = step(lonMax - lonMin), sLat = step(latMax - latMin);
    ctx.save();
    ctx.font = '9px ui-monospace, Menlo, monospace'; ctx.strokeStyle = 'rgba(120,150,220,0.09)'; ctx.fillStyle = 'rgba(126,136,171,0.55)'; ctx.lineWidth = 1;
    for (let lon = Math.ceil(lonMin / sLon) * sLon; lon <= lonMax; lon += sLon) {
      const a = project(lon, latMax), b = project(lon, latMin);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(`${lon.toFixed(0)}°`, a.x, this.H - 14);
    }
    for (let lat = Math.ceil(latMin / sLat) * sLat; lat <= latMax; lat += sLat) {
      const a = project(lonMin, lat), b = project(lonMax, lat);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillText(`${lat.toFixed(0)}°`, a.x + 3, a.y - 3);
    }
    ctx.restore();
  }

  _geoPackets(ctx, g, project, time) {
    const pts = g.map((h) => project(h.geo.lon, h.geo.lat));
    ctx.save();
    for (let k = 0; k < 2; k++) {
      const t = ((time * 0.25) + k / 2) % 1;
      const seg = (pts.length - 1) * t, i = Math.min(pts.length - 2, Math.floor(seg)), lt = seg - i;
      const a = pts[i], b = pts[i + 1];
      const x = a.x + (b.x - a.x) * lt, y = a.y + (b.y - a.y) * lt;
      ctx.beginPath(); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.shadowColor = 'rgba(120,220,255,0.9)'; ctx.shadowBlur = 10;
      ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  _geoLabel(ctx, p, text, col, placed) {
    ctx.font = '10.5px ui-monospace, Menlo, monospace';
    const w = ctx.measureText(text).width + 10, H = 15;
    let by = p.y - 10 - H;
    let cand = { x: Math.max(2, Math.min(this.W - w - 2, p.x - w / 2)), y: by, w, h: H }, guard = 0, dir = -1;
    while (placed.some((b) => boxOverlap(b, cand, 3)) && guard++ < 24) { by += dir * 7; if (by < 30) { dir = 1; by = p.y + 10; } cand = { ...cand, y: by }; }
    placed.push(cand);
    ctx.save(); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    roundRect(ctx, cand.x, cand.y, w, H, 5); ctx.fillStyle = 'rgba(9,12,22,0.8)'; ctx.fill();
    ctx.strokeStyle = rgb(col, 0.35); ctx.stroke();
    ctx.fillStyle = 'rgba(231,236,255,0.95)'; ctx.fillText(text, cand.x + 5, cand.y + H / 2);
    ctx.restore();
  }

  _geoLegend(ctx) {
    ctx.save(); ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'middle';
    let y = 64;
    for (const source of this.order) {
      const track = this.tracks.get(source);
      ctx.fillStyle = rgb(track.color, 1); ctx.beginPath(); ctx.arc(this.W - 16, y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(206,214,240,0.9)';
      ctx.fillText(track.label.slice(0, 28), this.W - 26, y);
      y += 18;
    }
    ctx.restore();
  }

  _layoutTrack(track, top, bandH) {
    const baseline = top + bandH * 0.62;
    const amp = Math.min(20, bandH * 0.12);
    let lastX = -Infinity;
    const minGap = 30;
    track.hops.forEach((h, i) => {
      const v = h.last != null ? h.last : h.avg;
      let x = this._xFor(v);
      if (x < lastX + minGap) x = lastX + minGap;
      lastX = x;
      const y = baseline + Math.sin(i * 0.8) * amp;
      let node = track.nodes.get(h.idx);
      if (!node) { node = { x, y, tx: x, ty: y, hop: h }; track.nodes.set(h.idx, node); }
      node.hop = h; node.tx = x; node.ty = y;
      node.x += (node.tx - node.x) * 0.2; node.y += (node.ty - node.y) * 0.2;
    });
    for (const k of [...track.nodes.keys()]) if (!track.hops.some((h) => h.idx === k)) track.nodes.delete(k);
  }
  _orderedNodes(track) { return track.hops.map((h) => track.nodes.get(h.idx)).filter(Boolean); }

  _drawRuler(ctx) {
    const step = this.maxAxis / 5;
    ctx.save();
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    for (let v = 0; v <= this.maxAxis + 1e-6; v += step) {
      const x = this._xFor(v);
      ctx.strokeStyle = 'rgba(120,150,220,0.08)';
      ctx.beginPath(); ctx.moveTo(x, PAD_TOP - 6); ctx.lineTo(x, this.H - PAD_BOT + 4); ctx.stroke();
      ctx.fillStyle = 'rgba(126,136,171,0.8)';
      ctx.fillText(`${Math.round(v)}ms`, x, this.H - PAD_BOT + 18);
    }
    ctx.restore();
  }

  _drawTrackHeader(ctx, track, top) {
    ctx.save();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = 'bold 12px ui-monospace, Menlo, monospace';
    ctx.fillStyle = rgb(track.color, 1);
    const txt = track.error ? `${track.label} — ${track.error}` : track.label;
    ctx.fillText(txt, 8, top + HEADER_H / 2 + 2);
    ctx.restore();
  }

  _drawPath(ctx, pts, color) {
    ctx.save();
    ctx.strokeStyle = rgb(color, 0.85); ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.shadowColor = rgb(color, 0.5); ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], mx = (a.x + b.x) / 2;
      ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y);
    }
    ctx.stroke(); ctx.restore();
  }
  _drawPackets(ctx, pts, time) {
    ctx.save();
    for (let k = 0; k < 3; k++) {
      const t = ((time * 0.3) + k / 3) % 1;
      const seg = (pts.length - 1) * t, i = Math.min(pts.length - 2, Math.floor(seg)), lt = seg - i;
      const a = pts[i], b = pts[i + 1], mx = (a.x + b.x) / 2, u = 1 - lt;
      const x = u * u * u * a.x + 3 * u * u * lt * mx + 3 * u * lt * lt * mx + lt * lt * lt * b.x;
      const y = u * u * u * a.y + 3 * u * u * lt * a.y + 3 * u * lt * lt * b.y + lt * lt * lt * b.y;
      ctx.beginPath(); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.shadowColor = 'rgba(120,220,255,0.9)'; ctx.shadowBlur = 12;
      ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  _drawNode(ctx, node, track, time) {
    const h = node.hop, col = lossColor(h.loss || 0);
    const hovered = this.hover && this.hover.source === track.source && this.hover.idx === h.idx;
    ctx.save();
    if ((h.loss || 0) > 0) {
      const pr = 8 + Math.sin(time * 4) * 2 + (h.loss / 100) * 5;
      ctx.strokeStyle = rgb(col, 0.5); ctx.beginPath(); ctx.arc(node.x, node.y, pr, 0, Math.PI * 2); ctx.stroke();
    }
    const rad = hovered ? 7 : 5.5;
    ctx.shadowColor = rgb(col, 0.9); ctx.shadowBlur = hovered ? 20 : 14;
    ctx.fillStyle = rgb(col, 1); ctx.beginPath(); ctx.arc(node.x, node.y, rad, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(5,6,12,0.9)'; ctx.beginPath(); ctx.arc(node.x, node.y, rad - 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  _pickTrack(track, pts) {
    if (!this._ptr.inside) return;
    for (const node of pts) {
      const dx = node.x - this._ptr.x, dy = node.y - this._ptr.y;
      if (dx * dx + dy * dy < 18 * 18) {
        this.hover = { source: track.source, idx: node.hop.idx, hop: node.hop, track };
        if (this.onHover) this.onHover({ hop: node.hop, track: { label: track.label }, cx: this._ptr.cx, cy: this._ptr.cy });
      }
    }
  }

  _drawMiniLabels(ctx, track, pts, top, bandH) {
    const PADX = 7, H = 16;
    const bandTop = top + HEADER_H, bandBot = top + bandH;
    ctx.save(); ctx.textBaseline = 'middle';
    const placed = [];
    let minY = Infinity, maxY = -Infinity;
    for (const n of pts) { minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const above0 = Number.isFinite(minY) ? minY - 14 : 0;
    const below0 = Number.isFinite(maxY) ? maxY + 14 : 0;
    pts.forEach((n, i) => {
      const h = n.hop, g = h.geo || null, priv = g && g.private;
      const fl = priv ? '🏠' : (g && g.cc ? flag(g.cc) : '🌐');
      const ms = (h.last != null ? h.last : h.avg);
      const txt = `${fl} ${ms != null ? ms.toFixed(0) + 'ms' : ''}`;
      ctx.font = '11px ui-monospace, Menlo, monospace';
      const w = ctx.measureText(txt).width + PADX * 2;
      const dir = i % 2 === 0 ? -1 : 1;
      let by = dir < 0 ? above0 - H : below0;
      let cand = { x: Math.max(2, Math.min(this.W - w - 2, n.x - w / 2)), y: by, w, h: H }, guard = 0;
      while (placed.some((b) => boxOverlap(b, cand, 4)) && guard++ < 40) { by += dir * 6; cand = { ...cand, y: by }; }
      if (cand.y < bandTop - 14 || cand.y + H > bandBot + 4) { ctx.restore && 0; placed.push(cand); /* still draw, clamped */ cand.y = Math.max(bandTop - 12, Math.min(bandBot - H, cand.y)); }
      placed.push(cand);
      const col = lossColor(h.loss || 0);
      ctx.strokeStyle = rgb(col, 0.35); ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(cand.x + w / 2, cand.y > n.y ? cand.y : cand.y + H); ctx.stroke();
      roundRect(ctx, cand.x, cand.y, w, H, 6);
      ctx.fillStyle = 'rgba(9,12,22,0.78)'; ctx.fill();
      ctx.strokeStyle = rgb(col, 0.35); ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(231,236,255,0.95)';
      ctx.fillText(txt, cand.x + PADX, cand.y + H / 2);
    });
    ctx.restore();
  }
}

function boxOverlap(a, b, pad = 0) {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export default new MtrMap();
