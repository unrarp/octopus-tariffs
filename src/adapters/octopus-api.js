import { RETRY, retry } from '../net.js';

const BASE = 'https://api.octopus.energy/v1';

/** GETs one URL as JSON through the shared retry policy; a non-2xx response throws (and is retried). */
async function getJson(url, { fetch = globalThis.fetch, retryOpts = RETRY } = {}) {
  return retry(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  }, retryOpts);
}

/** Follows `next` from `url`, returning every page's body in order. */
async function pages(url, opts) {
  const out = [];
  for (let next = url; next; ) {
    const body = await getJson(next, opts);
    out.push(body);
    next = body.next;
  }
  return out;
}

/** All product list rows (current, or with `historical` the retired ones). */
export async function listProducts({ historical = false, ...opts } = {}) {
  const url = `${BASE}/products/?page_size=200${historical ? '&is_historical=true' : ''}`;
  return (await pages(url, opts)).flatMap((p) => p.results);
}

/** The detail body of one product. */
export function productDetail(code, opts = {}) {
  return getJson(`${BASE}/products/${encodeURIComponent(code)}/`, opts);
}

/** Every row of a rate endpoint, oldest first (the API pages newest first, so pages and rows are both reversed). */
export async function rateRows(href, opts = {}) {
  const url = new URL(href);
  url.searchParams.set('page_size', '1500');
  const all = await pages(url.href, opts);
  return all.reverse().flatMap((p) => [...p.results].reverse());
}
