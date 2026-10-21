import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RETRY, retry } from '../src/net.js';

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
