'use strict';
// Optional real-browser regression, using the existing ws dependency and a local
// Chromium binary. PINGSCOPE_CHROMIUM=/path/to/chrome node --experimental-sqlite tests/browser-csp.cjs
// All page requests are intercepted: non-loopback traffic is blocked. The server
// fixture disables external DNS and probe processes, and uses a temporary DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

async function main() {
  if (!process.env.PINGSCOPE_CHROMIUM) throw new Error('Set PINGSCOPE_CHROMIUM to an existing Chromium binary');
  const fixture = await backendFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingscope-browser-'));
  let child, socket;
  try {
    fixture.evaluate(`PROBES = [{ id: 'dns-fixture', type: 'dns', provider: 'Fixture DNS', ip: '8.8.8.8', cc: 'FR', country: 'France', city: 'Paris', lat: 48.86, lon: 2.35, as: 'AS1', asName: 'Fixture Network' }]; PRESELECTED = ['dns-fixture']; history.set('dns-fixture', [{ targetId: 'dns-fixture', t: Date.now(), median: 3, min: 1, max: 5, p25: 2, p75: 4, loss: 0.1 }]);`);
    const policyResponse = await fetch(fixture.base);
    const controlPolicy = policyResponse.headers.get('content-security-policy');
    await policyResponse.text();
    // Browser-only attack fixtures carry the actual emitted policy. Intercept
    // them locally instead of adding routes to the real application.
    const controls = {
      '/_csp-control': { type: 'text/html', body: '<!doctype html><style>body { color: rgb(255, 0, 0) }</style><div id="blocked" style="color:rgb(255,0,0)">blocked</div><div id="allowed">allowed</div><script src="https://unpkg.com/pingscope-csp-fixture.js"></script><script src="/_csp-control.js"></script>' },
      '/_csp-control.js': { type: 'text/javascript', body: 'document.getElementById("allowed").style.color = "rgb(0,128,0)";' },
    };
    child = spawn(process.env.PINGSCOPE_CHROMIUM, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chromium startup timed out')), 15000);
      let stderr = '';
      child.on('error', reject);
      child.stderr.on('data', (data) => {
        stderr += data;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let id = 0, sessionId;
    const pending = new Map(), events = [];
    const command = (method, params = {}, browser = false) => new Promise((resolve, reject) => {
      const messageId = ++id;
      const timeout = setTimeout(() => { pending.delete(messageId); reject(new Error(`${method} timed out`)); }, 15000);
      pending.set(messageId, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id: messageId, method, params, ...(!browser && sessionId ? { sessionId } : {}) }));
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.id) {
        const p = pending.get(message.id); if (!p) return;
        clearTimeout(p.timeout); pending.delete(message.id);
        message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result);
      } else {
        events.push(message);
        if (message.method === 'Fetch.requestPaused') {
          const { requestId, request } = message.params;
          const allowed = request.url.startsWith(`${fixture.base}/`);
          const control = allowed && controls[new URL(request.url).pathname];
          if (control) {
            command('Fetch.fulfillRequest', { requestId, responseCode: 200,
              responseHeaders: [{ name: 'Content-Type', value: control.type }, { name: 'Content-Security-Policy', value: controlPolicy }],
              body: Buffer.from(control.body).toString('base64'),
            }).catch(() => {});
          } else {
            command(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => {});
          }
        }
      }
    });
    const target = await command('Target.createTarget', { url: 'about:blank' }, true);
    sessionId = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true }, true)).sessionId;
    await command('Page.enable'); await command('Runtime.enable');
    await command('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await command('Page.addScriptToEvaluateOnNewDocument', { source: 'window.violations = []; document.addEventListener("securitypolicyviolation", (e) => window.violations.push({ directive:e.effectiveDirective, blocked:e.blockedURI }));' });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const navigate = async (route, ready) => {
      await command('Page.navigate', { url: fixture.base + route });
      await evaluate(`new Promise((resolve, reject) => { const started = Date.now(); const check = () => { if (${ready}) resolve(true); else if (Date.now() - started > 10000) reject(new Error('page not ready')); else setTimeout(check, 50); }; check(); })`);
    };
    await navigate('/_csp-control', 'document.getElementById("allowed")?.style.color');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("allowed")).color'), 'rgb(0, 128, 0)', 'DOM property control still works');
    assert.notEqual(await evaluate('getComputedStyle(document.getElementById("blocked")).color'), 'rgb(255, 0, 0)', 'injected attribute/block style is rejected');
    const violations = await evaluate('window.violations');
    for (const directive of ['style-src-elem', 'style-src-attr', 'script-src-elem']) assert.ok(violations.some(v => v.directive === directive), directive);
    assert.ok(violations.some(v => v.blocked.startsWith('https://unpkg.com/')), 'public CDN script is blocked by CSP');

    await navigate('/', 'document.querySelector(".sel-type-h") && document.getElementById("conn-text").textContent === "live"');
    assert.notEqual(await evaluate('getComputedStyle(document.getElementById("globe")).display'), 'none', 'default globe view is visible');
    await evaluate("document.querySelector('[data-view=graph]').click()");
    assert.equal(await evaluate('getComputedStyle(document.getElementById("globe")).display'), 'none');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".sel-type-h")).color'), 'rgb(74, 216, 255)');
    fixture.evaluate(`broadcast({ type: 'agents', agents: [{ id: 'agent-1', cc: 'FR', country: 'France', name: 'Fixture' }] }); broadcast({ type: 'samples', data: [{ targetId: 'dns-fixture', t: Date.now(), median: 3, min: 1, max: 5, p25: 2, p75: 4, loss: 0.1 }] });`);
    await evaluate('document.getElementById("btn-showall").click()');
    await evaluate(`new Promise((resolve, reject) => { const started = Date.now(); const check = () => { if (document.querySelector('.vchip[data-id]') && document.querySelector('.ov-now b')?.style.color) resolve(true); else if (Date.now() - started > 5000) reject(new Error('fixture rendering timed out')); else setTimeout(check, 50); }; check(); })`);
    assert.notEqual(await evaluate('getComputedStyle(document.getElementById("overview")).display'), 'none');
    assert.ok(await evaluate('document.querySelector(".vchip[data-id]").style.getPropertyValue("--c")'));
    assert.ok(await evaluate('document.querySelector(".ov-now b").style.color'));
    assert.ok(await evaluate('document.querySelector(".ov-loss").style.color'));
    assert.deepEqual(await evaluate('window.violations'), [], 'real visualization UI has no CSP violations');

    for (const route of ['/ranking', '/sovereignty']) {
      await navigate(route, 'document.readyState === "complete"');
      assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(6, 7, 14)');
      assert.deepEqual(await evaluate('window.violations'), [], `${route} has no CSP violations`);
    }
    const errors = events.filter(e => e.method === 'Runtime.exceptionThrown');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log('PASS: Chromium blocked hostile inline CSS and CDN script; local modules, DOM styles, live overview/vantages and both standalone pages work without CSP violations. Non-loopback page requests were blocked.');
  } finally {
    socket?.terminate();
    if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    await fixture.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
