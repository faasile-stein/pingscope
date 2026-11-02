'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

const json = (value) => JSON.parse(JSON.stringify(value));

test('community hop enrichment rejects malformed rows and normalizes numeric fields while preserving valid data', async (t) => {
  const f = await backendFixture({ dns: { reverse: () => ['public.fixture.test'] } });
  t.after(() => f.close());
  f.context.input = [null, false, 'not a hop', [], {}, {
    idx: 1.5, host: { private: '10.0.0.1' }, loss: 'bad-value', snt: Infinity,
    last: NaN, avg: {}, best: -1, wrst: '3.2', stdev: false,
  }, {
    idx: 7, host: '8.8.8.8', loss: 25, snt: 4, last: 1.5, avg: 2,
    best: 1, wrst: 3.2, stdev: 0.7,
  }, { idx: 999999999, host: 'private-router.internal', loss: 101, snt: 2.5 }];
  const rows = json(await f.evaluate('enrichAgentHops(input)'));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].host, null);
  assert.equal(rows[1].idx, 2);
  assert.equal(rows[1].host, null);
  assert.equal(rows[1].loss, 0);
  assert.equal(rows[1].snt, 0);
  for (const metric of ['last', 'avg', 'best', 'wrst', 'stdev']) assert.equal(rows[1][metric], null, metric);
  assert.deepEqual(Object.fromEntries(['idx', 'host', 'loss', 'snt', 'last', 'avg', 'best', 'wrst', 'stdev'].map(k => [k, rows[2][k]])), {
    idx: 7, host: '8.8.8.8', loss: 25, snt: 4, last: 1.5, avg: 2, best: 1, wrst: 3.2, stdev: 0.7,
  });
  assert.equal(rows[2].rdns, 'public.fixture.test');
  assert.equal(rows[3].idx, 4);
  assert.equal(rows[3].host, null);
  assert.equal(rows[3].loss, 0);
  assert.equal(rows[3].snt, 0);
  assert.deepEqual(f.calls.dns, [{ method: 'reverse', host: '8.8.8.8' }]);
  assert.doesNotMatch(JSON.stringify(rows), /bad-value|private-router|10\.0\.0\.1/);
});

test('agent result enrichment failure returns a bounded trace error instead of an unhandled rejection', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  const messages = [];
  f.context.browser = { readyState: 1, send: raw => messages.push(JSON.parse(raw)) };
  f.evaluate("agentReplies.set('fixture-request', { ws: browser, agentId: 'agent-fixture', timer: null }); geoLookup = () => { throw new Error('fixture lookup failure'); };");
  await f.evaluate("handleAgentResult({ id: 'agent-fixture' }, { reqId: 'fixture-request', hops: [{ idx: 1, host: '8.8.8.8' }] })");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].done, true);
  assert.equal(messages[0].error, 'trace failed');
  assert.equal(f.evaluate("agentReplies.has('fixture-request')"), false);
  assert.doesNotMatch(JSON.stringify(messages), /fixture lookup failure/);
});

test('only the assigned agent can consume a pending trace result', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  const messages = [];
  f.context.browser = { readyState: 1, send: raw => messages.push(JSON.parse(raw)) };
  f.evaluate("agentReplies.set('fixture-request', { ws: browser, agentId: 'assigned-agent', timer: null });");
  for (const result of [{ error: 'forged result' }, { hops: [{ idx: 1, host: '8.8.4.4' }] }]) {
    f.context.result = { reqId: 'fixture-request', ...result };
    await f.evaluate("handleAgentResult({ id: 'different-agent' }, result)");
    assert.equal(f.evaluate("agentReplies.has('fixture-request')"), true, 'unassigned agent must not consume the request');
    assert.equal(messages.length, 0);
    assert.equal(f.calls.dns.length, 0, 'unassigned result must not trigger enrichment');
  }
  await f.evaluate("handleAgentResult({ id: 'assigned-agent' }, { reqId: 'fixture-request', hops: [{ idx: 1, host: '8.8.8.8', avg: 2 }] })");
  assert.equal(f.evaluate("agentReplies.has('fixture-request')"), false);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, 'assigned-agent');
  assert.equal(messages[0].hops[0].host, '8.8.8.8');
  assert.equal(messages[0].hops[0].avg, 2);
});
