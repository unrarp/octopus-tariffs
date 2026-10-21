/** The one retry policy for network work: three tries, 2 s then 5 s apart. */
export const RETRY = { attempts: 3, delays: [2000, 5000] };

/** Runs fn; on failure waits delays[i] ms and retries, up to `attempts` tries; the last error propagates. */
export async function retry(fn, { attempts, delays }) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, delays[i - 1] ?? delays.at(-1) ?? 0));
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
