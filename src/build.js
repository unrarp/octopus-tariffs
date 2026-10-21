import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCsv } from './csv.js';
import { addDays, addMonths, dayRange, ukDay } from './days.js';
import { familyOf, MAPS } from './families.js';
import { TDCV } from './site/lib/cost.js';
import { incVat } from './vat.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FUELS = ['electricity', 'gas'];
/** The map a fuel's tariff is read from: the first MAPS entry for it (single register). */
const mapOf = (fuel) => Object.keys(MAPS).find((m) => MAPS[m] === fuel);
/** Payment keys by family kind, first match wins: stored Flexible products before VAR-22-11-01 key `direct_debit_monthly`, later ones `varying`. */
const PAYMENT_KEYS = { fixed: ['direct_debit_monthly'], variable: ['direct_debit_monthly', 'varying'] };
/** The earliest day a comparison can start (the Energy Price Guarantee ends before it); older versions get no own series. */
const SINCE = '2023-07-01';
/** Stamped in dependency order: each file's import specifiers carry the hashes of the files before it. */
const STAMPED = ['lib/profile.js', 'lib/cost.js', 'lib/compare.js', 'app.js'];
const IMPORT = /(from\s+)'(\.{1,2}\/(?:[\w-]+\/)*[\w-]+\.js)'/g;

const hashOf = (content) => createHash('sha256').update(content).digest('hex').slice(0, 8);

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const json = (path, value) => write(path, `${JSON.stringify(value)}\n`);

/** Every rendered family's versions, oldest first (ties by code), with the stored detail: [{code, detail, fullName, availableFrom, availableTo, term}]. */
function versionsByFamily(dataRoot, families) {
  const byFamily = new Map(families.map((f) => [f.id, []]));
  const dir = join(dataRoot, 'products');
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const detail = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const family = familyOf(detail.code, families);
    if (!family) continue;
    byFamily.get(family.id).push({
      code: detail.code,
      detail,
      fullName: detail.full_name,
      availableFrom: ukDay(detail.available_from),
      availableTo: detail.available_to ? ukDay(detail.available_to) : null,
      term: detail.term ?? null,
    });
  }
  for (const list of byFamily.values())
    list.sort((a, b) => a.availableFrom.localeCompare(b.availableFrom) || a.code.localeCompare(b.code));
  return byFamily;
}

/** The sale window [from, to) of each version: until the earlier of its available_to and the next version's available_from, or `end`. */
function windowsOf(versions, end) {
  return versions.map((v, i) => ({
    from: v.availableFrom,
    to: [end, v.availableTo, versions[i + 1]?.availableFrom].filter(Boolean).sort()[0],
  }));
}

/** One fuel of one family in one region: the family's day points and each emitted version's own series. */
function fuelFile({ family, versions, windows, region, fuel, dataRoot, daily, paymentMethod, end }) {
  const own = versions.map((v, i) => {
    const byKey = family.fuels.includes(fuel) ? v.detail[mapOf(fuel)]?.[region] : null;
    const tariff = PAYMENT_KEYS[family.kind].map((k) => byKey?.[k]).find(Boolean) ?? null;
    if (!tariff) return null;
    const read = (rel) => readCsv(join(dataRoot, 'rates', tariff.code, `${rel}.csv`));
    const rows = { unitRows: read('standard_unit_rates'), standingRows: read('standing_charges') };
    const emitted = windows[i].to > SINCE && windows[i].to > windows[i].from;
    const termEnd = family.kind === 'fixed' && v.term !== null ? addMonths(v.availableFrom, v.term) : end;
    const ownEnd = termEnd < end ? termEnd : end;
    const to = emitted && ownEnd > windows[i].to ? ownEnd : windows[i].to;
    const days = daily(rows, { from: v.availableFrom, to, paymentMethod, fuel, availableFrom: v.availableFrom });
    return { tariff, emitted, ownEnd, byDay: new Map(days.map((d) => [d.day, d])), days };
  });
  const days = dayRange(versions[0].availableFrom, end).map((day) => {
    const i = windows.findIndex((w) => w.from <= day && day < w.to);
    const point = i < 0 ? null : own[i]?.byDay.get(day);
    return point
      ? { day, unit: point.unit, standingCharge: point.standingCharge, version: versions[i].code }
      : { day, unit: null, standingCharge: null, version: null };
  });
  const byVersion = {};
  versions.forEach((v, i) => {
    if (!own[i]?.emitted) return;
    byVersion[v.code] = {
      exitFee: (own[i].tariff.exit_fees_inc_vat ?? 0) / 100,
      days: own[i].days.filter((d) => d.day < own[i].ownEnd),
    };
  });
  return { days, versions: byVersion };
}

/** The family-file-shaped cap series of one region from the first cap period's start through the day before `end`. */
function capFile(caps, region, from, end) {
  const mine = caps.filter((r) => r.region === region);
  const file = {};
  for (const fuel of FUELS) {
    const days = dayRange(from, end).map((day) => {
      const r = mine.find((c) => c.from <= day && day <= c.to);
      return {
        day,
        unit: r ? incVat(r[fuel].unit, fuel, day) : null,
        standingCharge: r ? incVat(r[fuel].standing, fuel, day) : null,
        version: null,
      };
    });
    file[fuel] = { days, versions: {} };
  }
  return file;
}

const cell = (v) => (v === null ? '' : String(v));

/** The per-family CSV of the daily series the chart draws. */
function csvOf(file) {
  const lines = [
    'day,electricity_version,electricity_unit_rate,electricity_standing_charge,gas_version,gas_unit_rate,gas_standing_charge',
  ];
  file.electricity.days.forEach((e, i) => {
    const g = file.gas.days[i];
    lines.push([e.day, e.version, e.unit, e.standingCharge, g.version, g.unit, g.standingCharge].map(cell).join(','));
  });
  return `${lines.join('\n')}\n`;
}

