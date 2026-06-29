// PingScope 3D visualisation.
// Each target is a "lane" flowing along the X (time) axis. For every second we
// draw nested translucent percentile bands (min–max and p25–p75) — the SmokePing
// "smoke" — plus a glowing median ribbon. Packet loss tints everything red.
// Time scrolls continuously by deriving each sample's X from its real timestamp.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const SPAN = 120;        // world units spanning the time window
const HEIGHT = 46;       // world units for the latency axis
const LANE_GAP = 34;     // spacing between target lanes on Z
const RIGHT = SPAN / 2;  // X of the live "now" edge

const TYPE_COLOR = { dns: '#4ad8ff', isp: '#ff8a3d', cloud: '#b78bff' };
function laneColor(p) { return p.anycast ? '#ffd23f' : (TYPE_COLOR[p.type] || '#4ad8ff'); }

// SmokePing-style loss colouring: the smoke is green with no loss and shifts
// through orange to red as packets drop.
const GOOD = new THREE.Color('#36f1a3');   // 0% loss — green
const ORANGE = new THREE.Color('#ff9d3d'); // losing packets
const BAD = new THREE.Color('#ff3b6b');    // heavy loss — red

const tmpColor = new THREE.Color();
function lossColor(loss) {
  const f = Math.min(1, Math.max(0, loss || 0));
  return f <= 0.5
    ? tmpColor.copy(GOOD).lerp(ORANGE, f / 0.5)
    : tmpColor.copy(ORANGE).lerp(BAD, (f - 0.5) / 0.5);
}

class Graph {
  constructor() {
    this.lanes = new Map();      // targetId -> lane object
    this.windowSec = 120;        // live window span
    this.mode = 'live';          // 'live' | 'history'
    this.histFrom = 0;
    this.histTo = 0;
    this.yMax = 60;              // smoothed latency ceiling
    this.autoRotate = true;
    this.onHover = null;
    this._raf = null;
  }

  init(canvas) {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05060c, 0.0022); // light — keep distant lanes legible

