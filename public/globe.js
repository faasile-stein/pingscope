// PingScope globe view: a 3D Earth with an arc from this server to every selected
// destination. Each arc's colour grades green→red with packet loss, its thickness
// grows with latency variance (the "smoke" spread), and a floating label shows the
// live RTT. Click an arc (or its label) to open the MTR for that target.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const D2R = Math.PI / 180;
const R = 1;                       // globe radius (world units)
const GOOD = new THREE.Color('#36f1a3');
const WARN = new THREE.Color('#ffd23f');
const BAD = new THREE.Color('#ff3b6b');

// lat/lon -> point on a sphere of radius r (shared by borders, markers and arcs)
function latlon3(lat, lon, r = R) {
  const phi = (90 - lat) * D2R, theta = (lon + 180) * D2R;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  );
}
function lossColor(loss) { // 0..1 -> green→amber→red
  const f = Math.min(1, Math.max(0, loss));
  const c = new THREE.Color();
  return f <= 0.5 ? c.copy(GOOD).lerp(WARN, f / 0.5) : c.copy(WARN).lerp(BAD, (f - 0.5) / 0.5);
}

class Globe {
  constructor() {
    this.arcs = new Map();          // probe id -> { mesh, dot, labelEl, apex, dstN, probe }
    this.origin = null;
    this.autoRotate = true;
    this.onSelect = null;           // (probe) => void  — click a line
    this._raf = null;
    this._visible = false;
    this._data = [];
  }

