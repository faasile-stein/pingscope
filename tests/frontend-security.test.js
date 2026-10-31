'use strict';
// Exercise the actual frontend renderers with local data. No browser, DNS,
// WebSocket, HTTP or probe process is started by this harness.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = (name) => readFileSync(path.join(root, name), 'utf8');
const payload = `"><img src=x onerror=alert(1)><script>alert(2)</script>'&`;
const encoded = '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;&#39;&amp;';
const noop = () => {};

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = { setProperty: noop };
    this.classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
    this.innerHTML = '';
    this.value = '120';
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
  addEventListener() {}
  getContext() { return new Proxy({}, { get: () => noop }); }
  remove() {}
}
function documentStub() {
  const elements = new Map();
  return {
    elements, body: new Element('body'),
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement: (tag) => new Element(tag), querySelectorAll: () => [], addEventListener: noop,
  };
}
function appHarness() {
  const document = documentStub();
  const graph = new Proxy({}, { get: (obj, key) => obj[key] || noop });
  const globe = new Proxy({}, { get: (obj, key) => obj[key] || noop });
  const mtr = { init: noop, tracks: new Map(), order: [] };
  const context = vm.createContext({ document, Graph: graph, Globe: globe, MtrMap: mtr,
    Overview: new Proxy({}, { get: () => noop }), window: { innerWidth: 1200 },
    location: { protocol: 'http:', host: 'localhost', search: '' }, URLSearchParams,
    WebSocket: class { constructor() { this.readyState = 1; } }, setTimeout: noop,
  });
  vm.runInContext(source('public/app.js').replace(/^import .*;\n/gm, '') + `\nglobalThis.api = {
    state, buildSelector, rowEl, renderVantages, updateEuBox, sovHopsHtml,
    sovCategoryHtml, renderSov, ccFlag, esc,
    setSov: (value) => { sovScan = value; },
    hover: Graph.onHover, mtrHover: MtrMap.onHover,
  };`, context);
  return { api: context.api, document, mtr };
}
function allMarkup(el) { return el.innerHTML + el.children.map(allMarkup).join(''); }
function escaped(html) {
  assert.ok(html.includes(encoded), 'attacker string must be HTML encoded');
  assert.ok(!html.includes('<img'), 'attacker element must not enter markup');
  assert.ok(!html.includes('<script'), 'attacker script must not enter markup');
}
const probe = { id: 'dns-8-8-8-8', type: 'dns', provider: 'Example DNS', ip: '8.8.8.8',
  cc: 'FR', country: 'France', city: 'Paris', asName: 'Example network', ptr: 'dns.example.com' };
const sample = { t: Date.now(), min: 1, max: 5, median: 3, loss: 0.1 };