/** Copies and hash-stamps the site assets from `site` into `out`; absent files are skipped. */
function buildSite({ site, out }) {
  rmSync(join(out, 'lib'), { recursive: true, force: true });
  const copy = (f) => {
    if (!existsSync(join(site, f))) return;
    mkdirSync(dirname(join(out, f)), { recursive: true });
    copyFileSync(join(site, f), join(out, f));
  };
  copy('app.css');
  const libDir = join(site, 'lib');
  for (const n of existsSync(libDir) ? readdirSync(libDir).filter((x) => x.endsWith('.js')) : []) copy(`lib/${n}`);
  if (resolve(out) !== resolve(REPO, 'docs') && existsSync(join(REPO, 'docs', 'vendor', 'chart.umd.js'))) {
    mkdirSync(join(out, 'vendor'), { recursive: true });
    copyFileSync(join(REPO, 'docs', 'vendor', 'chart.umd.js'), join(out, 'vendor', 'chart.umd.js'));
  }
  const hashes = new Map();
  for (const f of STAMPED) {
    if (!existsSync(join(site, f))) continue;
    const stamped = readFileSync(join(site, f), 'utf8').replace(IMPORT, (m, from, spec) => {
      const h = hashes.get(posix.join(posix.dirname(f), spec));
      return h ? `${from}'${spec}?v=${h}'` : m;
    });
    write(join(out, f), stamped);
    hashes.set(f, hashOf(stamped));
  }
  for (const f of ['app.css', 'vendor/chart.umd.js']) {
    if (existsSync(join(out, f))) hashes.set(f, hashOf(readFileSync(join(out, f))));
  }
  if (!existsSync(join(site, 'index.html'))) return;
  // Pages caches assets for ten minutes and browsers longer, while the HTML is fetched fresh: an asset URL that
  // carries its content hash makes a changed script or stylesheet load with the page instead of after the cache.
  const names = ['app.js', 'app.css', 'vendor/chart.umd.js'].filter((f) => hashes.has(f));
  const assets = new RegExp(`(href|src)="(\\.{1,2}/)(${names.map((f) => f.replace(/\./g, '\\.')).join('|')})"`, 'g');
  const html = readFileSync(join(site, 'index.html'), 'utf8');
  write(
    join(out, 'index.html'),
    names.length ? html.replace(assets, (_m, attr, rel, f) => `${attr}="${rel}${f}?v=${hashes.get(f)}"`) : html,
  );
}

/**
 * Builds docs/data/** and the site assets from `root` (families.json, cap.json, data/) into `out`.
 * `site` holds index.html, app.js, app.css and lib/ (default: this repo's src/site). Returns {generatedAt, capThrough}.
 */
export async function build({
  root = REPO,
  out = join(root, 'docs'),
  now = new Date(),
  site = join(REPO, 'src', 'site'),
  warn = console.error,
} = {}) {
  const generatedAt = new Date(now).toISOString();
  const today = ukDay(generatedAt);
  const end = addDays(today, 1); // the daily series run through today inclusive
  const config = JSON.parse(readFileSync(join(root, 'families.json'), 'utf8'));
  const caps = JSON.parse(readFileSync(join(root, 'cap.json'), 'utf8'));
  const dataRoot = join(root, 'data');
  const byFamily = versionsByFamily(dataRoot, config.families);
  const regions = Object.keys(config.regions);

  const capFrom = caps.map((r) => r.from).sort()[0];
  const capChanges = [...new Set(caps.map((r) => r.from))].sort().slice(1);
  const capThrough = caps
    .map((r) => r.to)
    .sort()
    .at(-1);
  if (capThrough < today) warn(`build: cap.json ends ${capThrough}, before ${today}: the cap line stops there`);

  rmSync(join(out, 'data'), { recursive: true, force: true });
  json(join(out, 'data', 'families.json'), {
    generatedAt,
    regions: config.regions,
    defaultRegion: config.defaultRegion,
    paymentMethod: config.paymentMethod,
    tdcv: TDCV,
    capChanges,
    capThrough,
    families: config.families.map((f) => ({
      id: f.id,
      label: f.label,
      kind: f.kind,
      fuels: f.fuels,
      versions: byFamily.get(f.id).map(({ code, fullName, availableFrom, availableTo, term }) => ({
        code,
        fullName,
        availableFrom,
        availableTo,
        term,
      })),
    })),
  });

  for (const family of config.families) {
    const versions = byFamily.get(family.id);
    const { daily } = await import(`./series/${family.series}.js`);
    const windows = windowsOf(versions, end);
    for (const region of regions) {
      const file = Object.fromEntries(
        FUELS.map((fuel) => [
          fuel,
          versions.length
            ? fuelFile({
                family,
                versions,
                windows,
                region,
                fuel,
                dataRoot,
                daily,
                paymentMethod: config.paymentMethod,
                end,
              })
            : { days: [], versions: {} },
        ]),
      );
      json(join(out, 'data', region, `${family.id}.json`), file);
      write(join(out, 'data', region, `${family.id}.csv`), csvOf(file));
    }
  }
  for (const region of regions) json(join(out, 'data', region, 'cap.json'), capFile(caps, region, capFrom, end));

  write(join(out, '.nojekyll'), '');
  buildSite({ site, out });
  return { generatedAt, capThrough };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (k) => args[args.indexOf(k) + 1];
  const root = args.includes('--root') ? arg('--root') : REPO;
  await build({ root, out: args.includes('--out') ? arg('--out') : join(root, 'docs') });
}
