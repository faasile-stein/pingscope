'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

test('all share metadata escapes hostile attribute text; normal text remains readable', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  const payload = '\"><img src=x onerror=alert(1)>&\'';
  f.context.payload = payload;
  const rendered = f.evaluate('ogTags({ title: payload, desc: payload, image: payload, url: payload })');
  assert.equal((rendered.match(/&lt;img/g) || []).length, 7);
  assert.equal((rendered.match(/&quot;/g) || []).length, 7);
  assert.equal((rendered.match(/&#39;/g) || []).length, 7);
  assert.doesNotMatch(rendered, /<img/);
  assert.match(f.evaluate("ogTags({title: 'example.com', desc: 'Normal description', image: '/og', url: '/'})"), /content="example.com"/);
  const html = await new Promise((resolve, reject) => {
    http.get(f.base + '/?mtr=' + encodeURIComponent(payload), { headers: { Host: 'example.invalid"><img src=x>' } }, (response) => {
      assert.equal(response.statusCode, 200);
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(body));
    }).on('error', reject);
  });
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /example.invalid&quot;&gt;&lt;img src=x&gt;/);
});

test('SVG previews use escaped text, clamped scores and constant numeric geometry', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  const payload = '</text><script>alert(1)</script>';
  const response = await fetch(f.base + '/og?mtr=' + encodeURIComponent(payload) + '&n=' + encodeURIComponent(payload));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
  const svg = await response.text();
  assert.doesNotMatch(svg, /<script|onload=|onerror=/);
  assert.equal((svg.match(/<circle /g) || []).length, 7);
  const control = await fetch(f.base + '/og?mtr=example.com&n=2');
  assert.match(await control.text(), /MTR ⟶ example.com/);
  f.context.payload = payload;
  const sov = f.evaluate('sovOgSvg({domain: payload, web: clampScore(payload), mail: clampScore(999)})');
  assert.match(sov, /&lt;\/text&gt;&lt;script&gt;/);
  assert.doesNotMatch(sov, /<script>/);
  assert.match(sov, />100<tspan/);
  f.evaluate('SOV_FONT.fontDirs = []; SOV_FONT.loadSystemFonts = false');
  const png = await fetch(f.base + '/og/sovereignty?d=' + encodeURIComponent(payload) + '&web=' + encodeURIComponent(payload) + '&mail=999');
  assert.equal(png.status, 200);
  assert.match(png.headers.get('content-type'), /image\/png/);
});

test('host validator bounds input before the domain regex, with valid and near-match controls', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  for (const host of ['example.com', 'localhost', 'a'.repeat(63) + '.com', 'a.'.repeat(126) + 'a', '8.8.8.8', '2001:4860:4860::8888']) {
    f.context.host = host;
    assert.equal(f.evaluate('isValidHost(host)'), true, host);
  }
  for (const host of ['a'.repeat(64) + '.com', 'a.'.repeat(125) + 'a!', 'a'.repeat(100000), 'a..com', '-a.com', 'a-.com', 'example.com;id']) {
    f.context.host = host;
    assert.equal(f.evaluate('isValidHost(host)'), false, host.slice(0, 80));
  }
  f.evaluate("for(let i=0;i<10000;i++) { if(isValidHost('a.'.repeat(125)+'a!')) throw new Error('unexpected accepted host'); }");
});

test('backup recovery paths come from local directory entries, and normal backups recover', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  const backupPath = f.evaluate('DB_PATH') + '.corrupt-fixture';
  const backup = new DatabaseSync(backupPath);
  backup.exec(`CREATE TABLE sov_scores (domain TEXT, web INTEGER, mail INTEGER, data TEXT, at INTEGER);
    CREATE TABLE samples (target_id TEXT, t INTEGER, loss REAL, sent INTEGER, recv INTEGER, min REAL, max REAL, median REAL, p25 REAL, p75 REAL, avg REAL);`);
  backup.prepare('INSERT INTO sov_scores VALUES (?, ?, ?, ?, ?)').run('example.invalid', 80, 90, '{}', Date.now());
  backup.prepare('INSERT INTO samples VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('dns-8-8-8-8', Date.now(), 0, 5, 5, 1, 2, 1.5, 1, 2, 1.5);
  backup.close();
  f.evaluate('recoverCorruptRanking()');
  assert.ok(fs.existsSync(backupPath.replace('.corrupt-', '.imported-')));
  assert.equal(f.evaluate('sovCountStmt.get().c'), 1);
  await f.evaluate('salvageSamples()');
  assert.ok(fs.existsSync(backupPath.replace('.corrupt-', '.samples-done-')));
  assert.equal(f.evaluate("db.prepare('SELECT count(*) n FROM samples').get().n"), 1);
  const traversal = await fetch(f.base + '/api/history?target=..%2F..%2Fetc%2Fpasswd');
  assert.equal(traversal.status, 404);
});

test('public read APIs neither require nor create cookie authentication', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  for (const endpoint of ['/', '/api/probes', '/api/rankings']) {
    const anonymous = await fetch(f.base + endpoint);
    const unrelatedCookie = await fetch(f.base + endpoint, { headers: { Cookie: 'session=local-fixture-only' } });
    assert.equal(anonymous.status, 200);
    assert.equal(unrelatedCookie.status, anonymous.status);
    assert.equal(anonymous.headers.get('set-cookie'), null);
    if (endpoint.startsWith('/api/')) assert.deepEqual(await anonymous.json(), await unrelatedCookie.json());
  }
});