  init(canvas, labelLayer) {
    this.canvas = canvas;
    this.labelLayer = labelLayer;
    const w = window.innerWidth, h = window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.01, 100);
    this.camera.position.set(0.3, 1.0, 3.0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.07;   // zoom right down to the surface
    this.controls.maxDistance = 10;
    this.controls.enablePan = false;
    this.controls.autoRotateSpeed = 0.4;
    this.controls.zoomSpeed = 0.9;
    this._zoomBuilt = 1;                 // camera-distance factor the tubes were built at

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.scene.add(new THREE.AmbientLight(0x8092c0, 1.25));
    const key = new THREE.DirectionalLight(0xbfe0ff, 1.05); key.position.set(2, 1.4, 2.2); this.scene.add(key);

    // the planet — dark, faintly glossy
    this.world.add(new THREE.Mesh(
      new THREE.SphereGeometry(R, 64, 64),
      new THREE.MeshPhongMaterial({ color: 0x0b1430, emissive: 0x05091a, shininess: 16, specular: 0x16204a }),
    ));
    // atmosphere halo (inverted additive shell)
    this.world.add(new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.055, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0x2f6dff, transparent: true, opacity: 0.10, side: THREE.BackSide, depthWrite: false }),
    ));

    this._addGraticule();
    this.borderGroup = new THREE.Group(); this.world.add(this.borderGroup);
    this._loadBorders();

    this.arcGroup = new THREE.Group(); this.world.add(this.arcGroup);
    this.markerGroup = new THREE.Group(); this.world.add(this.markerGroup);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._hover = null;
    canvas.addEventListener('pointermove', (e) => this._onMove(e));
    canvas.addEventListener('pointerleave', () => this._setHover(null));
    canvas.addEventListener('click', () => this._onClick());
    window.addEventListener('resize', () => this._resize());
  }

  _addGraticule() {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0x1b2a52, transparent: true, opacity: 0.5 });
    for (let lat = -60; lat <= 60; lat += 30) {
      const pts = []; for (let lon = -180; lon <= 180; lon += 4) pts.push(latlon3(lat, lon, R * 1.001));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    for (let lon = -180; lon < 180; lon += 30) {
      const pts = []; for (let lat = -90; lat <= 90; lat += 4) pts.push(latlon3(lat, lon, R * 1.001));
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    this.world.add(g);
  }

  // country contours from world-atlas TopoJSON (same source as the 2D geo map)
  _loadBorders() {
    fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json')
      .then((r) => r.json())
      .then((topo) => {
        const t = topo.transform, sx = t.scale[0], sy = t.scale[1], tx = t.translate[0], ty = t.translate[1];
        const mat = new THREE.LineBasicMaterial({ color: 0x4f74ff, transparent: true, opacity: 0.55 });
        for (const arc of topo.arcs) {
          let x = 0, y = 0; const pts = [];
          for (const p of arc) { x += p[0]; y += p[1]; pts.push(latlon3(y * sy + ty, x * sx + tx, R * 1.002)); }
          this.borderGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
        }
      })
      .catch(() => {});
  }

  setOrigin(origin) {
    if (!origin || origin.lat == null) return;
    this.origin = origin;
    if (this.originMarker) this.markerGroup.remove(this.originMarker);
    const grp = new THREE.Group();
    const p = latlon3(origin.lat, origin.lon, R * 1.012);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 16), new THREE.MeshBasicMaterial({ color: 0x6fe0ff }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 16), new THREE.MeshBasicMaterial({ color: 0x4ad8ff, transparent: true, opacity: 0.28, depthWrite: false }));
    core.position.copy(p); halo.position.copy(p);
    grp.add(core); grp.add(halo);
    this.originMarker = grp; this._originHalo = halo;
    this.markerGroup.add(grp);
    this._rebuild();
  }

  // probes: [{ id, ip, label, lat, lon, avg, loss, spread }]
  setData(probes) { this._data = probes || []; this._rebuild(); }

  _rebuild() {
    for (const a of this.arcs.values()) {
      this.arcGroup.remove(a.mesh); a.mesh.geometry.dispose(); a.mesh.material.dispose();
      if (a.dot) { this.markerGroup.remove(a.dot); a.dot.geometry.dispose(); a.dot.material.dispose(); }
      if (a.labelEl) a.labelEl.remove();
    }
    this.arcs.clear();
    if (!this.origin || this.origin.lat == null) return;
    const start = latlon3(this.origin.lat, this.origin.lon, R);

    for (const p of this._data) {
      if (p.lat == null || p.lon == null) continue;
      const end = latlon3(p.lat, p.lon, R);
      const angle = start.angleTo(end);
      const lift = 0.12 + 0.42 * (angle / Math.PI);     // longer hops bow higher
      const N = 64, pts = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const v = start.clone().lerp(end, t).normalize();
        v.multiplyScalar(R * (1 + lift * Math.sin(Math.PI * t)));
        pts.push(v);
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const spread = Math.max(0, p.spread || 0);
      const varRadius = 0.004 + 0.016 * Math.min(1, spread / 35);   // base thickness ~ variance
      const radius = varRadius * this._zoomFactor();                // scaled to keep apparent width steady
      const col = lossColor(p.loss || 0);
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, N, radius, 9, false),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9 }),
      );
      mesh.userData.probe = p;
      this.arcGroup.add(mesh);

      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.014, 14, 14), new THREE.MeshBasicMaterial({ color: col }));
      dot.position.copy(latlon3(p.lat, p.lon, R * 1.012));
      dot.scale.setScalar(this._dotScale());
      this.markerGroup.add(dot);

      const labelEl = document.createElement('div');
      labelEl.className = 'globe-label';
      labelEl.style.setProperty('--c', `#${col.getHexString()}`);
      labelEl.innerHTML = `<b>${p.avg != null ? p.avg.toFixed(p.avg < 10 ? 1 : 0) : '—'}ms</b>`
        + (p.loss > 0 ? ` <i>${Math.round(p.loss * 100)}%</i>` : '')
        + `<span class="gl-name">${p.label || p.ip}</span>`;
      labelEl.title = `${p.label || ''} ${p.ip} — open MTR`;
      labelEl.addEventListener('click', (e) => { e.stopPropagation(); this.onSelect && this.onSelect(p); });
      this.labelLayer.appendChild(labelEl);

      this.arcs.set(p.id, { mesh, dot, labelEl, curve, seg: N, varRadius, apex: pts[N / 2].clone(), dstN: end.clone().normalize(), probe: p, baseOpacity: 0.9 });
    }
    this._zoomBuilt = this._zoomFactor();
  }

  // Tube/marker scale tied to camera distance, so lines keep a roughly constant
  // on-screen thickness instead of ballooning as you zoom in.
  _zoomFactor() {
    const d = this.camera.position.distanceTo(this.controls.target);
    return Math.min(2.4, Math.max(0.28, d / 3));
  }
  _dotScale() { return Math.min(1.8, Math.max(0.4, this._zoomFactor())); }

  // rebuild tube geometries (and rescale dots) when the zoom changed enough
  _applyZoom() {
    const f = this._zoomFactor();
    const ds = this._dotScale();
    if (this.originMarker) this.originMarker.scale.setScalar(ds);
    for (const a of this.arcs.values()) {
      a.dot.scale.setScalar(ds);
      a.mesh.geometry.dispose();
      a.mesh.geometry = new THREE.TubeGeometry(a.curve, a.seg, a.varRadius * f, 9, false);
    }
    this._zoomBuilt = f;
  }

  _updateLabels() {
    const camDir = this.camera.position.clone().normalize();
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    for (const a of this.arcs.values()) {
      const facing = a.dstN.dot(camDir) > -0.15;        // hide labels on the far side
      const v = a.apex.clone().project(this.camera);
      if (!facing || v.z >= 1) { a.labelEl.style.display = 'none'; continue; }
      a.labelEl.style.display = '';
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      a.labelEl.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px)`;
    }
  }

  _onMove(e) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this._pick();
  }

  _pick() {
    if (!this._visible || !this.arcs.size) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.arcGroup.children, false)[0];
    this._setHover(hit ? hit.object.userData.probe : null);
  }

  _setHover(probe) {
    const id = probe ? probe.id : null;
    if (id === this._hover) return;
    this._hover = id;
    for (const a of this.arcs.values()) {
      const hot = id && a.probe.id === id;
      a.mesh.material.opacity = hot ? 1 : a.baseOpacity;
      a.labelEl.classList.toggle('hot', !!hot);
    }
    this.canvas.style.cursor = id ? 'pointer' : 'grab';
  }

  _onClick() {
    if (!this._hover) return;
    const a = this.arcs.get(this._hover);
    if (a && this.onSelect) this.onSelect(a.probe);
  }

  show() {
    this._visible = true;
    this.canvas.style.display = '';
    this.labelLayer.style.display = '';
    this._resize();
    if (!this._raf) this._loop();
  }

  hide() {
    this._visible = false;
    this.canvas.style.display = 'none';
    this.labelLayer.style.display = 'none';
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _loop() {
    if (!this._visible) { this._raf = null; return; }
    this.controls.autoRotate = this.autoRotate;
    this.controls.update();
    // adapt line thickness to zoom (rebuild only when it changed materially)
    const f = this._zoomFactor();
    if (this.arcs.size && Math.abs(f - this._zoomBuilt) / this._zoomBuilt > 0.05) this._applyZoom();
    if (this._originHalo) this._originHalo.material.opacity = 0.2 + 0.12 * (0.5 + 0.5 * Math.sin(Date.now() / 380));
    this.renderer.render(this.scene, this.camera);
    this._updateLabels();   // reposition ms labels each frame (globe rotates)
    this._raf = requestAnimationFrame(() => this._loop());
  }
}

export default new Globe();