    this.camera = new THREE.PerspectiveCamera(52, w / h, 0.1, 2000);
    this.camera.position.set(96, 78, 150);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 70;
    this.controls.maxDistance = 460;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 14, 0);
    this.controls.autoRotateSpeed = 0.55;

    // world group so we can centre the whole scene
    this.world = new THREE.Group();
    this.scene.add(this.world);

    this._buildEnvironment();

    // postprocessing: neon bloom
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.9, 0.7, 0.18);
    this.composer.addPass(this.bloom);

    // hover picking
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._pointerClient = { x: 0, y: 0 };
    this._hovering = false;
    canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    canvas.addEventListener('pointerleave', () => { this._hovering = false; this.onHover && this.onHover(null); });

    window.addEventListener('resize', () => this._resize());
    this._loop();
  }

  _buildEnvironment() {
    this.scene.add(new THREE.AmbientLight(0x6678aa, 1.1));
    const key = new THREE.PointLight(0x4ad8ff, 700, 600);
    key.position.set(60, 120, 90);
    this.scene.add(key);
    const rim = new THREE.PointLight(0xb78bff, 500, 600);
    rim.position.set(-90, 60, -80);
    this.scene.add(rim);

    // floor grid
    const grid = new THREE.GridHelper(SPAN * 1.6, 48, 0x2a3358, 0x161c30);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    this.world.add(grid);

    // latency axis guide lines + labels (rebuilt as scale changes)
    this.axisGroup = new THREE.Group();
    this.world.add(this.axisGroup);
    this._axisLabels = [];

    // "now" edge — a glowing plane at the live side
    const nowGeo = new THREE.PlaneGeometry(LANE_GAP * 3.4, HEIGHT);
    const nowMat = new THREE.MeshBasicMaterial({ color: 0x4ad8ff, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false });
    this.nowPlane = new THREE.Mesh(nowGeo, nowMat);
    this.nowPlane.position.set(RIGHT, HEIGHT / 2, 0);
    this.nowPlane.rotation.y = Math.PI / 2;
    this.world.add(this.nowPlane);
  }

  _makeLabel(text, color = '#7e88ab', size = 46, sub = '') {
    const c = document.createElement('canvas');
    c.width = 256; c.height = sub ? 88 : 64;
    const ctx = c.getContext('2d');
    ctx.font = `600 ${size}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 6, sub ? 26 : 34);
    if (sub) {
      ctx.font = `500 ${Math.round(size * 0.72)}px ui-monospace, Menlo, monospace`;
      ctx.fillStyle = '#94a2c8';                      // network name — muted
      ctx.fillText(sub, 6, 64);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.userData.text = text;
    return spr;
  }

  // Sync the rendered lanes to the selected probe set (add/remove + relayout).
  setSelection(probes) {
    const want = new Set(probes.map((p) => p.id));
    for (const [id, lane] of [...this.lanes]) {
      if (!want.has(id)) { this.world.remove(lane.group); this._disposeLane(lane); this.lanes.delete(id); }
    }
    for (const p of probes) if (!this.lanes.has(p.id)) this._addLane(p);
    this._order = probes.map((p) => p.id);
    this._relayout();
    this._rebuildAxis();
  }

  _addLane(p) {
    const colorHex = laneColor(p);
    const base = new THREE.Color(colorHex);
    const lane = { id: p.id, label: p.provider || p.ip, ip: p.ip, probe: p, color: base, z: 0, data: [] };
    const group = new THREE.Group();

    lane.outer = this._makeBand(0.16);
    lane.inner = this._makeBand(0.34);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    lineGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    lane.line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));

    lane.head = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 16), new THREE.MeshBasicMaterial({ color: colorHex }));
    lane.head.visible = false;

    // red vertical markers at every time-point that had packet loss
    const lossGeo = new THREE.BufferGeometry();
    lossGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    lossGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    lane.lossMarks = new THREE.LineSegments(lossGeo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
    }));

    lane.pick = new THREE.Mesh(new THREE.PlaneGeometry(SPAN, HEIGHT), new THREE.MeshBasicMaterial({ visible: false }));
    lane.pick.position.set(0, HEIGHT / 2, 0);
    lane.pick.userData.laneId = p.id;

    const net = (p.asName || '').slice(0, 28);    // network (AS) name at the endpoint
    lane.hasNet = !!net;
    const head = `${p.provider || ''} ${p.cc || (p.anycast ? '·' : '')}`.trim();
    lane.nameSprite = this._makeLabel(head, colorHex, 36, net);
    lane.nameSprite.scale.set(net ? 30 : 26, net ? 10.3 : 6.5, 1);
    lane.nameSprite.position.set(RIGHT + 14, net ? 5 : 4, 0);

    group.add(lane.outer.mesh, lane.inner.mesh, lane.lossMarks, lane.line, lane.head, lane.pick, lane.nameSprite);
    this.world.add(group);
    lane.group = group;
    this.lanes.set(p.id, lane);
  }

  _disposeLane(lane) {
    lane.outer.geo.dispose(); lane.inner.geo.dispose(); lane.line.geometry.dispose();
    lane.lossMarks.geometry.dispose(); lane.lossMarks.material.dispose();
    if (lane.nameSprite.material.map) lane.nameSprite.material.map.dispose();
    lane.nameSprite.material.dispose();
  }

  _relayout() {
    const n = this.lanes.size;
    const gap = n > 1 ? Math.min(LANE_GAP, 440 / (n - 1)) : 0; // keep the stack compact
    this._gap = gap;
    const lf = n > 24 ? 0.6 : n > 14 ? 0.78 : 1; // shrink endpoint labels when crowded
    let i = 0;
    for (const id of (this._order || [...this.lanes.keys()])) {
      const lane = this.lanes.get(id);
      if (!lane) continue;
      const z = (i - (n - 1) / 2) * gap;
      lane.z = z; lane.group.position.z = z;
      lane.nameSprite.visible = true; // always show the network name
      const w = lane.hasNet ? 30 : 26, h = lane.hasNet ? 10.3 : 6.5;
      lane.nameSprite.scale.set(w * lf, h * lf, 1);
      i++;
    }
  }

  _makeBand(opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    return { mesh: new THREE.Mesh(geo, mat), geo };
  }

  setHistory(targetId, samples) {
    const lane = this.lanes.get(targetId);
    if (!lane) return;
    lane.data = samples.slice(-600);
  }

  pushSample(s) {
    const lane = this.lanes.get(s.targetId);
    if (!lane) return;
    lane.data.push(s);
    if (lane.data.length > 600) lane.data.shift();
  }

  setWindow(sec) { this.windowSec = sec; this._rebuildAxis(); }
  setAutoRotate(on) { this.autoRotate = on; }

  // Live mode: the window's right edge tracks "now" and scrolls every frame.
  setLiveMode() { this.mode = 'live'; this._rebuildAxis(); }
  // History mode: freeze the window to an explicit [from, to] range.
  setHistoryWindow(from, to) {
    this.mode = 'history';
    this.histFrom = from;
    this.histTo = to;
    this._rebuildAxis();
  }

  // resolve the current window end + span (seconds) for either mode
  _window() {
    if (this.mode === 'history') {
      return { end: this.histTo, spanSec: Math.max(1, (this.histTo - this.histFrom) / 1000) };
    }
    return { end: Date.now(), spanSec: this.windowSec };
  }

  _rebuildAxis() {
    // clear previous
    for (const o of this.axisGroup.children.slice()) this.axisGroup.remove(o);
    this._axisLabels = [];
    const ticks = niceTicks(this.yMax, 5);
    const gap = this._gap || LANE_GAP;
    const halfZ = (this.lanes.size * gap) / 2 + gap;
    for (const v of ticks) {
      const y = (v / this.yMax) * HEIGHT;
      const pts = [new THREE.Vector3(-RIGHT, y, -halfZ), new THREE.Vector3(RIGHT, y, -halfZ)];
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x223052, transparent: true, opacity: 0.55 }));
      this.axisGroup.add(line);
      const label = this._makeLabel(`${v}ms`, '#7e88ab', 34);
      label.scale.set(16, 4, 1);
      label.position.set(-RIGHT - 12, y, -halfZ);
      label.userData.tickY = v;
      this.axisGroup.add(label);
      this._axisLabels.push(label);
    }
    this._buildTimeAxis(halfZ);
  }

  // Horizontal (X) time axis along the front-bottom edge: relative ages while
  // live ("now", "-1m", …), wall-clock times when browsing history.
  _buildTimeAxis(halfZ) {
    const { end, spanSec } = this._window();
    const z = halfZ;
    const N = 4;
    for (let i = 0; i <= N; i++) {
      const frac = i / N;                       // 0 = oldest (left), 1 = now (right)
      const x = -RIGHT + frac * SPAN;
      const ageSec = (1 - frac) * spanSec;
      let text;
      if (this.mode === 'history') {
        text = new Date(end - ageSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else if (ageSec < 1) {
        text = 'now';
      } else if (ageSec < 60) {
        text = `-${Math.round(ageSec)}s`;
      } else {
        text = `-${(ageSec / 60).toFixed(ageSec % 60 ? 1 : 0)}m`; // e.g. -1m, -1.5m
      }
      // faint vertical gridline at each tick
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0, z), new THREE.Vector3(x, HEIGHT * 0.92, z)]);
      this.axisGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x223052, transparent: true, opacity: 0.35 })));
      const label = this._makeLabel(text, '#6b7aa3', 30);
      label.scale.set(13, 3.25, 1);
      label.position.set(x, -3.6, z);
      this.axisGroup.add(label);
    }
  }

  _onPointerMove(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this._pointerClient = { x: e.clientX, y: e.clientY };
    this._hovering = true;
  }

  _pick() {
    if (!this._hovering || !this.onHover) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const picks = [...this.lanes.values()].map((l) => l.pick);
    const hit = this.raycaster.intersectObjects(picks, false)[0];
    if (!hit) { this.onHover(null); return; }
    const laneId = hit.object.userData.laneId;
    const lane = this.lanes.get(laneId);
    const localX = hit.point.x; // world == group local on X (group only offset on Z)
    const { end, spanSec } = this._window();
    const dxPerSec = SPAN / spanSec;
    // find sample whose x is closest to localX
    let best = null, bestDx = Infinity;
    for (const s of lane.data) {
      const age = (end - s.t) / 1000;
      const x = RIGHT - age * dxPerSec;
      const d = Math.abs(x - localX);
      if (d < bestDx) { bestDx = d; best = s; }
    }
    if (!best || bestDx > dxPerSec * 1.5) { this.onHover(null); return; }
    this.onHover({
      lane,
      sample: best,
      ageSec: Math.round((Date.now() - best.t) / 1000),
      when: best.t,
      client: this._pointerClient,
    });
  }

  _updateLane(lane, end, spanSec, dxPerSec, yScale) {
    const data = lane.data;
    // collect visible points with valid latency
    const pts = [];
    const loss = [];   // {x, loss} for every visible sample that dropped packets
    for (const s of data) {
      const age = (end - s.t) / 1000;
      if (age > spanSec + 1 || age < -1) continue;
      const x = RIGHT - age * dxPerSec;
      if (s.loss > 0) loss.push({ x, loss: Math.min(1, s.loss) });
      if (s.median == null) continue;   // full-loss samples have no latency point
      pts.push({ x, s });
    }
    const n = pts.length;

    // ---- red vertical loss markers (taller + brighter the more was lost) ----
    const lp = new Float32Array(loss.length * 6);
    const lpc = new Float32Array(loss.length * 6);
    for (let i = 0; i < loss.length; i++) {
      const h = HEIGHT * (0.3 + 0.7 * loss[i].loss);
      const inten = 0.5 + 0.5 * loss[i].loss;
      const r = inten, g = 0.18 * inten, b = 0.24 * inten;   // red
      const o = i * 6;
      lp[o] = loss[i].x; lp[o + 1] = 0; lp[o + 2] = 0;
      lp[o + 3] = loss[i].x; lp[o + 4] = h; lp[o + 5] = 0;
      lpc[o] = r; lpc[o + 1] = g; lpc[o + 2] = b;
      lpc[o + 3] = r; lpc[o + 4] = g; lpc[o + 5] = b;
    }
    setAttr(lane.lossMarks.geometry, 'position', lp, 3);
    setAttr(lane.lossMarks.geometry, 'color', lpc, 3);
    lane.lossMarks.geometry.setDrawRange(0, loss.length * 2);

    // ---- median line ----
    const lpos = new Float32Array(n * 3);
    const lcol = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const { x, s } = pts[i];
      lpos[i * 3] = x; lpos[i * 3 + 1] = s.median * yScale; lpos[i * 3 + 2] = 0;
      const c = lossColor(s.loss);
      lcol[i * 3] = c.r; lcol[i * 3 + 1] = c.g; lcol[i * 3 + 2] = c.b;
    }
    setAttr(lane.line.geometry, 'position', lpos, 3);
    setAttr(lane.line.geometry, 'color', lcol, 3);
    lane.line.geometry.setDrawRange(0, n);

    // glowing head at newest point
    if (n) {
      const last = pts[n - 1];
      lane.head.position.set(last.x, last.s.median * yScale, 0);
      lane.head.material.color.copy(lossColor(last.s.loss));
      lane.head.visible = true;
    } else lane.head.visible = false;

    // ---- bands ----
    this._fillBand(lane.outer, pts, yScale, (s) => s.min, (s) => s.max);
    this._fillBand(lane.inner, pts, yScale, (s) => (s.p25 ?? s.min), (s) => (s.p75 ?? s.max));
  }

  _fillBand(band, pts, yScale, lowFn, highFn) {
    const n = pts.length;
    if (n < 2) { band.geo.setDrawRange(0, 0); return; }
    // triangle strip: 2 verts per column, (n-1)*2 triangles
    const verts = (n - 1) * 6;
    const pos = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 3);
    let o = 0;
    const put = (x, y, c) => {
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = 0;
      col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      o += 3;
    };
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const aL = lowFn(a.s) * yScale, aH = highFn(a.s) * yScale;
      const bL = lowFn(b.s) * yScale, bH = highFn(b.s) * yScale;
      const ca = lossColor(a.s.loss).clone();
      const cb = lossColor(b.s.loss).clone();
      // two triangles: (aL,aH,bH) and (aL,bH,bL)
      put(a.x, aL, ca); put(a.x, aH, ca); put(b.x, bH, cb);
      put(a.x, aL, ca); put(b.x, bH, cb); put(b.x, bL, cb);
    }
    setAttr(band.geo, 'position', pos, 3);
    setAttr(band.geo, 'color', col, 3);
    band.geo.setDrawRange(0, verts);
  }


  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  _loop() {
    if (this._paused) { this._raf = null; return; }
    const now = Date.now();
    const { end, spanSec } = this._window();
    const dxPerSec = SPAN / spanSec;

    // smooth the latency ceiling toward the observed peak
    let peak = 10;
    for (const lane of this.lanes.values()) {
      for (const s of lane.data) {
        const age = (end - s.t) / 1000;
        if (age <= spanSec && age >= -1 && s.max != null) peak = Math.max(peak, s.max);
      }
    }
    const targetMax = niceTicks(peak * 1.15, 5).slice(-1)[0];
    const prevMax = this.yMax;
    this.yMax += (targetMax - this.yMax) * 0.05;
    if (Math.abs(prevMax - this.yMax) > 0.5 && Math.round(prevMax) !== Math.round(this.yMax)) {
      // refresh axis ticks occasionally as scale settles
      if (!this._axisCooldown || now - this._axisCooldown > 1200) { this._rebuildAxis(); this._axisCooldown = now; }
    }
    const yScale = HEIGHT / this.yMax;

    for (const lane of this.lanes.values()) {
      this._updateLane(lane, end, spanSec, dxPerSec, yScale);
    }

    // the live edge glows (live) or sits steady as a window marker (history)
    this.nowPlane.material.opacity = this.mode === 'live'
      ? 0.05 + 0.03 * (0.5 + 0.5 * Math.sin(now / 400))
      : 0.04;

    this.controls.autoRotate = this.autoRotate;
    this.controls.update();
    this._pick();
    this.composer.render();
    this._raf = requestAnimationFrame(() => this._loop());
  }

  // pause/resume the render loop (e.g. while the globe view is showing)
  pause() { this._paused = true; if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }
  resume() { if (!this._paused) return; this._paused = false; if (!this._raf) this._loop(); }
}

function setAttr(geo, name, arr, item) {
  const existing = geo.getAttribute(name);
  if (existing && existing.array.length === arr.length) {
    existing.array.set(arr);
    existing.needsUpdate = true;
  } else {
    geo.setAttribute(name, new THREE.BufferAttribute(arr, item));
  }
}

// produce "nice" axis tick values up to ~max
function niceTicks(max, count) {
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = step; v <= Math.ceil(max / step) * step + 1e-6; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks.length ? ticks : [step];
}

export default new Graph();
