import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { commitMessage, main } from '../src/routine.js';

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** A committed checkout with data/ and docs/ and a bare `origin`, as the routine finds its clone. Injected steps record their calls. */
function routineRepo({ stats = { products: 2, updated: 1, rows: 40 }, writes = true } = {}) {
  const root = tmp('routine-main-');
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [
    ['user.name', 't'],
    ['user.email', 't@t'],
    ['core.hooksPath', join(root, '.git', 'no-hooks')],
  ])
    git('config', k, v);
  for (const d of ['data', 'docs']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'data', 'a.csv'), 'x\n');
  writeFileSync(join(root, 'docs', 'index.html'), 'old\n');
  writeFileSync(join(root, 'other.txt'), 'o\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const remote = tmp('routine-origin-');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git('remote', 'add', 'origin', remote);
  const calls = [];
  const deps = {
    root,
    collect: async () => {
      calls.push('collect');
      if (writes) writeFileSync(join(root, 'data', 'a.csv'), 'x\ny\n');
      return stats;
    },
    build: async () => {
      calls.push('build');
      if (writes) writeFileSync(join(root, 'docs', 'index.html'), 'new\n');
    },
    check: () => {
      calls.push('check');
    },
    probe: async () => {
      calls.push('probe');
    },
    ping: async (suffix = '') => {
      calls.push(`ping${suffix}`);
    },
    now: () => new Date('2026-10-22T06:00:00.000Z'),
  };
  const origin = (...a) => execFileSync('git', ['--git-dir', remote, ...a], { encoding: 'utf8' }).trim();
  return { root, git, origin, calls, deps };
}
/** Silences console.log for the test; the returned function lists what was logged so far. */
const logs = (t) => {
  const m = t.mock.method(console, 'log', () => {});
  return () => m.mock.calls.map((c) => c.arguments[0]);
};

test('commitMessage counts new products, updated products and rows', () => {
  assert.equal(commitMessage({ products: 3, updated: 1, rows: 120 }), 'data: +3 products, 1 updated, +120 rows');
  assert.equal(commitMessage({ products: 0, updated: 0, rows: 0 }), 'data: +0 products, 0 updated, +0 rows');
});

test('unchanged: prints RESULT unchanged, makes no commit, pings', async (t) => {
  const r = routineRepo({ writes: false });
  const out = logs(t);
  const head = r.git('rev-parse', 'HEAD');
  assert.equal(await main([], r.deps), 0);
  assert.deepEqual(r.calls, ['collect', 'build', 'check', 'ping']);
  assert.equal(out().at(-1), 'RESULT unchanged');
  assert.equal(r.git('rev-parse', 'HEAD'), head);
  assert.equal(r.origin('branch', '--list'), '');
});

test('changed: commits data and docs only, pushes HEAD:master from another branch, pings', async (t) => {
  const r = routineRepo();
  writeFileSync(join(r.root, 'other.txt'), 'dirty\n');
  r.git('add', 'other.txt'); // staged, but outside data/ and docs/: never committed
  const out = logs(t);
  assert.equal(await main([], r.deps), 0);
  assert.deepEqual(r.calls, ['collect', 'build', 'check', 'ping']);
  const sha = r.git('rev-parse', 'HEAD');
  assert.equal(r.origin('rev-parse', 'master'), sha);
  assert.equal(r.origin('log', '-1', '--format=%s', 'master'), 'data: +2 products, 1 updated, +40 rows');
  assert.deepEqual(r.git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [
    'data/a.csv',
    'docs/index.html',
  ]);
  assert.equal(out().at(-1), `RESULT committed ${sha}`);
});

test('probe: commits only .routine-probe, pushes, pings, runs no collection', async (t) => {
  const r = routineRepo();
  writeFileSync(join(r.root, 'other.txt'), 'dirty\n');
  r.git('add', 'other.txt'); // staged but not the probe's: must stay out of its commit
  const out = logs(t);
  assert.equal(await main(['--probe'], r.deps), 0);
  assert.deepEqual(r.calls, ['ping/start', 'probe', 'ping']);
  const sha = r.git('rev-parse', 'HEAD');
  assert.equal(r.origin('rev-parse', 'master'), sha);
  assert.equal(r.git('show', '--name-only', '--format=', 'HEAD'), '.routine-probe');
  assert.equal(readFileSync(join(r.root, '.routine-probe'), 'utf8'), '2026-10-22T06:00:00.000Z\n');
  assert.equal(out().at(-1), `RESULT probe ${sha}`);
});

test('an error pings /fail, not success, and nothing is pushed', async (t) => {
  const r = routineRepo();
  logs(t);
  const check = () => {
    throw Object.assign(new Error('exit 1'), { stdout: 'not ok 1 - x\n', stderr: '' });
  };
  await assert.rejects(main([], { ...r.deps, check }), /^Error: check:core failed\nnot ok 1 - x/);
  assert.deepEqual(r.calls, ['collect', 'build', 'ping/fail']);
  assert.equal(r.origin('branch', '--list'), '');
});

test('probe without HEALTHCHECK_URL fails before pushing anything', async (t) => {
  const r = routineRepo();
  logs(t);
  t.mock.method(console, 'error', () => {});
  const saved = process.env.HEALTHCHECK_URL;
  delete process.env.HEALTHCHECK_URL;
  try {
    const { ping: _, ...deps } = r.deps; // the real ping
    await assert.rejects(main(['--probe'], deps), /HEALTHCHECK_URL/);
    assert.equal(r.origin('branch', '--list'), '');
  } finally {
    if (saved !== undefined) process.env.HEALTHCHECK_URL = saved;
  }
});
