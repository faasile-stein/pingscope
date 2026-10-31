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
