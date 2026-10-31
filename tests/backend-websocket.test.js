'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

function connect(base, { origin, path = '/', headers } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + path, { origin, headers });
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode }); });
    ws.once('open', () => resolve({ status: 101, ws }));
  });
}
function message(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no message received')), 2000);
    ws.once('message', (raw) => { clearTimeout(timer); resolve(JSON.parse(raw)); });
  });
}

test('browser WebSocket rejects foreign, null and malformed origins; same-site and native clients still connect', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  for (const origin of ['https://attacker.invalid', 'null', f.base + '/injected', 'file:///tmp/example']) {
    const result = await connect(f.base, { origin });
    result.ws?.terminate();
    assert.equal(result.status, 403, origin);
  }
  for (const origin of [f.base, undefined]) {
    const result = await connect(f.base, { origin });
    assert.equal(result.status, 101, String(origin));
    result.ws.terminate();
  }
  const proxied = await connect(f.base, { origin: f.base.replace('http:', 'https:'), headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(proxied.status, 101);
  proxied.ws.terminate();
  const downgraded = await connect(f.base, { origin: f.base, headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(downgraded.status, 403);
  const defaultPort = await connect(f.base, { origin: 'http://example.test', headers: { Host: 'example.test:80' } });
  assert.equal(defaultPort.status, 101);
  defaultPort.ws.terminate();
  const agent = await connect(f.base, { path: '/agent' });
  assert.equal(agent.status, 101);
  const rejected = message(agent.ws);
  agent.ws.send(JSON.stringify({ type: 'hello', token: 'incorrect-local-token' }));
  assert.equal((await rejected).type, 'reject');
});

test('MTR rate limits isolate different client IPs and keep a same-IP cooldown across connections', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  const client = async (ip) => {
    const { ws } = await connect(f.base, { origin: f.base, headers: { 'X-Forwarded-For': ip + ', 192.0.2.1' } });
    return ws;
  };
  const first = await client('198.51.100.11');
  const firstReply = message(first);
  first.send(JSON.stringify({ type: 'mtr', ip: '8.8.8.8', vantages: [] }));
  assert.equal((await firstReply).start, true);
  const other = await client('198.51.100.12');
  const otherReply = message(other);
  other.send(JSON.stringify({ type: 'mtr', ip: '8.8.4.4', vantages: [] }));
  assert.equal((await otherReply).start, true);
  const sameIp = await client('198.51.100.11');
  const sameReply = message(sameIp);
  sameIp.send(JSON.stringify({ type: 'mtr', ip: '8.8.8.8', vantages: [] }));
  assert.match((await sameReply).error, /rate limited/);
  assert.equal(f.calls.spawn.length, 2);
  assert.ok(f.calls.spawn.every((c) => c.command === 'mtr'));
});
