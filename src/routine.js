import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productDetail } from './adapters/octopus-api.js';
import { build } from './build.js';
import { collect } from './collect.js';
import { RETRY, retry } from './net.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** A product that has existed since 2022, so the connectivity probe always has something to fetch. */
const push = (run) => run('git', ['push', 'origin', 'HEAD:master']);
const PROBE_PRODUCT = 'VAR-22-11-01';

/**
 * The data commit's subject from collect's counts: new product files, rewritten ones, appended rate rows. The built
 * series gain a day on every run, so a day with no collected change still commits, as a refresh.
 */
export function commitMessage({ products, updated, rows }) {
  if (!products && !updated && !rows) return 'data: daily refresh';
  return `data: +${products} products, ${updated} updated, +${rows} rows`;
}

/** Pings HEALTHCHECK_URL + suffix; without the URL it logs and skips, unless `required` (the probe must prove the host). */
async function ping(suffix = '', required = false) {
  const url = process.env.HEALTHCHECK_URL;
  if (!url && required) throw new Error('HEALTHCHECK_URL is not set; the probe must reach the healthcheck host');
  if (!url) return console.log('HEALTHCHECK_URL not set; skipping ping');
  await retry(async () => {
    const res = await fetch(url + suffix, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`healthcheck ping: HTTP ${res.status}`);
  }, RETRY);
}

/**
 * One routine run in the checkout at `root`; returns the exit code. The run starts from a fresh clone, so nothing
 * here relies on state from an earlier run. Every step is injectable for tests; a failure pings /fail and rethrows.
 */
export async function main(argv, deps = {}) {
  const {
    root = ROOT,
    run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    collect: collectAll = () => collect({ root }),
    build: buildSite = () => build({ root }),
    check = () => run('npm', ['run', 'check:core']),
    probe = () => productDetail(PROBE_PRODUCT),
    ping: notify = ping,
    now = () => new Date(),
  } = deps;
  try {
    if (argv.includes('--probe')) {
      await notify('/start', true); // the monitor host first, before anything is pushed
      await probe();
      writeFileSync(join(root, '.routine-probe'), `${now().toISOString()}\n`);
      run('git', ['add', '.routine-probe']);
      run('git', ['commit', '-m', 'chore: routine probe', '--', '.routine-probe']);
      push(run);
      const sha = run('git', ['rev-parse', 'HEAD']).trim();
      await notify();
      console.log(`RESULT probe ${sha}`);
      return 0;
    }

    // The routine session runs this script as one Bash command: 10 minutes in the foreground, then up to 30 more in
    // the background before it is killed, so a run must finish inside 40 minutes (the first run took 30).
    const stats = await collectAll();
    await buildSite();
    try {
      check();
    } catch (e) {
      throw new Error(`check:core failed\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
    if (!run('git', ['status', '--porcelain', '--', 'data', 'docs']).trim()) {
      console.log('RESULT unchanged');
      await notify();
      return 0;
    }
    run('git', ['add', 'data', 'docs']);
    run('git', ['commit', '-m', commitMessage(stats), '--', 'data', 'docs']);
    // Routine sessions run on a claude/… branch with no local master, so name the source.
    // The stray-branch push the session's stop hook asks for is declined in ROUTINE.md, not here.
    push(run);
    const sha = run('git', ['rev-parse', 'HEAD']).trim();
    console.log(`RESULT committed ${sha}`);
    await notify();
    return 0;
  } catch (e) {
    try {
      await notify('/fail');
    } catch (pe) {
      console.error(`fail ping: ${pe.message}`);
    }
    throw e;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
