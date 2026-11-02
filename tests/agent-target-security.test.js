'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');

function agentFixture() {
  const calls = [], messages = [], connections = [];
  class LocalWebSocket extends EventEmitter {
    constructor() { super(); this.readyState = 1; connections.push(this); }
    send(raw) { messages.push(JSON.parse(raw)); }
    ping() {}
    close() {}
  }
  const context = vm.createContext({
    require(name) {
      if (name === 'ws') return LocalWebSocket;
      if (name === './healthcheck') return { markHealthy() {}, clearHealth() {} };
      if (name === 'child_process') return { spawn(command, args) {
        calls.push({ command, args: Array.from(args) });
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => true;
        return child;
      } };
      return require(name);
    },
    URL,
    process: { env: { AGENT_TOKEN: 'local-fixture', PINGSCOPE_URL: 'ws://127.0.0.1/agent' } },
    console: { log() {}, error() {} },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    testWs: { readyState: 1, send: (raw) => messages.push(JSON.parse(raw)) },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../agent/agent.js'), 'utf8'), context);
  return { calls, messages, connections, run(target) {
    context.target = target;
    vm.runInContext("runMtr(testWs, 'fixture-request', target)", context);
  } };
}

test('agent refuses private targets including equivalent embedded and expanded IPv6 forms before spawn', () => {
  for (const target of ['10.0.0.1', '169.254.169.254', '127.0.0.1', '::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1',
    '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', 'fc00::1', 'fe80::1',
    'example.test', '8.8.8.8;id', null, {}]) {
    const f = agentFixture();
    f.run(target);
    assert.equal(f.calls.length, 0, JSON.stringify(target));
    assert.equal(f.messages[0].error, 'invalid/!public target');
  }
});

test('agent retains public IPv4, IPv6 and mapped-public argument-array controls', () => {
  for (const target of ['8.8.8.8', '2001:4860:4860::8888', '2001:4860:4860:0:0:0:0:8888',
    '::ffff:8.8.8.8', '::ffff:0808:0808', '0:0:0:0:0:ffff:0808:0808']) {
    const f = agentFixture();
    f.run(target);
    assert.equal(f.calls.length, 1, target);
    assert.equal(f.calls[0].command, 'mtr');
    assert.deepEqual(f.calls[0].args.slice(-2), ['--', target]);
    assert.equal(f.messages.length, 0);
  }
});

test('standalone agent ignores non-object frames and continues handling valid commands', () => {
  const f = agentFixture();
  const ws = f.connections[0];
  for (const raw of ['null', '[]', 'true', '42', '"text"']) {
    assert.doesNotThrow(() => ws.emit('message', Buffer.from(raw)), raw);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.messages.length, 0);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'mtr', reqId: 'refused', target: '127.0.0.1' })));
  assert.equal(f.messages[0].error, 'invalid/!public target');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'mtr', reqId: 'allowed', target: '8.8.8.8' })));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args.slice(-2), ['--', '8.8.8.8']);
});
