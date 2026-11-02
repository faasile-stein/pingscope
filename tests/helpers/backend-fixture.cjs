'use strict';
// Execute the real application with an isolated SQLite store and no external
// DNS, probe processes, startup loop, production configuration or credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

async function backendFixture(options = {}) {
  const root = path.resolve(__dirname, '../..');
  const realRequire = createRequire(path.join(root, 'server.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingscope-test-'));
  const calls = { spawn: [], dns: [] };
  const dns = {
    setServers() {},
    promises: Object.fromEntries(['resolve4', 'resolve6', 'resolveMx', 'reverse'].map((method) => [method, async (host) => {
      calls.dns.push({ method, host });
      return options.dns?.[method]?.(host) || [];
    }])),
  };
  const fakeSpawn = (command, args) => {
    calls.spawn.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    options.onSpawn?.(child, command, args);
    return child;
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'dns') return dns;
      if (name === 'child_process') return { spawn: fakeSpawn };
      return realRequire(name);
    },
    __dirname: root,
    process: { env: { DB_PATH: path.join(dir, 'fixture.db'), AGENT_TOKEN: 'local-test-token', ...options.env }, exit: (code) => { throw new Error(`unexpected exit ${code}`); } },
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, setTimeout, clearTimeout,
    setInterval: () => ({ unref() {} }), clearInterval() {},
  });
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = "main().catch((e) => { console.error('startup failed:', e); process.exit(1); });";
  if (!source.includes(start)) throw new Error('server startup marker changed; update isolated fixture');
  vm.runInContext(source.replace(start, ''), context, { filename: 'server.js' });
  const evaluate = (code) => vm.runInContext(code, context, { timeout: 5000 });
  const server = evaluate('server');
  const app = evaluate('app');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app, server, base, calls, context, evaluate,
    async close() {
      evaluate('for (const ws of [...wss.clients, ...ass.clients]) ws.terminate();');
      await new Promise((resolve) => server.close(resolve));
      await evaluate('historyReader.close()');
      evaluate('db.close()');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
module.exports = { backendFixture };
