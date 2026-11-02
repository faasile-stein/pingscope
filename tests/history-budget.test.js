'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

test('history charges large repeated queries before SQLite; small queries and other clients remain usable', async (t) => {
  const f = await backendFixture({ env: { TRUST_PROXY: 'loopback' } });
  t.after(() => f.close());
  f.evaluate(`
    PROBES = Array.from({ length: 80 }, (_, i) => ({ id: 'fixture-' + i }));
    globalThis.historyReads = 0;
    historyReader.read = async ({ ids }) => {
      historyReads++;
      return Object.fromEntries(ids.map((id) => [id, []]));
    };
  `);
  const query = '/api/history?from=1700000000000&to=1700003600000&buckets=1000';
  const first = await fetch(f.base + query);
  assert.equal(first.status, 200);
  assert.equal(Object.keys((await first.json()).targets).length, 80);
  const repeated = await fetch(f.base + query);
  assert.equal(repeated.status, 429);
  assert.ok(Number(repeated.headers.get('retry-after')) > 0);
  assert.match((await repeated.json()).error, /history rate limited/);
  assert.equal(f.evaluate('historyReads'), 1, 'limited queries do not reach SQLite');

  // One selected graph costs much less than downloading the whole catalog.
  const small = await fetch(f.base + query + '&target=fixture-0');
  assert.equal(small.status, 200);
  assert.deepEqual(Object.keys((await small.json()).targets), ['fixture-0']);
  const other = await fetch(f.base + query, { headers: { 'X-Forwarded-For': '198.51.100.12' } });
  assert.equal(other.status, 200);
  await other.arrayBuffer();
  assert.equal((await fetch(f.base + '/api/probes')).status, 200);
});

test('direct clients cannot rotate forwarded headers to bypass the history budget', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  f.evaluate(`
    PROBES = Array.from({ length: 80 }, (_, i) => ({ id: 'fixture-' + i }));
    historyReader.read = async () => ({});
  `);
  const query = '/api/history?from=1700000000000&to=1700003600000&buckets=1000';
  const first = await fetch(f.base + query, { headers: { 'X-Forwarded-For': '198.51.100.1' } });
  assert.equal(first.status, 200);
  await first.text();
  const second = await fetch(f.base + query, { headers: { 'X-Forwarded-For': '198.51.100.2' } });
  assert.equal(second.status, 429);
  await second.text();
});

test('history budget refills, bounds client state and gives an accurate retry delay', () => {
  const { HistoryBudget } = require('../history-budget');
  let now = 0;
  const budget = new HistoryBudget({ capacity: 100, refillMs: 60000, maxClients: 2, now: () => now });
  assert.equal(budget.take('one', 80), 0);
  assert.equal(budget.take('one', 80), 36);
  assert.equal(budget.take('two', 10), 0);
  assert.equal(budget.take('three', 10), 60, 'full client map fails closed');
  assert.equal(budget.clients.size, 2);
  now += 36000;
  assert.equal(budget.take('one', 80), 0);
  now += 60000;
  assert.equal(budget.take('three', 100), 0, 'fully refilled inactive clients can be discarded');
  assert.ok(budget.clients.size <= 2);
  assert.equal(budget.take('three', 101), 60, 'oversized work is never admitted');
});

test('real SQLite bulk history is bounded and throttled while a selected target stays available', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  f.evaluate(`
    PROBES = Array.from({ length: 80 }, (_, i) => ({ id: 'fixture-' + i }));
    historyBudget.now = () => 0;
    db.exec('BEGIN');
    for (const probe of PROBES) {
      for (let i = 0; i < 1000; i++) {
        insertStmt.run(probe.id, 1700000000000 + i * 1000, 0, 5, 5, 10, 20, 15, 12, 18, 15);
      }
    }
    db.exec('COMMIT');
  `);
  const query = '/api/history?from=1700000000000&to=1700001000000&buckets=1000';
  const first = await fetch(f.base + query);
  assert.equal(first.status, 200);
  const bulkBytes = Buffer.from(await first.arrayBuffer());
  assert.ok(bulkBytes.length > 3_000_000, 'fixture must reproduce a multi-megabyte response');
  const data = JSON.parse(bulkBytes.toString('utf8'));
  assert.equal(data.bucket, 1000);
  assert.equal(Object.keys(data.targets).length, 80);
  for (const rows of Object.values(data.targets)) {
    assert.equal(rows.length, 1000);
    assert.equal(rows.reduce((total, row) => total + row.n, 0), 1000);
  }
  const repeated = await fetch(f.base + query);
  assert.equal(repeated.status, 429);
  assert.equal(repeated.headers.get('retry-after'), '36');
  assert.match(await repeated.text(), /history rate limited/);
  const selected = await fetch(f.base + query + '&target=fixture-0');
  assert.equal(selected.status, 200);
  const selectedBytes = Buffer.from(await selected.arrayBuffer());
  const selectedData = JSON.parse(selectedBytes.toString('utf8'));
  assert.deepEqual(Object.keys(selectedData.targets), ['fixture-0']);
  assert.equal(selectedData.targets['fixture-0'].length, 1000);
  assert.ok(selectedBytes.length < bulkBytes.length / 70);
  assert.equal((await fetch(f.base + '/api/probes')).status, 200);
  t.diagnostic(`Real SQLite returned ${bulkBytes.length} bytes / 80000 buckets; repeat HTTP 429; selected target ${selectedBytes.length} bytes / 1000 buckets with HTTP 200`);
});
