'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

test('backend domain parser accepts normal domains and bounds adversarial regex near-matches', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  for (const [input, expected] of [
    ['example.com', 'example.com'],
    ['HTTPS://Example.COM/a?b=c', 'example.com'],
    ['www.example.co.uk:443/path', 'www.example.co.uk'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['a.'.repeat(125) + 'com', 'a.'.repeat(125) + 'com'],
  ]) {
    f.context.input = input;
    assert.equal(f.evaluate('parseSiteHost(input)'), expected);
  }
  for (const input of [
    'localhost', '127.0.0.1', '[::1]', 'example.com;id',
    'a'.repeat(64) + '.com', 'a.'.repeat(125) + 'a!',
    'a.'.repeat(126) + 'com', 'a'.repeat(1_000_000),
    ('a'.repeat(62) + '.').repeat(10_000) + '!',
  ]) {
    f.context.input = input;
    assert.equal(vm.runInContext('parseSiteHost(input)', f.context, { timeout: 500 }), null);
  }
  // Exercise the two ambiguous-looking bounded label forms at the maximum
  // accepted length. The timeout catches a catastrophic failure without tying
  // the test to a tight machine-specific benchmark.
  vm.runInContext(`
    for (let i = 0; i < 10000; i++) {
      if (DOMAIN_RE.test('a.'.repeat(125) + 'a!')) throw new Error('accepted bad TLD');
      if (DOMAIN_RE.test(('a'.repeat(62) + '.').repeat(3) + 'a'.repeat(62) + '!')) throw new Error('accepted bad label');
    }
  `, f.context, { timeout: 1000 });
});

test('sovereignty share page encodes hostile host headers and clamps attacker-supplied scores', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  const payload = '\"><img src=x onerror=alert(1)>';
  const query = new URLSearchParams({ d: payload, w: payload, m: '999' });
  const html = await new Promise((resolve, reject) => {
    http.get(f.base + '/sovereignty?' + query, { headers: { Host: 'example.invalid' + payload } }, (res) => {
      assert.equal(res.statusCode, 200);
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /example.invalid&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /mail 100\/100/);
  const response = await fetch(f.base + '/sovereignty?d=example.com&w=80&m=90');
  assert.equal(response.status, 200);
  const control = await response.text();
  assert.match(control, /European sovereignty check of example.com/);
  assert.match(control, /web 80\/100 · mail 90\/100/);
  assert.match(control, /d=example.com&amp;web=80&amp;mail=90/);
});
