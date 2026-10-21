/**
 * The one network policy: three tries, 2 s then 5 s apart. CloudFront rate-limits the Octopus API (HTTP 429 with no
 * Retry-After after ~1,500 requests in 3 min at 8 in flight, lifting ~3 min later; seen 2026-10-21), so request starts
 * are spaced `intervalMs` apart and a 429 waits out `rateLimitDelays` before it fails.
 */
export const RETRY = {
  attempts: 3,
  delays: [2000, 5000],
  intervalMs: 250,
  rateLimitDelays: [60_000, 120_000, 300_000, 300_000, 600_000],
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let queue = Promise.resolve();
let lastStart = -Infinity;

/**
 * Resolves when the next request may start, at least `ms` after the previous start across every caller in the process.
 * Callers are released one at a time and each gap is measured from the actual previous release, so a stalled event
 * loop cannot let queued callers out in a burst.
 */
export function spaced(ms) {
  if (!ms) return Promise.resolve();
  queue = queue.then(async () => {
    const wait = lastStart + ms - performance.now();
    if (wait > 0) await sleep(wait);
    lastStart = performance.now();
  });
  return queue;
}

/** Runs fn; on failure waits delays[i] ms and retries, up to `attempts` tries; the last error propagates. */
export async function retry(fn, { attempts, delays }) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      await sleep(delays[i - 1] ?? delays.at(-1) ?? 0);
    }
  }
}

/** Returns `run(fn)` that runs at most `limit` async fns at once, queueing the rest; results and errors propagate. */
export function pool(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
