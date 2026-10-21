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
