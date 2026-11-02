'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { backendFixture } = require('./helpers/backend-fixture.cjs');

const asJson = (value) => JSON.parse(JSON.stringify(value));

test('rankings normalize fractional pagination before SQLite, preserving integer controls and existing clamps', async (t) => {
  const fixture = await backendFixture();
  t.after(() => fixture.close());
  fixture.evaluate(`for (let i = 0; i < 12; i++) persistSov({ domain: 'fixture-' + i + '.example', web: { score: i }, mail: null });`);
  const read = async (query) => {
    const response = await fetch(`${fixture.base}/api/rankings${query}`);
    assert.equal(response.status, 200, query);
    assert.match(response.headers.get('content-type'), /application\/json/);
    return response.json();
  };
  const control = await read('?page=1&per=5');
  assert.equal(control.rankings.length, 5);
  assert.deepEqual(await read('?page=1.9&per=5'), control);
  assert.deepEqual(await read('?page=1&per=5.5'), control);
  const secondPage = await read('?page=2.9&per=5.5');
  assert.equal(secondPage.page, 2);
  assert.equal(secondPage.per, 5);
  assert.equal(secondPage.rankings[0].rank, 6);
  for (const query of ['?page=-1&per=-1', '?page=0&per=0', '?page=NaN&per=NaN', '?page=9223372036854775807&per=5000', '?page=Infinity&per=Infinity', '?page=1&page=2&per=5&per=6', '?page=0.1&per=0.1']) {
    const data = await read(query);
    assert.ok(Number.isInteger(data.per) && data.per >= 1 && data.per <= 200, query);
    assert.ok(Number.isInteger(data.page) && data.page >= 1 && data.page <= data.pages, query);
  }
  assert.deepEqual(await read('?page=1&per=5'), control, 'valid requests still work after hostile inputs');
  assert.deepEqual(fixture.calls, { spawn: [], dns: [] });
});

test('metadata, loopback and RFC1918 wildcard domains with no public endpoint are refused before traces or persistence', async (t) => {
  const addresses = {
    '169.254.169.254.nip.io': '169.254.169.254',
    '169.254.169.254.sslip.io': '169.254.169.254',
    '10.99.99.99.sslip.io': '10.99.99.99',
    '127.0.0.1.nip.io': '127.0.0.1',
    '127.0.0.1.sslip.io': '127.0.0.1',
    '192.168.1.1.sslip.io': '192.168.1.1',
    '10-0-0-1.sslip.io': '10.0.0.1',
    '10.0.0.1.sslip.io': '10.0.0.1',
    '172.16.0.1.sslip.io': '172.16.0.1',
  };
  const fixture = await backendFixture({ env: { RATE_MS: '0' }, dns: {
    resolve4: (host) => addresses[host] ? [addresses[host]] : [],
  } });
  t.after(() => fixture.close());
  fixture.context.replies = [];
  for (const host of Object.keys(addresses)) {
    const response = await fetch(`${fixture.base}/api/sovereignty?url=${host}`);
    assert.equal(response.status, 404, host);
    assert.match((await response.json()).error, /could not resolve web or mail servers/);
    fixture.context.host = host;
    await fixture.evaluate("startSovScan({ readyState: 1, send: (raw) => replies.push(JSON.parse(raw)) }, { ip: '127.0.0.1' }, host)");
    assert.equal(fixture.context.replies.at(-1).phase, 'error', host);
    assert.match(fixture.context.replies.at(-1).error, /could not resolve web or mail servers/);
  }
  assert.equal(fixture.evaluate('sovCountStmt.get().c'), 0);
  assert.equal(fixture.evaluate('sovCache.size'), 0);
  assert.deepEqual(fixture.calls.spawn, [], 'private targets never reach the probe process');
  const ranking = await (await fetch(`${fixture.base}/api/rankings`)).json();
  assert.equal(ranking.total, 0);
  for (const value of ['169.254.169.254', '<script>.com', 'a'.repeat(254) + '.com']) {
    fixture.context.input = value;
    assert.equal(fixture.evaluate('parseSiteHost(input)'), null, value.slice(0, 40));
  }
});

test('a private web answer with a public apex mail server stores only the public mail measurement', async (t) => {
  const host = '169.254.169.254.nip.io';
  const fixture = await backendFixture({ env: { RATE_MS: '0' }, dns: {
    resolve4: (name) => name === host ? ['169.254.169.254'] : name === 'mx.fixture.example' ? ['8.8.8.8'] : name === 'public.example' ? ['1.1.1.1'] : [],
    resolveMx: (name) => name === 'nip.io' ? [{ priority: 10, exchange: 'mx.fixture.example' }] : [],
  } });
  t.after(() => fixture.close());
  // Stub only the already-validated probe sink; exercise actual DNS filtering,
  // API handlers, score construction, cache, SQLite writes and leaderboard reads.
  fixture.context.traced = [];
  fixture.context.replies = [];
  fixture.evaluate("traceOnce = async (ip) => { traced.push(ip); return { ip, hops: [] }; }; traceStream = async (ip) => { traced.push(ip); return []; };");
  const response = await fetch(`${fixture.base}/api/sovereignty?url=${host}`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.mailDomain, 'nip.io', 'API explains that mail belongs to the registrable apex');
  assert.deepEqual(data.web.servers, []);
  assert.deepEqual(data.mail.servers.map((server) => server.ip), ['8.8.8.8']);
  fixture.context.host = host;
  await fixture.evaluate("startSovScan({ readyState: 1, send: (raw) => replies.push(JSON.parse(raw)) }, { ip: '127.0.0.1' }, host)");
  const final = fixture.context.replies.at(-1);
  assert.equal(final.phase, 'done');
  assert.equal(final.web, null);
  assert.deepEqual(asJson(final.mail.servers.map((server) => server.ip)), ['8.8.8.8']);
  assert.deepEqual(fixture.context.traced, ['8.8.8.8', '8.8.8.8']);
  const control = await fetch(`${fixture.base}/api/sovereignty?url=public.example`);
  assert.equal(control.status, 200);
  assert.deepEqual((await control.json()).web.servers.map((server) => server.ip), ['1.1.1.1']);
  const ranking = await (await fetch(`${fixture.base}/api/rankings`)).json();
  assert.equal(ranking.total, 2);
  assert.deepEqual(ranking.rankings.map((row) => row.domain).sort(), [host, 'public.example'].sort());
  const stored = JSON.parse(fixture.evaluate("db.prepare('SELECT data FROM sov_scores WHERE domain = ?').get(host).data"));
  assert.equal(stored.web, null);
  assert.equal(stored.mailDomain, 'nip.io');
  assert.deepEqual(stored.mail.servers.map((server) => server.ip), ['8.8.8.8']);
  assert.deepEqual(fixture.calls.spawn, [], 'all probe sinks stayed local fixtures');
});
