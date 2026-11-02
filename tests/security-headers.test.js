'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

test('real application responses already provide CSP, HSTS and framing protection', async (t) => {
  const fixture = await backendFixture();
  t.after(() => fixture.close());
  for (const route of ['/', '/sovereignty', '/ranking', '/app.js', '/missing-security-control']) {
    const response = await fetch(`${fixture.base}${route}`);
    assert.equal(response.status, route.startsWith('/missing') ? 404 : 200, route);
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp, `${route}: CSP present`);
    if (response.status === 404) {
      // Generic errors keep a strict policy; Helmet's DENY header also
      // prevents framing.
      assert.equal(csp, "default-src 'none'");
    } else {
      assert.ok(csp.includes("frame-ancestors 'none'"), route);
      assert.ok(csp.includes("object-src 'none'"), route);
      assert.ok(csp.includes("default-src 'self'"), route);
    }
    assert.equal(response.headers.get('x-frame-options'), 'DENY', route);
    assert.match(response.headers.get('strict-transport-security'), /^max-age=\d+; includeSubDomains$/);
    assert.equal(response.headers.get('x-powered-by'), null, route);
    assert.equal(response.headers.get('server'), null, `${route}: nginx is outside this app`);
    await response.text();
  }
  assert.deepEqual(fixture.calls, { spawn: [], dns: [] });
});

test('root CSP authorizes only its fresh import-map nonce; static scripts get no nonce', async (t) => {
  const fixture = await backendFixture();
  t.after(() => fixture.close());
  const seen = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch(fixture.base);
    const html = await response.text();
    const nonce = /<script type="importmap" nonce="([^"]+)">/.exec(html)?.[1];
    assert.ok(nonce && nonce !== '__CSP_NONCE__');
    const scriptPolicy = response.headers.get('content-security-policy').split('; ').find((rule) => rule.startsWith('script-src '));
    assert.ok(scriptPolicy.includes(`'nonce-${nonce}'`));
    assert.ok(!scriptPolicy.includes("'unsafe-inline'"));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    seen.push(nonce);
  }
  assert.notEqual(seen[0], seen[1]);
  const staticResponse = await fetch(`${fixture.base}/app.js`);
  assert.ok(!staticResponse.headers.get('content-security-policy').includes('nonce-'));
  await staticResponse.text();
});