test('selector headers and rows preserve valid input and escape catalog/DNS text (app:202,207,222-227)', () => {
  const { api, document } = appHarness();
  api.state.probes = [probe]; api.buildSelector();
  const html = allMarkup(document.getElementById('sel-list'));
  assert.match(html, /DNS<span class="sel-type-n">1/);
  assert.match(html, /🇫🇷 France/);
  assert.match(html, /href="\/\/dns.example.com"/);
  assert.match(html, />Example DNS<\/a>/);
  const malicious = { ...probe, provider: payload, ptr: payload, city: payload, country: payload };
  api.state.probes = [malicious]; api.buildSelector();
  escaped(allMarkup(document.getElementById('sel-list')));
  const row = api.rowEl(malicious).innerHTML;
  assert.match(row, /href="\/\//); // protocol-relative link cannot become javascript:
  escaped(row);
  const jsLink = api.rowEl({ ...probe, ptr: 'javascript:alert(1)' }).innerHTML;
  assert.ok(!jsLink.includes('href="javascript:'));
});

test('graph readout escapes all remote strings; numbers/dates remain formatted (app:326-331)', () => {
  const { api, document } = appHarness();
  const base = { lane: { probe }, sample, ageSec: 1, when: Date.now(), client: { x: 10, y: 20 } };
  api.hover(base);
  assert.match(document.getElementById('readout').innerHTML, /3\.0ms/);
  assert.match(document.getElementById('readout').innerHTML, /1s ago/);
  api.hover({ ...base, lane: { probe: { ...probe, provider: payload, cc: payload, as: payload, asName: payload, ptr: payload } } });
  escaped(document.getElementById('readout').innerHTML);
});

test('vantage chips use server-generated IDs and escape community metadata (app:515,519,522)', () => {
  const { api, document } = appHarness();
  api.state.agents = [{ id: 'agent-1', name: 'Home agent', cc: 'FR', country: 'France', asName: 'Example network' }];
  api.renderVantages();
  const baseline = document.getElementById('mtr-vantages').innerHTML;
  assert.match(baseline, /data-id="agent-1"/);
  assert.match(baseline, /🇫🇷 France · Home agent/);
  api.state.agents = [{ id: 'agent-1', name: payload, cc: 'FR', country: payload, asName: payload }];
  api.renderVantages(); escaped(document.getElementById('mtr-vantages').innerHTML);
  assert.match(source('server.js'), /id: `agent-\$\{\+\+agentSeq\}`/);
});

test('MTR hover escapes hop, DNS, geographic and track fields including hostile index (app:547-553)', () => {
  const { api, document } = appHarness();
  const hop = { idx: 1, host: '8.8.8.8', rdns: 'dns.example.com', last: 2, avg: 3,
    best: 1, wrst: 5, stdev: 0.5, loss: 10, geo: { cc: 'FR', country: 'France', city: 'Paris', asn: 64500, org: 'Example network' } };
  api.mtrHover({ hop, cx: 100, cy: 200, track: { label: 'Home agent' } });
  assert.match(document.getElementById('mtr-tip').innerHTML, /dns\.example\.com/);
  assert.match(document.getElementById('mtr-tip').innerHTML, /3\.0ms/);
  api.mtrHover({ hop: { ...hop, idx: payload, rdns: payload, geo: { ...hop.geo, country: payload, city: payload, asn: payload, org: payload } },
    cx: 100, cy: 200, track: { label: payload } });
  escaped(document.getElementById('mtr-tip').innerHTML);
});

test('destination flag interpolation cannot emit markup, in EU and non-EU branches (app:644-645)', () => {
  const { api, document, mtr } = appHarness();
  for (const [cc, cls] of [['FR', 'eu-ok'], ['US', 'eu-bad'], [payload, 'eu-bad'], ['<>', 'eu-bad']]) {
    mtr.tracks.set('local', { hops: [{ idx: 1, geo: { cc, asn: 64500 } }] });
    api.updateEuBox();
    const html = document.getElementById('eu-dest').innerHTML;
    assert.match(html, new RegExp(`class="${cls}"`));
    assert.ok(!html.includes('<img') && !html.includes('<script'));
    assert.equal((html.match(/</g) || []).length, 2);
  }
});

const server = { ip: '8.8.8.8', exchange: 'mail.example.com', cc: 'FR', city: 'Paris', country: 'France',
  ownerCc: 'US', ownerParent: 'Example parent', asName: 'Example network', eu: true, euOwned: false };
const category = { servers: [server], hops: [{ idx: 1, host: '8.8.8.8', last: 2.5, geo: { cc: 'FR', city: 'Paris', country: 'France' } }],
  done: true, score: 65, transit: { hopsNonEuPct: 25, netsNonEuPct: 50 } };

test('sovereignty rendering protects DNS/geo/owner strings and preserves computed stats (app:689-733,741)', () => {
  const { api, document } = appHarness();
  api.setSov({ domain: 'example.com', web: category, mail: { empty: true } }); api.renderSov();
  const baseline = document.getElementById('sov-body').innerHTML;
  assert.match(baseline, /65<span class="sov-score-max">/);
  assert.match(baseline, /route <b>25%<\/b> hops · <b>50%/);
  assert.match(baseline, /2\.5ms/);
  assert.match(baseline, /data-ip="8\.8\.8\.8"/);
  const maliciousServer = { ...server, ip: payload, exchange: payload, city: payload, country: payload, ownerCc: payload, ownerParent: payload, asName: payload };
  const maliciousCategory = { ...category, servers: [maliciousServer], hops: [{ ...category.hops[0], host: payload, geo: { cc: payload, city: payload, country: payload } }] };
  api.setSov({ domain: payload, mailDomain: payload, web: maliciousCategory, mail: { empty: true } }); api.renderSov();
  escaped(document.getElementById('sov-body').innerHTML);
  assert.equal(document.getElementById('sov-domain').textContent, payload);
  // title/icon/key are private call-site constants; route statistics come from
  // arithmetic in scoreCategory, and traceStream parses the numeric hop index.
  const backend = source('server.js');
  assert.match(backend, /Number\.isInteger\(n\)/);
  assert.match(backend, /idx: n \+ 1/);
  assert.match(backend, /hopsNonEuPct: Math\.round\(100 \* hopsNonEuFrac\)/);
  assert.match(backend, /netsNonEuPct: Math\.round\(100 \* netsNonEuFrac\)/);
});

test('sovereignty error and unresolved/empty categories escape text (app:700,703,740)', () => {
  const { api, document } = appHarness();
  api.setSov({ domain: 'example.com', error: 'scan failed' }); api.renderSov();
  assert.equal(document.getElementById('sov-body').innerHTML, '<div class="sov-err">scan failed</div>');
  api.setSov({ domain: 'example.com', error: payload }); api.renderSov();
  escaped(document.getElementById('sov-body').innerHTML);
  assert.match(api.sovCategoryHtml('Web', '🌐', 'web', null, ''), /resolving…/);
  escaped(api.sovCategoryHtml('Mail', '✉️', 'mail', { empty: true }, payload));
});

function overviewHarness() {
  const context = vm.createContext({ document: documentStub(), devicePixelRatio: 1 });
  vm.runInContext(source('public/overview.js').replace('export default new Overview();', 'globalThis.overview = new Overview();'), context);
  return context.overview;
}
test('overview headings and stats escape catalog text and format numeric samples (overview:72-73,100-108)', () => {
  const overview = overviewHarness();
  const p = { id: probe.id, label: probe.provider, net: probe.asName, cc: 'FR', samples: [sample] };
  let cell = overview._makeCell(p); overview._draw(cell, p);
  assert.match(cell.root.innerHTML, /Example DNS/);
  assert.match(cell.now.innerHTML, /3\.0ms/);
  assert.match(cell.foot.innerHTML, /avg 3\.0ms · max 5\.0ms/);
  const malicious = { ...p, label: payload, net: payload };
  cell = overview._makeCell(malicious); overview._draw(cell, malicious);
  escaped(cell.root.innerHTML); escaped(cell.foot.innerHTML);
});

function globeHarness() {
  class Vector {
    angleTo() { return 0.5; }
    clone() { return new Vector(); }
    lerp() { return this; }
    normalize() { return this; }
    multiplyScalar() { return this; }
    copy() { return this; }
  }
  class Color { copy() { return this; } lerp() { return this; } getHexString() { return '36f1a3'; } }
  class Disposable { dispose() {} }
  class Mesh {
    constructor(geometry, material) { Object.assign(this, { geometry, material, userData: {}, position: new Vector(), scale: { setScalar: noop } }); }
  }
  const THREE = { Vector3: Vector, Color, Mesh, TubeGeometry: Disposable, SphereGeometry: Disposable, MeshBasicMaterial: Disposable, CatmullRomCurve3: Disposable };
  const document = documentStub();
  const context = vm.createContext({ THREE, document });
  vm.runInContext(source('public/globe.js').replace(/^import .*;\n/gm, '').replace('export default new Globe();', 'globalThis.globe = new Globe();'), context);
  const globe = context.globe;
  Object.assign(globe, { origin: { lat: 50, lon: 1 }, arcGroup: { add: noop, remove: noop }, markerGroup: { add: noop, remove: noop },
    labelLayer: new Element(), _zoomFactor: () => 1, _dotScale: () => 1 });
  return globe;
}
test('globe label, city and AS metadata are escaped; latency/loss retain formatting (globe:193-207)', () => {
  const globe = globeHarness();
  const p = { id: probe.id, ip: probe.ip, label: 'Example DNS', city: 'Paris', net: 'Example network', lat: 49, lon: 2, avg: 3, loss: 0.1, spread: 0 };
  globe.setData([p]);
  let arc = globe.arcs.get(p.id);
  assert.match(arc.labelEl.innerHTML, /<b>3\.0ms<\/b> <i>10%<\/i>/);
  assert.match(arc.cityEl.innerHTML, />Paris<\/span>/);
  globe.setData([{ ...p, label: payload, city: payload, net: payload }]);
  arc = globe.arcs.get(p.id); escaped(arc.labelEl.innerHTML); escaped(arc.cityEl.innerHTML);
});

test('domain regex accepts domain controls and rejects adversarial near-matches within a bounded run', () => {
  const code = source('public/sovereignty.js').match(/function looksLikeDomain\(q\) \{[\s\S]*?\n\}/)[0];
  const context = vm.createContext({ URL });
  vm.runInContext(code, context);
  for (const value of ['example.com', 'www.example.co.uk', 'https://example.com/path', 'xn--bcher-kva.example']) {
    context.input = value; assert.equal(vm.runInContext('looksLikeDomain(input)', context, { timeout: 500 }), true);
  }
  for (const value of ['localhost', '127.0.0.1', '[::1]', '<script>.com', 'a'.repeat(64) + '.com',
    ('a'.repeat(62) + '.').repeat(10000) + '!', 'a.'.repeat(500000) + '!']) {
    context.input = value; assert.equal(vm.runInContext('looksLikeDomain(input)', context, { timeout: 500 }), false);
  }
});
