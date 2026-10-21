import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCsv } from './csv.js';
import { endpointsOf } from './families.js';

/** The series modules that exist (PLAN.md §4.3); adding a series means adding its name here and its module under src/series/. */
export const KNOWN_SERIES = ['stepped'];

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FORBIDDEN_KEYS = ['links', 'tariffs_active_at'];

/** Pushes failure messages for an invalid family config (PLAN.md §3), plus the compiled matchers of the valid ones. */
function checkConfig(config, failures) {
  const matchers = [];
  const ids = new Set();
  for (const f of config.families ?? []) {
    if (ids.has(f.id)) failures.push(`family id ${JSON.stringify(f.id)} is repeated`);
    ids.add(f.id);
    if (typeof f.match !== 'string') {
      failures.push(`family ${f.id}: match ${f.match} is not a string`);
      continue;
    }
    if (!KNOWN_SERIES.includes(f.series)) {
      failures.push(`family ${f.id}: unknown series ${JSON.stringify(f.series)} (known: ${KNOWN_SERIES.join(', ')})`);
    }
    if (!KEBAB.test(f.id ?? '')) failures.push(`family id ${JSON.stringify(f.id)} is not kebab-case`);
    try {
      matchers.push({ id: f.id, re: new RegExp(f.match) });
    } catch {
      failures.push(`family ${f.id}: match ${JSON.stringify(f.match)} is not a valid regex`);
    }
  }
  return matchers;
}

/** The first path (dotted) at which an object or array holds a forbidden key, else null. */
function forbiddenKey(value, path = '') {
  if (value === null || typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    const here = path ? `${path}.${k}` : k;
    if (!Array.isArray(value) && FORBIDDEN_KEYS.includes(k)) return here;
    const found = forbiddenKey(v, here);
    if (found) return found;
  }
  return null;
}

/** Failure messages for one CSV's rows (key uniqueness, order, open rows) and whether it is empty. */
function checkRows(rows, label, failures) {
  const seen = new Set();
  const byMethod = new Map(); // payment_method -> {last: ms of previous valid_from, count, open}
  for (const r of rows) {
    const key = JSON.stringify([r.valid_from, r.payment_method]);
    if (seen.has(key)) failures.push(`${label}: duplicate key ${key}`);
    seen.add(key);
    const s = byMethod.get(r.payment_method) ?? { last: null, count: 0, open: 0 };
    byMethod.set(r.payment_method, s);
    if (r.valid_from == null) {
      if (s.count > 0)
        failures.push(`${label}: empty valid_from after the first row of payment method ${r.payment_method}`);
    } else {
      const ms = Date.parse(r.valid_from);
      if (s.last !== null && ms < s.last)
        failures.push(`${label}: rows not oldest first at ${r.valid_from} (${r.payment_method})`);
      s.last = ms;
    }
    if (r.valid_to == null && ++s.open === 2) {
      failures.push(`${label}: more than one open row (empty valid_to) for payment method ${r.payment_method}`);
    }
    s.count++;
  }
}

/** Validates families.json and the data tree (PLAN.md §3, §4.1); returns {failures, warnings} message lists. */
export function validate({ root, dataRoot = join(root, 'data') }) {
  const failures = [];
  const warnings = [];
  const config = JSON.parse(readFileSync(join(root, 'families.json'), 'utf8'));
  const matchers = checkConfig(config, failures);
  const productsDir = join(dataRoot, 'products');
  if (!existsSync(productsDir)) {
    failures.push(`${productsDir} is missing: run npm run collect to backfill data/ first`);
    return { failures, warnings };
  }
  const regionKeys = Object.keys(config.regions);
  const skipRates = config.log.skipRateHistory.map((p) => new RegExp(p));
  const sold = new Set(); // `${familyId}|${region}` for every family × region with a stored tariff

  for (const file of readdirSync(productsDir).filter((n) => n.endsWith('.json'))) {
    const code = file.slice(0, -'.json'.length);
    let detail;
    try {
      detail = JSON.parse(readFileSync(join(productsDir, file), 'utf8'));
    } catch (e) {
      failures.push(`products/${file}: unreadable: ${e.message}`);
      continue;
    }
    const bad = forbiddenKey(detail);
    if (bad) failures.push(`products/${file}: forbidden key ${bad}`);

    const owners = matchers.filter((m) => m.re.test(code)).map((m) => m.id);
    if (owners.length > 1) failures.push(`product ${code} is matched by more than one family: ${owners.join(', ')}`);

    const endpoints = endpointsOf(detail, regionKeys);
    for (const id of owners) for (const ep of endpoints) sold.add(`${id}|${ep.region}`);

    if (skipRates.some((re) => re.test(code))) continue;
    for (const ep of endpoints) {
      const label = `rates/${ep.tariffCode}/${ep.rel}.csv`;
      let rows;
      try {
        rows = readCsv(join(dataRoot, label));
      } catch (e) {
        failures.push(e.code === 'ENOENT' ? `${label}: missing (product ${code})` : e.message);
        continue;
      }
      if (rows.length === 0) warnings.push(`${label}: no rows`);
      checkRows(rows, label, failures);
    }
  }

  // Judged from the directory names, so a tariff that has since left its product's detail is still caught.
  const ratesDir = join(dataRoot, 'rates');
  for (const tariff of existsSync(ratesDir) ? readdirSync(ratesDir) : []) {
    const code = tariff.replace(/^[EG]-\dR-/, '').replace(/-[A-Z]$/, '');
    if (skipRates.some((re) => re.test(code))) {
      failures.push(`product ${code} skips rate history but rates/${tariff} exists`);
    }
  }

  for (const f of config.families ?? []) {
    for (const region of regionKeys) {
      if (!sold.has(`${f.id}|${region}`)) warnings.push(`family ${f.id} has no stored tariff in region ${region}`);
    }
  }
  return { failures, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { failures, warnings } = validate({ root });
  for (const w of warnings) console.log(`warn: ${w}`);
  for (const f of failures) console.log(`fail: ${f}`);
  console.log(`check:data: ${failures.length} failures, ${warnings.length} warnings`);
  process.exitCode = failures.length ? 1 : 0;
}
