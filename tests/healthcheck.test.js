'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
function healthCommand(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const match = source.match(/^HEALTHCHECK\s+.*?CMD\s+(\[.*\])$/m);
  assert.ok(match, `${file} must declare an executable health check`);
  const command = JSON.parse(match[1]);
  assert.equal(command[0], 'node');
  return command.slice(1);
}
function runCheck(file, env = {}) {
  const args = healthCommand(file);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.dirname(path.join(root, file)), env: { ...process.env, ...env }, stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('exit', resolve);
  });
}

test('server container health check distinguishes responsive API, server error and refused connection', async () => {
  let status = 200;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { PORT: String(server.address().port) };
  try {
    assert.equal(await runCheck('Dockerfile', env), 0);
    status = 503;
    assert.equal(await runCheck('Dockerfile', env), 1);
    assert.deepEqual(requests, ['/api/probes', '/api/probes']);
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(await runCheck('Dockerfile', env), 1);
});

test('agent container health check requires a fresh registration heartbeat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingscope-agent-health-'));
  const file = path.join(dir, 'pingscope-agent-health');
  const env = { TMPDIR: dir };
  try {
    assert.equal(await runCheck('agent/Dockerfile', env), 1, 'no registered session');
    fs.writeFileSync(file, String(Date.now()));
    assert.equal(await runCheck('agent/Dockerfile', env), 0, 'fresh registered heartbeat');
    fs.writeFileSync(file, String(Date.now() - 90_000));
    assert.equal(await runCheck('agent/Dockerfile', env), 1, 'stale session');
    fs.writeFileSync(file, 'not-a-time');
    assert.equal(await runCheck('agent/Dockerfile', env), 1, 'invalid health marker');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent only records health after welcome/pong and clears it on rejection/disconnect', () => {
  const connections = [];
  const marks = [];
  class FakeWebSocket extends EventEmitter {
    constructor() { super(); this.readyState = 1; connections.push(this); }
    send() {}
    ping() {}
    close() {}
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'agent/agent.js'), 'utf8'), {
    require(name) {
      if (name === 'ws') return FakeWebSocket;
      if (name === './healthcheck') return {
        markHealthy: () => marks.push('healthy'), clearHealth: () => marks.push('clear'),
      };
      if (name === 'child_process') return { spawn() { throw new Error('unexpected probe'); } };
      return require(name);
    },
    process: { env: { PINGSCOPE_URL: 'ws://127.0.0.1/agent', AGENT_TOKEN: 'local-fixture' } },
    console: { log() {}, error() {} },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
  }, { filename: 'agent.js' });
  const ws = connections[0];
  assert.deepEqual(marks, ['clear'], 'startup clears a stale health file');
  ws.emit('open');
  ws.emit('pong');
  assert.deepEqual(marks, ['clear'], 'connection/pong before registration is not healthy');
  ws.emit('message', JSON.stringify({ type: 'welcome', id: 'fixture' }));
  ws.emit('pong');
  assert.deepEqual(marks, ['clear', 'healthy', 'healthy']);
  ws.emit('message', JSON.stringify({ type: 'reject', reason: 'fixture rejection' }));
  ws.emit('pong');
  assert.deepEqual(marks, ['clear', 'healthy', 'healthy', 'clear']);
  ws.emit('close');
  assert.equal(marks.at(-1), 'clear');
});
