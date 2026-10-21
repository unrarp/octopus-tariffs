import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listProducts, productDetail, rateRows } from './adapters/octopus-api.js';
import { appendCsv, readCsv, rewriteRow } from './csv.js';
import { ukDay } from './days.js';
import { checkLinks, endpointsOf, inTerm } from './families.js';
import { pool } from './net.js';

const IN_FLIGHT = 8;
const PROGRESS_EVERY = 500;

/** A deep copy with object keys sorted, every `links` array dropped and `tariffs_active_at` dropped at the top. */
function strip(value, top = true) {
  if (Array.isArray(value)) return value.map((v) => strip(v, false));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((k) => !(k === 'links' && Array.isArray(value[k])) && !(top && k === 'tariffs_active_at'))
      .map((k) => [k, strip(value[k], false)]),
  );
}

const serialise = (body) => `${JSON.stringify(body, null, 2)}\n`;

/** Writes `text` to `path` (creating its directory) via a temp file and rename. */
function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** The key a rate row is stored under. */
const keyOf = (r) => ({ valid_from: r.valid_from ?? null, payment_method: r.payment_method ?? null });
const idOf = (r) => JSON.stringify(keyOf(r));

/** Merges one endpoint's API rows (oldest first) into its CSV; returns the rows appended and whether it was created empty. */
function merge(path, api) {
  const exists = existsSync(path);
  const stored = exists ? readCsv(path) : [];
  const open = new Map(stored.map((r) => [idOf(r), r.valid_to == null]));
  const added = [];
  for (const r of api) {
    const id = idOf(r);
    if (!open.has(id)) added.push(r);
    else if (open.get(id) && r.valid_to != null) {
      rewriteRow(path, keyOf(r), r);
      open.set(id, false);
    }
  }
  if (added.length || !exists) appendCsv(path, added);
  return { rows: added.length, empty: !exists && api.length === 0 };
}

/**
 * Collects product files and rate CSVs into dataRoot (see PLAN.md §4.1). Returns and logs the summary counts.
 * Throws after in-flight work finishes when any request failed; a rerun resumes.
 */
export async function collect({
  root,
  dataRoot = join(root, 'data'),
  fetch,
  retryOpts,
  now = new Date().toISOString(),
  log = console.log,
}) {
  const config = JSON.parse(readFileSync(join(root, 'families.json'), 'utf8'));
  const opts = { fetch, retryOpts };
  const today = ukDay(now);
  const regionKeys = Object.keys(config.regions);
  const skipRates = config.log.skipRateHistory.map((p) => new RegExp(p));
  const productPath = (code) => join(dataRoot, 'products', `${code}.json`);

  const listed = (await Promise.all([listProducts(opts), listProducts({ ...opts, historical: true })])).flat();
  const byCode = new Map();
  for (const p of listed) if (config.log.brands.includes(p.brand)) byCode.set(p.code, p);
  const products = [...byCode.values()];

  const run = pool(IN_FLIGHT);
  let failure = null;
  const guarded = (fn) =>
    run(async () => {
      if (failure) return;
      try {
        await fn();
      } catch (e) {
        failure ??= e;
      }
    });

  const stats = { products: 0, updated: 0, rows: 0, skipped: 0, empty: 0 };
  const fetched = new Set(); // codes whose detail was fetched this run: their rate endpoints are refetched too
  // A retiring product's file is written only after its rates are refetched, so a failed run leaves the retirement
  // unrecorded and the next run redoes it rather than skipping the product's open rows for good.
  const deferred = [];

  await Promise.all(
    products.map((product) =>
      guarded(async () => {
        const path = productPath(product.code);
        const stored = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
        // A list row whose available_to differs from the file's is a retirement the file has not seen yet.
        if (stored && !inTerm(product, today) && (product.available_to ?? null) === (stored.available_to ?? null))
          return;
        const detail = await productDetail(product.code, opts);
        checkLinks(detail);
        fetched.add(product.code);
        const body = strip(detail);
        const { fetchedAt: _, ...old } = stored ?? {};
        if (stored && serialise(old) === serialise(body)) return;
        const write = () => writeText(path, serialise(strip({ ...body, fetchedAt: now })));
        if (!stored) {
          write();
          stats.products++;
        } else if (inTerm(product, today)) {
          write();
          stats.updated++;
        } else deferred.push(write);
      }),
    ),
  );
  if (failure) throw failure;

  const endpointsFor = (product) => {
    if (skipRates.some((re) => re.test(product.code))) return [];
    return endpointsOf(JSON.parse(readFileSync(productPath(product.code), 'utf8')), regionKeys);
  };
  // Every endpoint goes through the one pool, so products with few endpoints still keep IN_FLIGHT requests busy.
  const endpoints = products.flatMap((p) => endpointsFor(p).map((ep) => ({ ep, live: fetched.has(p.code) })));
  let done = 0;
  await Promise.all(
    endpoints.map(({ ep, live }) =>
      guarded(async () => {
        const path = join(dataRoot, 'rates', ep.tariffCode, `${ep.rel}.csv`);
        if (!live && existsSync(path)) stats.skipped++;
        else {
          const { rows, empty } = merge(path, await rateRows(ep.href, opts));
          stats.rows += rows;
          if (empty) stats.empty++;
        }
        if (++done % PROGRESS_EVERY === 0) console.error(`collect: ${done}/${endpoints.length} endpoints`);
      }),
    ),
  );
  if (failure) throw failure;
  for (const write of deferred) write();
  stats.updated += deferred.length;

  log(
    `collected products=${stats.products} updated=${stats.updated} rows=${stats.rows} skipped=${stats.skipped} empty=${stats.empty}`,
  );
  return stats;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await collect({ root: join(dirname(fileURLToPath(import.meta.url)), '..') });
}
