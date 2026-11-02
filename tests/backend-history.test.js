'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

async function historyFixture(t) {
  const fixture = await backendFixture();
  t.after(() => fixture.close());
  fixture.evaluate(`
    PROBES = [{ id: 'dns-8-8-8-8', ip: '8.8.8.8', type: 'dns' }];
    db.exec('BEGIN');
    for (let i = 0; i < 25000; i++) insertStmt.run('dns-8-8-8-8', 1700000000000 + i * 1000, 0, 5, 5, 10, 20, 15, 12, 18, 15);
    db.exec('COMMIT');
  `);
  return fixture;
}

test('history bounds bucket output and rejects non-catalog prototype keys', async (t) => {
  const f = await historyFixture(t);
  const query = '/api/history?target=dns-8-8-8-8&from=0&to=99999999999999';
  const oversized = await fetch(f.base + query + '&buckets=999999999');
  assert.equal(oversized.status, 200);
  const data = await oversized.json();
  assert.ok(data.bucket >= Math.ceil((data.to - data.from) / 1000));
  assert.ok(data.targets['dns-8-8-8-8'].length <= 1000);
  const normal = await fetch(f.base + query + '&buckets=20');
  assert.equal(normal.status, 200);
  assert.equal((await normal.json()).targets['dns-8-8-8-8'][0].n, 25000);
  for (const target of ['__proto__', 'constructor', 'prototype', 'toString']) {
    const response = await fetch(f.base + '/api/history?target=' + target);
    assert.equal(response.status, 404);
  }
  assert.equal(f.evaluate('Object.prototype.polluted'), undefined);
});

test('history aggregation keeps the main event loop responsive for repeated targets', async (t) => {
  const f = await historyFixture(t);
  const targets = Array(40).fill('dns-8-8-8-8').join(',');
  let last = performance.now(), largestGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    largestGap = Math.max(largestGap, now - last);
    last = now;
  }, 5);
  t.after(() => clearInterval(timer));
  const response = await fetch(f.base + `/api/history?target=${targets}&from=1700000000000&to=1700025000000&buckets=240`);
  assert.equal(response.status, 200);
  assert.equal(Object.keys((await response.json()).targets).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(largestGap < 150, `main event loop stalled for ${largestGap.toFixed(1)}ms`);
  assert.equal((await fetch(f.base + '/api/probes')).status, 200);
});

test('history rejects non-finite ranges before touching SQLite', async (t) => {
  const f = await historyFixture(t);
  for (const query of ['to=Infinity', 'from=-Infinity', 'from=1&to=1', 'from=2&to=1']) {
    const response = await fetch(f.base + '/api/history?target=dns-8-8-8-8&' + query);
    assert.equal(response.status, 400, query);
  }
});

test('history reader bounds admission, deadlines and shutdown without losing normal requests', async (t) => {
  const f = await historyFixture(t);
  const reader = f.evaluate('historyReader');
  const params = { ids: ['dns-8-8-8-8'], from: 1700000000000, to: 1700025000000, bucket: 1000000 };
  reader.maxPending = 1;
  const first = reader.read(params);
  await assert.rejects(reader.read(params), /busy/);
  const normal = await first;
  assert.equal(normal['dns-8-8-8-8'].reduce((sum, row) => sum + row.n, 0), 25000);
  await reader.close();
  await assert.rejects(reader.read(params), /closed/);

  const { HistoryReader } = require('../history-reader');
  const timed = new HistoryReader(f.evaluate('DB_PATH'), { timeoutMs: 1, maxPending: 2 });
  t.after(() => timed.close());
  const outcomes = await Promise.allSettled([timed.read(params), timed.read(params)]);
  assert.ok(outcomes.every((r) => r.status === 'rejected' && /timed out/.test(r.reason.message)));
  // A timed-out worker must finish terminating before a replacement is used.
  await timed.stopping;
  timed.timeoutMs = 5000;
  assert.equal((await timed.read(params))['dns-8-8-8-8'].length, 25);
});

test('history overload returns retryable 503 while other APIs remain available', async (t) => {
  const f = await historyFixture(t);
  f.evaluate('historyReader.maxPending = 0');
  const busy = await fetch(f.base + '/api/history?target=dns-8-8-8-8&from=0&to=99999999999999');
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '5');
  assert.equal((await fetch(f.base + '/api/probes')).status, 200);
});

test('closing the history reader settles active and queued requests and releases its worker', async (t) => {
  const f = await historyFixture(t);
  const reader = f.evaluate('historyReader');
  const params = { ids: ['dns-8-8-8-8'], from: 0, to: 99999999999999, bucket: 100000000000 };
  const pending = Promise.allSettled([reader.read(params), reader.read(params)]);
  await reader.close();
  const results = await pending;
  assert.ok(results.every((r) => r.status === 'rejected' && /closed/.test(r.reason.message)));
  assert.equal(reader.active, null);
  assert.equal(reader.worker, null);
  assert.equal(reader.stopping, null);
  assert.equal(reader.queue.length, 0);
});

test('HTTP history deadlines expire active and queued SQLite work while other APIs respond', async (t) => {
  const f = await historyFixture(t);
  const query = '/api/history?target=dns-8-8-8-8&from=1700000000000&to=1700025000000&buckets=240';
  // Warm the real worker before adding bounded query cost, so the deadline is
  // exercised during SQLite work rather than only during worker startup.
  assert.equal((await fetch(f.base + query)).status, 200);
  f.evaluate(`
    db.exec('ALTER TABLE samples RENAME TO stored_samples');
    db.exec('CREATE VIEW samples AS WITH RECURSIVE copies(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM copies WHERE n<100) SELECT stored_samples.* FROM stored_samples CROSS JOIN copies');
    historyReader.timeoutMs = 50;
  `);
  const reader = f.evaluate('historyReader');
  const started = performance.now();
  const active = fetch(f.base + query);
  const queued = fetch(f.base + query);
  const probe = await fetch(f.base + '/api/probes');
  assert.equal(probe.status, 200);
  const responses = await Promise.all([active, queued]);
  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.deepEqual(await response.json(), { error: 'history busy — try again shortly' });
  }
  const responseMs = performance.now() - started;
  assert.ok(responseMs < 500, 'HTTP responses exceeded the bounded local deadline tolerance');
  t.diagnostic(`Both HTTP responses settled in ${responseMs.toFixed(1)}ms with a 50ms fixture deadline`);
  assert.equal(reader.queue.length, 0);
  assert.equal(reader.active, null);
  // The native query must actually stop at the deadline, not merely lose its
  // waiting HTTP client. Wait for process closure before checking recovery.
  await reader.stopping;
  const retiredMs = performance.now() - started;
  t.diagnostic(`Native SQLite execution retired in ${retiredMs.toFixed(1)}ms after the request began`);
  assert.ok(retiredMs < 500, `native SQLite work continued for ${retiredMs.toFixed(1)}ms after admission`);
  f.evaluate(`
    db.exec('DROP VIEW samples');
    db.exec('ALTER TABLE stored_samples RENAME TO samples');
    historyReader.timeoutMs = 5000;
  `);
  const recovered = await fetch(f.base + query);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).targets['dns-8-8-8-8'].reduce((sum, row) => sum + row.n, 0), 25000);
});
