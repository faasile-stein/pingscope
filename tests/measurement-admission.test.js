'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

async function client(f, forwarded) {
  const ws = new WebSocket(f.base.replace('http:', 'ws:'), { origin: f.base, headers: { 'X-Forwarded-For': forwarded } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}
function mtr(ws, ip) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no MTR response')), 2000);
    const receive = (raw) => {
      const message = JSON.parse(raw);
      if (message.type !== 'mtr') return;
      clearTimeout(timer); ws.off('message', receive); resolve(message);
    };
    ws.on('message', receive);
    ws.send(JSON.stringify({ type: 'mtr', ip, vantages: [] }));
  });
}

test('native clients cannot rotate forwarded headers to bypass the measurement cooldown', async (t) => {
  const f = await backendFixture(); t.after(() => f.close());
  const first = await client(f, '198.51.100.1');
  assert.equal((await mtr(first, '8.8.8.8')).start, true);
  const second = await client(f, '198.51.100.2');
  assert.match((await mtr(second, '8.8.4.4')).error || '', /rate limited/);
  assert.equal(f.calls.spawn.length, 1);
});

test('measurement cooldown applies before DNS work for a second connection', async (t) => {
  const f = await backendFixture({ dns: { resolve4: () => ['8.8.4.4'] } }); t.after(() => f.close());
  assert.equal((await mtr(await client(f, '198.51.100.1'), '8.8.8.8')).start, true);
  const reply = await mtr(await client(f, '198.51.100.1'), 'second.fixture.test');
  assert.match(reply.error, /rate limited/);
  assert.equal(f.calls.dns.length, 0, 'rejected jobs never start DNS');
});

test('global MTR admission waits for a stopped process to close before reusing its slot', async (t) => {
  const children = [];
  const f = await backendFixture({ env: { TRUST_PROXY: 'loopback' }, onSpawn: (child) => children.push(child) });
  t.after(() => { for (const child of children) child.emit('close', 0); return f.close(); });
  f.evaluate('MTR.maxActive = 1');
  const first = await client(f, '198.51.100.1');
  assert.equal((await mtr(first, '8.8.8.8')).start, true);
  assert.match((await mtr(await client(f, '198.51.100.2'), '8.8.4.4')).error, /busy/);
  first.send(JSON.stringify({ type: 'mtr-stop' }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match((await mtr(await client(f, '198.51.100.3'), '8.8.4.4')).error, /busy/);
  assert.equal(children.length, 1);
  children[0].emit('close', 0);
  assert.equal((await mtr(await client(f, '198.51.100.4'), '8.8.4.4')).start, true);
  assert.equal(children.length, 2);
});

test('disconnected clients do not launch a trace after delayed DNS resolution', async (t) => {
  let complete;
  const f = await backendFixture({ dns: { resolve4: () => new Promise(resolve => { complete = resolve; }) } });
  t.after(() => f.close());
  const ws = await client(f, '198.51.100.1');
  ws.send(JSON.stringify({ type: 'mtr', ip: 'delayed.fixture.test' }));
  while (!complete) await new Promise(resolve => setTimeout(resolve, 5));
  ws.terminate();
  await new Promise(resolve => setTimeout(resolve, 10));
  complete(['8.8.8.8']);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.calls.spawn.length, 0);
  assert.equal(f.evaluate('MTR.active.size'), 0);
});

test('browser and agent message handlers ignore non-object JSON without throwing', async (t) => {
  const f = await backendFixture(); t.after(() => f.close());
  const browser = await client(f, '198.51.100.1');
  const agent = new WebSocket(f.base.replace('http:', 'ws:') + '/agent');
  await new Promise((resolve, reject) => { agent.once('open', resolve); agent.once('error', reject); });
  // Invoke the installed event handlers directly so an uncaught event exception
  // can be asserted safely without crashing the process running the test suite.
  for (const endpoint of ['wss', 'ass']) {
    const peer = f.evaluate(`[...${endpoint}.clients][0]`);
    for (const raw of ['null', '[]', 'true', '42', '"text"']) {
      assert.doesNotThrow(() => peer.emit('message', Buffer.from(raw)), endpoint + ': ' + raw);
    }
  }
  assert.equal(f.calls.spawn.length, 0);
  assert.equal((await mtr(browser, '8.8.8.8')).start, true);
  const rejection = new Promise(resolve => agent.once('message', raw => resolve(JSON.parse(raw))));
  agent.send(JSON.stringify({ type: 'hello', token: 'incorrect-fixture-token' }));
  assert.equal((await rejection).type, 'reject');
});

test('MTR rejects argument and shell injection while public DNS controls use a literal argv target', async (t) => {
  const f = await backendFixture({ dns: { resolve4: () => ['8.8.8.8'] } });
  t.after(() => f.close());
  for (const target of ['8.8.8.8 -n', '127.0.0.1; id', '$(id).example', '--help']) {
    const ws = await client(f, '198.51.100.1');
    assert.match((await mtr(ws, target)).error, /refused/);
    ws.terminate();
  }
  assert.equal(f.calls.dns.length, 0);
  assert.equal(f.calls.spawn.length, 0);
  const ws = await client(f, '198.51.100.1');
  assert.equal((await mtr(ws, 'public.fixture.test')).start, true);
  assert.equal(f.calls.spawn.length, 1);
  assert.equal(f.calls.spawn[0].command, 'mtr');
  assert.deepEqual(Array.from(f.calls.spawn[0].args).slice(-2), ['--', '8.8.8.8']);
});

test('a cancelled trace holds its slot until pending reverse DNS settles', async (t) => {
  let complete;
  const children = [];
  const f = await backendFixture({ env: { TRUST_PROXY: 'loopback' }, dns: { reverse: () => new Promise(resolve => { complete = resolve; }) }, onSpawn: child => children.push(child) });
  t.after(() => f.close());
  f.evaluate('MTR.maxActive = 1');
  const ws = await client(f, '198.51.100.1');
  assert.equal((await mtr(ws, '8.8.8.8')).start, true);
  children[0].stdout.emit('data', Buffer.from(JSON.stringify({ report: { hubs: [{ count: 1, host: '8.8.8.8' }] } })));
  children[0].emit('close', 0);
  assert.ok(complete);
  ws.send(JSON.stringify({ type: 'mtr-stop' }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.evaluate('MTR.active.size'), 1);
  assert.match((await mtr(await client(f, '198.51.100.2'), '8.8.4.4')).error, /busy/);
  complete([]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.evaluate('MTR.active.size'), 0);
  assert.equal((await mtr(await client(f, '198.51.100.3'), '8.8.4.4')).start, true);
});
