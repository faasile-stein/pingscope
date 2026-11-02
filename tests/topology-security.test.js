'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

const privateHops = ['10.20.30.1', '172.20.16.56', '192.168.4.1', '169.254.1.1',
  '127.0.0.1', 'fc00::1', 'fe80::1', '::ffff:7f00:1', '0:0:0:0:0:0:0:1'];
const publicHop = '8.8.8.8';
const hops = [...privateHops, publicHop].map((host, i) => ({
  count: i + 1, host, 'Loss%': 0, Snt: 3, Last: 1.5, Avg: 2, Best: 1, Wrst: 3, StDev: 0.5,
}));
function scriptedTrace(child, command, args) {
  assert.equal(command, 'mtr');
  setImmediate(() => {
    if (args.includes('--raw')) {
      child.stdout.emit('data', Buffer.from(hops.map((h, i) => `h ${i} ${h.host}\np ${i} 1500 1\n`).join('')));
      setTimeout(() => child.emit('close', 0), 200);
    } else {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ report: { hubs: hops } })));
      child.emit('close', 0);
    }
  });
}
function assertRedacted(rows) {
  assert.equal(rows.length, hops.length, 'hop positions are preserved');
  for (let i = 0; i < privateHops.length; i++) {
    assert.equal(rows[i].idx, i + 1);
    assert.equal(rows[i].host, null, privateHops[i]);
    assert.ok(rows[i].rdns == null);
    assert.equal(rows[i].geo.private, true);
  }
  assert.equal(rows.at(-1).host, publicHop, 'public route remains visible');
  const encoded = JSON.stringify(rows);
  for (const ip of privateHops) assert.ok(!encoded.includes(ip), ip + ' must not be exposed');
}

test('sovereignty stream keeps public MX probing but redacts private transit addresses', async (t) => {
  const f = await backendFixture({
    onSpawn: scriptedTrace,
    dns: {
      resolve4: (host) => host === 'mail.fixture.test' ? [publicHop] : ['127.0.0.1'],
      resolveMx: () => [{ exchange: 'mail.fixture.test', priority: 10 }],
    },
  });
  t.after(() => f.close());
  const messages = [];
  const ws = new WebSocket(f.base.replace('http:', 'ws:'), { origin: f.base });
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sovereignty scan did not finish')), 3000);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.type !== 'sov') return;
      messages.push(message);
      if (message.phase === 'done' || message.phase === 'error') { clearTimeout(timer); resolve(message); }
    });
  });
  ws.once('open', () => ws.send(JSON.stringify({ type: 'sov', url: '127.0.0.1.fixture.test' })));
  assert.equal((await finished).phase, 'done');
  const resolved = messages.find((m) => m.phase === 'resolved');
  assert.deepEqual(resolved.web, [], 'private DNS result is already rejected as a destination');
  assert.equal(resolved.mail[0].ip, publicHop);
  assert.equal(f.calls.spawn.length, 1);
  assert.equal(f.calls.spawn[0].args.at(-1), publicHop, 'only a public MX endpoint is traced');
  const traces = messages.filter((m) => m.phase === 'trace');
  assert.ok(traces.length > 0, 'exercise real streamed WebSocket output');
  for (const frame of traces) {
    assert.equal(frame.cat, 'mail');
    assertRedacted(frame.hops);
    assert.equal(frame.hops[0].last, 1.5, 'route timing remains available');
  }
  const done = messages.find((m) => m.phase === 'done');
  const stored = f.evaluate('JSON.parse(sovSeedStmt.all()[0].data)');
  const cachedResponse = await fetch(f.base + '/api/sovereignty?domain=127.0.0.1.fixture.test');
  assert.equal(cachedResponse.status, 200);
  const cached = await cachedResponse.json();
  assert.equal(cached.cached, true);
  assert.equal(f.calls.spawn.length, 1, 'cached completed scans do not trace again');
  for (const result of [done, stored, cached]) {
    assert.ok(!result.mail.hops, 'completed scores never persist raw hop lists');
    for (const address of privateHops) {
      assert.ok(!JSON.stringify({ web: result.web, mail: result.mail }).includes(address));
    }
  }
});

test('one-shot and community traces redact private hosts and reverse-DNS while preserving public controls', async (t) => {
  const f = await backendFixture({ onSpawn: scriptedTrace });
  t.after(() => f.close());
  const single = await f.evaluate("traceOnce('8.8.8.8')");
  assertRedacted(single.hops);
  f.context.hops = hops.map((h) => ({ idx: h.count, host: h.host, last: h.Last, avg: h.Avg }));
  f.evaluate("rdnsCache.set('10.20.30.1', 'private-router.internal'); rdnsCache.set('8.8.8.8', 'public.fixture.test')");
  const community = await f.evaluate('enrichAgentHops(hops)');
  assertRedacted(community);
  assert.equal(community[0].last, 1.5);
  assert.equal(community.at(-1).rdns, 'public.fixture.test');
  assert.ok(!JSON.stringify(community).includes('private-router.internal'));
});

test('local live MTR rounds apply the same address redaction', async (t) => {
  const f = await backendFixture({ onSpawn: scriptedTrace });
  t.after(() => f.close());
  const messages = [];
  f.context.traceSession = {};
  const round = new Promise((resolve) => {
    f.context.traceClient = { readyState: 1, send(raw) {
      const message = JSON.parse(raw);
      messages.push(message);
      if (message.round) {
        f.evaluate('stopMtr(traceSession)');
        resolve(message);
      }
    } };
  });
  f.evaluate("startMtr(traceClient, '8.8.8.8', traceSession)");
  const message = await round;
  assertRedacted(message.hops);
  assert.equal(message.hops[0].avg, 2);
  assert.equal(messages[0].target, publicHop);
});

test('resolved private IPv4 and equivalent IPv6 forms never become sovereignty trace targets', async (t) => {
  for (const address of ['10.0.0.1', '127.0.0.1', '169.254.169.254', 'fc00::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:0:0:1']) {
    const f = await backendFixture({ onSpawn: scriptedTrace, dns: {
      resolve4: () => address.includes(':') ? [] : [address],
      resolve6: () => address.includes(':') ? [address] : [],
    } });
    try {
      const response = await fetch(f.base + '/api/sovereignty?domain=private.fixture.test');
      assert.equal(response.status, 404, address);
      assert.equal(f.calls.spawn.length, 0, address);
    } finally { await f.close(); }
  }
});

test('canonical IPv6 validation keeps public address forms usable', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  for (const address of ['2001:4860:4860::8888', '2001:4860:4860:0:0:0:0:8888',
    '::ffff:8.8.8.8', '::ffff:0808:0808', '0:0:0:0:0:ffff:0808:0808']) {
    f.context.address = address;
    assert.equal(f.evaluate('isPublicIp(address)'), true, address);
  }
});
