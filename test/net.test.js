import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool, RETRY, retry, spaced } from '../src/net.js';

const opts = { attempts: 3, delays: [1, 1] };

test('retry returns the first success after transient failures', async () => {
  let calls = 0;
  const v = await retry(async () => {
    if (++calls < 3) throw new Error('flaky');
    return 'ok';
  }, opts);
  assert.equal(v, 'ok');
  assert.equal(calls, 3);
});

test('retry rethrows the last error after `attempts` tries', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => {
      throw new Error(`fail ${++calls}`);
    }, opts),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test('the retry policy waits 2 s, then 5 s, before giving up after three tries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const done = retry(async () => {
    calls++;
    throw new Error('down');
  }, RETRY).catch((e) => e);
  const settle = () => new Promise((r) => setImmediate(r)); // let the rejected try schedule its wait
  const after = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
    return calls;
  };
  await settle();
  assert.equal(calls, 1);
  assert.equal(await after(1999), 1);
  assert.equal(await after(1), 2);
  assert.equal(await after(4999), 2);
  assert.equal(await after(1), 3);
  assert.match((await done).message, /down/);
});

test('pool never runs more than `limit` fns at once and returns each result', async () => {
  const run = pool(3);
  let inFlight = 0;
  let peak = 0;
  const task = (i) =>
    run(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i * 2;
    });
  const out = await Promise.all([...Array(10).keys()].map(task));
  assert.deepEqual(out, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  assert.equal(peak, 3);
});

test('pool propagates an error and keeps serving the queue', async () => {
  const run = pool(1);
  const bad = run(async () => {
    throw new Error('boom');
  });
  const good = run(async () => 'fine');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'fine');
});

test('pool frees the slot when a fn throws synchronously', async () => {
  const run = pool(1);
  const bad = run(() => {
    throw new Error('sync');
  });
  const good = run(async () => 'fine');
  await assert.rejects(bad, /sync/);
  assert.equal(await good, 'fine');
});

test('spaced keeps the gap after the event loop stalls, instead of releasing a burst', async () => {
  const starts = [];
  const jobs = [1, 2, 3, 4].map(async () => {
    await spaced(50);
    starts.push(performance.now());
  });
  await new Promise((r) => setTimeout(r, 5));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); // block the loop past every reserved slot
  await Promise.all(jobs);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  assert.ok(
    gaps.every((g) => g >= 45),
    `gaps ${gaps}`,
  );
});

test('RETRY spaces requests 250 ms apart and waits 1, 2, 5, 5, 10 min on a 429', () => {
  assert.equal(RETRY.intervalMs, 250);
  assert.deepEqual(RETRY.rateLimitDelays, [60_000, 120_000, 300_000, 300_000, 600_000]);
});
