'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

// Exercise the actual install RUN command with a fixture npm. An installation
// failure must stop the image build instead of re-resolving dependency ranges.
for (const file of ['Dockerfile', 'agent/Dockerfile']) {
  for (const ciStatus of [0, 1]) {
    test(`${file}: npm ci exit ${ciStatus} is preserved without an install fallback`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pingscope-npm-'));
      try {
        const dockerfile = fs.readFileSync(path.join(root, file), 'utf8').replace(/\\\n/g, ' ');
        const instruction = dockerfile.split('\n').find(line => /^RUN /.test(line) && /npm ci/.test(line));
        assert.ok(instruction, 'dependency install RUN instruction exists');
        const command = instruction.replace(/^RUN\s+(?:--mount=\S+\s+)?/, '');
        const log = path.join(dir, 'calls');
        fs.writeFileSync(path.join(dir, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$PINGSCOPE_NPM_LOG"\nif [ "$1" = ci ]; then exit "$PINGSCOPE_CI_STATUS"; fi\nexit 0\n', { mode: 0o755 });
        const result = spawnSync('/bin/sh', ['-c', command], {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PINGSCOPE_NPM_LOG: log, PINGSCOPE_CI_STATUS: String(ciStatus) },
          encoding: 'utf8',
        });
        assert.equal(result.status, ciStatus, result.stderr);
        assert.equal(fs.readFileSync(log, 'utf8'), 'ci\n');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

// Ranged dependency declarations must still resolve through a complete,
// matching integrity lockfile. Check a deliberately missing lock as a control.
test('the cited ws dependency is locked with version, registry URL and integrity', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  function isLocked(candidate) {
    const ws = candidate.packages?.['node_modules/ws'];
    return candidate.packages?.['']?.dependencies?.ws === manifest.dependencies.ws &&
      /^\d+\.\d+\.\d+$/.test(ws?.version) &&
      /^https:\/\/registry\.npmjs\.org\/ws\//.test(ws?.resolved) &&
      /^sha512-\S+$/.test(ws?.integrity);
  }
  assert.equal(isLocked(lock), true);
  const missing = structuredClone(lock);
  delete missing.packages['node_modules/ws'];
  assert.equal(isLocked(missing), false);
});

for (const file of ['Dockerfile', 'agent/Dockerfile']) {
  test(`${file}: base image includes immutable digest`, () => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const from = source.split('\n').filter(line => /^FROM /.test(line));
    const pinned = line => /^FROM node:[^\s@]+@sha256:[0-9a-f]{64}$/.test(line);
    assert.equal(from.length, 1);
    assert.equal(pinned(from[0]), true);
    assert.equal(pinned(from[0].replace(/@sha256:.*/, '')), false);
  });
}
