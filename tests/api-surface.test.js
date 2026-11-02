'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

test('history uses the documented target filter; guessed parameters cannot reach commands or select private data', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  f.evaluate(`
    PROBES = [{ id: 'fixture-a' }, { id: 'fixture-b' }];
    insertStmt.run('fixture-a', 1700000001000, 0, 5, 5, 10, 20, 15, 12, 18, 15);
    insertStmt.run('fixture-b', 1700000001000, 0, 5, 5, 20, 30, 25, 22, 28, 25);
  `);
  const query = '/api/history?from=1700000000000&to=1700003600000';
  const baseline = await (await fetch(f.base + query)).json();
  assert.deepEqual(Object.keys(baseline.targets), ['fixture-a', 'fixture-b']);
  for (const extra of ['id=fixture-a', 'id=nonexistent-probe-123', 'probe=fixture-a&host=1.1.1.1', 'probe=nonexistent-probe-123&host=8.8.8.8', 'host=example.com', 'host=%3Bid']) {
    const response = await fetch(f.base + query + '&' + extra);
    assert.equal(response.status, 200, extra);
    assert.deepEqual(await response.json(), baseline, extra);
  }
  for (const target of ['fixture-a', 'fixture-b']) {
    const response = await fetch(f.base + query + '&target=' + target);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys((await response.json()).targets), [target]);
  }
  for (const target of ['nonexistent-probe-123', '1.1.1.1', '127.0.0.1', 'example.com']) {
    const response = await fetch(f.base + query + '&probe=fixture-a&target=' + target);
    assert.equal(response.status, 404, target);
    assert.deepEqual(await response.json(), { error: 'unknown target' });
  }
  const documented = await fetch(f.base + query + '&probe=fixture-a&target=fixture-b');
  assert.equal(documented.status, 200);
  assert.deepEqual(Object.keys((await documented.json()).targets), ['fixture-b']);
  assert.deepEqual(f.calls, { spawn: [], dns: [] });
});

test('public catalog contains configured measurement targets, while volunteer agents omit their IPs', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  f.context.catalogText = fs.readFileSync(path.join(__dirname, '../probes.conf'), 'utf8');
  const count = f.evaluate('parseConf(catalogText).length');
  f.evaluate(`
    PROBES = parseConf(catalogText).map((p, i) => ({ id: 'fixture-' + i, ip: p.host, provider: p.name, type: p.type }));
    agents.set('agent-fixture', { id: 'agent-fixture', name: 'Volunteer', ip: '198.51.100.217', country: 'Example', cc: 'XX', asn: 64500, asName: 'Test AS', token: 'not-public' });
  `);
  const probes = await (await fetch(f.base + '/api/probes')).json();
  const targets = await (await fetch(f.base + '/api/targets')).json();
  assert.equal(probes.probes.length, count);
  assert.deepEqual(probes.probes, targets);
  assert.doesNotMatch(JSON.stringify(probes), /198\.51\.100\.217|not-public/);
  const publicAgents = JSON.parse(f.evaluate('JSON.stringify(publicAgents())'));
  assert.equal(publicAgents[0].name, 'Volunteer');
  assert.equal(publicAgents[0].asName, 'Test AS');
  assert.equal(publicAgents[0].ip, undefined);
  assert.equal(publicAgents[0].asn, undefined);
  assert.equal(publicAgents[0].token, undefined);
  assert.deepEqual(f.calls, { spawn: [], dns: [] });
});

test('reported REST guesses return 404; actual WebSocket MTR rejects injection and private targets', async (t) => {
  const f = await backendFixture();
  t.after(() => f.close());
  const guesses = [
    '/api', '/api/', '/api/mtr', '/api/mtr/run', '/api/mtr/stream',
    '/api/mtr/fixture/1.1.1.1', '/api/mtr/1.1.1.1', '/api/mtr/example.com', '/api/mtr/fixture',
    '/api/mtr?target=fixture', '/api/mtr?probe=fixture&target=1.1.1.1',
    '/api/trace', '/api/traceroute', '/api/ping', '/api/latency', '/api/measure',
    '/api/hops', '/api/paths', '/api/track', '/api/stream', '/api/sse', '/api/events',
    '/api/live', '/api/live?target=fixture', '/api/live/fixture', '/api/samples',
    '/api/agents', '/api/agent', '/api/agent/mtr', '/api/geoip', '/api/summary',
    '/api/latest', '/api/overview', '/api/health', '/socket.io/',
    '/socket.io/?transport=polling', '/socket.io/?EIO=4&transport=polling',
    '/ws', '/api/ws', '/robots.txt', '/sitemap.xml',
  ];
  for (const route of guesses) {
    const response = await fetch(f.base + route);
    assert.equal(response.status, 404, route);
    assert.equal(await response.text(), 'Not found', route);
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'", route);
    assert.equal(response.headers.get('server'), null, 'application response has no nginx banner');
    assert.equal(response.headers.get('x-powered-by'), null, route);
  }
  for (const route of ['/api/mtr', '/api/mtr?host=1.1.1.1', '/api/mtr?probe=fixture&target=1.1.1.1', '/api/mtr/fixture/1.1.1.1', '/api/ping', '/api/latency', '/api/measure', '/api/trace', '/api/live', '/api/stream', '/api/agents', '/socket.io/']) {
    const response = await fetch(f.base + route, { method: 'POST' });
    assert.equal(response.status, 404, route);
    assert.equal(await response.text(), 'Not found', route);
  }
  const control = await fetch(f.base + '/api/probes');
  assert.equal(control.status, 200, 'known API route remains reachable');
  await control.text();
  // MTR is a WebSocket message, never a REST command interpolation.
  for (const target of ['8.8.8.8;id', '127.0.0.1', '10.0.0.1', '::1', '8.8.8.8']) {
    const ws = new WebSocket(f.base.replace('http:', 'ws:'), { origin: f.base });
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MTR reply timed out')), 2000);
      ws.on('error', reject);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'mtr') { clearTimeout(timer); resolve(msg); }
      });
    });
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'mtr', ip: target, vantages: [] }));
    const reply = await result;
    if (target === '8.8.8.8') assert.equal(reply.start, true);
    else assert.match(reply.error, /refused|public IP/);
    ws.terminate();
  }
  assert.equal(f.calls.spawn.length, 1);
  assert.equal(f.calls.spawn[0].command, 'mtr');
  assert.deepEqual(Array.from(f.calls.spawn[0].args).slice(-2), ['--', '8.8.8.8']);
  assert.equal(f.calls.dns.length, 0);
});
