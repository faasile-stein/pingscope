'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

const directive = (policy, name) => policy.split('; ').find((part) => part.startsWith(`${name} `)).split(' ').slice(1);

test('CSP allows same-origin modules and the import-map nonce, without a public script CDN', async (t) => {
  const fixture = await backendFixture();
  t.after(() => fixture.close());
  const response = await fetch(fixture.base);
  const policy = response.headers.get('content-security-policy');
  const html = await response.text();
  const scripts = directive(policy, 'script-src');
  assert.ok(scripts.includes("'self'"), 'same-origin module control remains supported');
  assert.ok(scripts.some((source) => source.startsWith("'nonce-")), 'import-map nonce is present');
  assert.ok(!scripts.some((source) => /^https?:/.test(source)), 'an arbitrary package on a public CDN must not be a script source');
  const imports = JSON.parse(/<script type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]).imports;
  assert.equal(imports.three, '/vendor/three/build/three.module.js');
  assert.equal(imports['three/addons/'], '/vendor/three/addons/');
  for (const resource of [imports.three, `${imports['three/addons/']}controls/OrbitControls.js`, `${imports['three/addons/']}postprocessing/EffectComposer.js`]) {
    const module = await fetch(`${fixture.base}${resource}`);
    assert.equal(module.status, 200, resource);
    assert.match(module.headers.get('content-type'), /javascript/);
    assert.ok((await module.text()).length > 1000, 'real module content is served');
  }
  const privatePackage = await fetch(`${fixture.base}/vendor/three/package.json`);
  assert.equal(privatePackage.status, 404, 'only browser module directories are exposed');
  await privatePackage.text();
});

test('pages use same-origin stylesheets and CSP rejects arbitrary inline styles', async (t) => {
  const fixture = await backendFixture();
  t.after(() => fixture.close());
  for (const route of ['/', '/ranking', '/sovereignty']) {
    const response = await fetch(`${fixture.base}${route}`);
    assert.equal(response.status, 200);
    assert.deepEqual(directive(response.headers.get('content-security-policy'), 'style-src'), ["'self'"]);
    const html = await response.text();
    assert.doesNotMatch(html, /<style\b|\sstyle\s*=/i, route);
    const stylesheet = /<link rel="stylesheet" href="([^"]+)"/.exec(html)?.[1];
    assert.ok(stylesheet, `${route} keeps its page styles`);
    const css = await fetch(new URL(stylesheet, `${fixture.base}${route}`));
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.ok((await css.text()).length > 1000);
  }
  for (const file of ['app.js', 'overview.js', 'globe.js', 'mtr.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), /\sstyle\s*=/, `${file} does not inject CSP-blocked style attributes`);
  }
});

test('public JSON and static responses retain baseline security controls', async (t) => {
  const fixture = await backendFixture();
  t.after(() => fixture.close());
  for (const route of ['/', '/app.js', '/api/probes', '/api/targets']) {
    const response = await fetch(`${fixture.base}${route}`);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('strict-transport-security'), /^max-age=\d+; includeSubDomains$/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(response.headers.get('permissions-policy'), /geolocation=\(\), microphone=\(\), camera=\(\)/);
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.deepEqual(directive(response.headers.get('content-security-policy'), 'frame-ancestors'), ["'none'"]);
    await response.text();
  }
  assert.deepEqual(fixture.calls, { spawn: [], dns: [] });
});

test('unknown routes use a generic body without framework or request-path disclosure', async (t) => {
  const fixture = await backendFixture();
  t.after(() => fixture.close());
  for (const route of ['/robots.txt', '/api/mtr', '/%3Cscript%3Ealert(1)%3C/script%3E']) {
    const response = await fetch(`${fixture.base}${route}`);
    assert.equal(response.status, 404, route);
    const body = await response.text();
    assert.doesNotMatch(body, /<script>|Cannot GET|express@|node_modules|server\.js|\/home\/|Error:\n| at \w/);
    assert.equal(body, 'Not found');
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'");
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  }
  const control = await fetch(`${fixture.base}/api/probes`);
  assert.equal(control.status, 200);
  await control.text();
  assert.deepEqual(fixture.calls, { spawn: [], dns: [] });
});
