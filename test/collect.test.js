import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collect } from '../src/collect.js';

const BASE = 'https://api.octopus.energy/v1';
const NOW = '2026-10-21T06:00:00.000Z';
const retryOpts = { attempts: 2, delays: [0] };
const FAMILIES = {
  log: {
    brands: ['OCTOPUS_ENERGY'],
    match: ['^OE-FIX-18M-', '^OE-FIX-12M-', '^OE-FIX-6M-', '^VAR-', '^GO-', '^COSY-', '^INTELLI-', '^IOG-'],
  },
  regions: { _C: 'London' },
};

const MAPS = {
  single: ['single_register_electricity_tariffs', 'electricity', 'E-1R-'],
  dual: ['dual_register_electricity_tariffs', 'electricity', 'E-2R-'],
};

/** A list row in the API's shape. */
const listRow = (code, over = {}) => ({
  code,
  brand: 'OCTOPUS_ENERGY',
  term: null,
  available_from: '2022-11-01T00:00:00Z',
  available_to: null,
  links: [{ href: `${BASE}/products/${code}/`, method: 'GET', rel: 'self' }],
  ...over,
});

/** A detail in the API's shape with one region-C tariff; `fields` become tariff fields, links derive from them. */
function detailOf(code, row, { kind = 'single', fields = { standard_unit_rate_exc_vat: 1 }, links } = {}) {
  const [map, fuel, prefix] = MAPS[kind];
  const tariffCode = `${prefix}${code}-C`;
  const rels = [
    'standing_charges',
    ...Object.keys(fields)
      .filter((k) => k.endsWith('_unit_rate_exc_vat'))
      .map((k) => `${k.replace('_unit_rate_exc_vat', '')}_unit_rates`),
  ];
  return {
    ...row,
    tariffs_active_at: '2026-10-20T18:00:00Z',
    [map]: {
      _C: {
        direct_debit_monthly: {
          code: tariffCode,
          standing_charge_exc_vat: 40,
          ...fields,
          links:
            links ??
            rels.map((rel) => ({
              href: `${BASE}/products/${code}/${fuel}-tariffs/${tariffCode}/${rel.replaceAll('_', '-')}/`,
              method: 'GET',
              rel,
            })),
        },
      },
    },
    sample_quotes: { _C: { direct_debit_monthly: { links: [{ rel: 'x' }] } } },
    links: row.links,
  };
}

const rate = (from, to = null, pm = null, v = 1) => ({
  value_exc_vat: v,
  value_inc_vat: v,
  valid_from: from,
  valid_to: to,
  payment_method: pm,
});

/** A mutable fake API: world.current / world.historical (list rows), world.details (code -> body), world.rates (url -> rows oldest first). */
function newWorld() {
  const world = { current: [], historical: [], details: {}, rates: {}, calls: [], failOn: null };
  world.fetch = async (url) => {
    world.calls.push(url);
    const body = (b) => ({ ok: true, status: 200, json: async () => structuredClone(b) });
    if (world.failOn && url.includes(world.failOn)) return { ok: false, status: 500, json: async () => ({}) };
    if (url === `${BASE}/products/?page_size=200`) return body({ next: null, results: world.current });
    if (url === `${BASE}/products/?page_size=200&is_historical=true`) {
      return body({ next: null, results: world.historical });
    }
    const code = /\/products\/([^/]+)\/$/.exec(url)?.[1];
    if (code && world.details[code]) return body(world.details[code]);
    const href = url.replace(/\?page_size=1500$/, '');
    if (url.endsWith('?page_size=1500') && href in world.rates) {
      return body({ next: null, results: [...world.rates[href]].reverse() });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return world;
}

/** Adds a product to the world; returns its endpoint urls by rel. */
function addProduct(world, code, { list = {}, historical = false, detail, rows = {} } = {}) {
  const row = listRow(code, list);
  (historical ? world.historical : world.current).push(row);
  const d = detailOf(code, row, detail);
  world.details[code] = d;
  const urls = {};
  for (const l of Object.values(d)
    .flatMap((m) => Object.values(m?._C ?? {}))
    .flatMap((t) => t.links ?? [])) {
    urls[l.rel] = l.href;
    world.rates[l.href] = rows[l.rel] ?? [rate('2025-01-01T00:00:00Z')];
  }
  return urls;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'collect-'));
  writeFileSync(join(root, 'families.json'), JSON.stringify(FAMILIES));
  const dataRoot = join(root, 'data');
  const run = (world, now = NOW) => {
    const lines = [];
    return collect({ root, dataRoot, fetch: world.fetch, retryOpts, now, log: (l) => lines.push(l) }).then((s) => ({
      ...s,
      lines,
    }));
  };
  return { root, dataRoot, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const read = (p) => readFileSync(p, 'utf8');
const files = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const onlyCalls = (world, needle) => world.calls.filter((u) => u.includes(needle));

/** A world with an in-term fixed, an on-sale variable and a retired out-of-term variable. */
function standardWorld() {
  const world = newWorld();
  const F = 'OE-FIX-12M-26-01-01';
  const V = 'VAR-22-11-01';
  const R = 'VAR-19-01-01';
  const urls = {
    F: addProduct(world, F, { list: { term: 12, available_to: '2026-06-01T00:00:00+01:00' } }),
    V: addProduct(world, V, { rows: { standard_unit_rates: [rate('2025-01-01T00:00:00Z', null, 'DIRECT_DEBIT')] } }),
    R: addProduct(world, R, { list: { available_to: '2020-01-01T00:00:00Z' }, historical: true }),
  };
  return { world, urls, F, V, R };
}

test('first run writes product files and rate CSVs and prints the summary', async () => {
  const { world, F, V, R } = standardWorld();
  const t = setup();
  try {
    const s = await t.run(world);
    assert.deepEqual(files(join(t.dataRoot, 'products')), [`${F}.json`, `${R}.json`, `${V}.json`]);
    assert.deepEqual(files(join(t.dataRoot, 'rates')), [`E-1R-${F}-C`, `E-1R-${R}-C`, `E-1R-${V}-C`]);
    assert.equal(s.products, 3);
    assert.equal(s.updated, 0);
    assert.equal(s.rows, 6);
    assert.equal(s.skipped, 0);
    assert.equal(s.lines.at(-1), 'collected products=3 updated=0 rows=6 skipped=0 empty=0');
    assert.equal(
      read(join(t.dataRoot, 'rates', `E-1R-${V}-C`, 'standard_unit_rates.csv')),
      'valid_from,valid_to,payment_method,value_exc_vat,value_inc_vat\n2025-01-01T00:00:00Z,,DIRECT_DEBIT,1,1\n',
    );
  } finally {
    t.cleanup();
  }
});

test('product files drop links and tariffs_active_at, add fetchedAt, sort keys, end with a newline', async () => {
  const { world, F } = standardWorld();
  const t = setup();
  try {
    await t.run(world);
    const text = read(join(t.dataRoot, 'products', `${F}.json`));
    assert.ok(text.endsWith('}\n'));
    assert.ok(!text.includes('"links"'));
    assert.ok(!text.includes('tariffs_active_at'));
    const body = JSON.parse(text);
    assert.equal(body.fetchedAt, NOW);
    assert.deepEqual(Object.keys(body), Object.keys(body).sort());
    assert.equal(text, `${JSON.stringify(body, null, 2)}\n`);
    const tariff = body.single_register_electricity_tariffs._C.direct_debit_monthly;
    assert.deepEqual(Object.keys(tariff), Object.keys(tariff).sort());
    assert.ok(tariff.code.startsWith('E-1R-'));
  } finally {
    t.cleanup();
  }
});

test('a second run with a fresh tariffs_active_at writes nothing and skips retired tariffs', async () => {
  const { world, F, V, R } = standardWorld();
  const t = setup();
  try {
    await t.run(world);
    const before = read(join(t.dataRoot, 'products', `${F}.json`));
    for (const d of Object.values(world.details)) d.tariffs_active_at = '2026-10-21T05:00:00Z';
    world.calls.length = 0;
    const s = await t.run(world, '2026-10-22T06:00:00.000Z');
    assert.deepEqual([s.products, s.updated, s.rows, s.skipped], [0, 0, 0, 2]);
    assert.equal(read(join(t.dataRoot, 'products', `${F}.json`)), before);
    assert.equal(onlyCalls(world, R).length, 0);
    assert.equal(onlyCalls(world, V).length, 3);
  } finally {
    t.cleanup();
  }
});

test('a rewrite happens only when the body differs, ignoring fetchedAt, for a product in term', async () => {
  const { world, F } = standardWorld();
  const t = setup();
  try {
    await t.run(world);
    world.details[F].full_name = 'Renamed';
    const s = await t.run(world, '2026-10-22T06:00:00.000Z');
    assert.equal(s.updated, 1);
    const body = JSON.parse(read(join(t.dataRoot, 'products', `${F}.json`)));
    assert.equal(body.full_name, 'Renamed');
    assert.equal(body.fetchedAt, '2026-10-22T06:00:00.000Z');
  } finally {
    t.cleanup();
  }
});

test('retirement rewrites exactly one product file, closes its open rows, and a retired product is then left alone', async () => {
  const { world, urls, V, F, R } = standardWorld();
  const t = setup();
  try {
    await t.run(world);
    const row = world.current.find((r) => r.code === V);
    row.available_to = '2026-10-10T00:00:00+01:00';
    world.details[V].available_to = row.available_to;
    world.rates[urls.V.standard_unit_rates] = [rate('2025-01-01T00:00:00Z', '2026-10-10T23:00:00Z', 'DIRECT_DEBIT')];
    const bodies = () => [F, R, V].map((c) => read(join(t.dataRoot, 'products', `${c}.json`)));
    const before = bodies();
    const s = await t.run(world, '2026-10-22T06:00:00.000Z');
    assert.equal(s.updated, 1);
    assert.equal(
      read(join(t.dataRoot, 'rates', `E-1R-${V}-C`, 'standard_unit_rates.csv')).split('\n')[1],
      '2025-01-01T00:00:00Z,2026-10-10T23:00:00Z,DIRECT_DEBIT,1,1',
    );
    const after = bodies();
    assert.equal(after[0], before[0]);
    assert.equal(after[1], before[1]);
    assert.equal(JSON.parse(after[2]).available_to, row.available_to);
    world.calls.length = 0;
    const again = await t.run(world, '2026-10-23T06:00:00.000Z');
    assert.equal(again.updated, 0);
    assert.equal(onlyCalls(world, `/products/${V}/`).length, 0);
  } finally {
    t.cleanup();
  }
});

test('a fixed product gaining a second row appends it after the stored one', async () => {
  const { world, urls, F } = standardWorld();
  const t = setup();
  try {
    await t.run(world);
    const href = urls.F.standard_unit_rates;
    world.rates[href] = [rate('2025-01-01T00:00:00Z'), rate('2026-04-01T00:00:00Z', null, null, 2)];
    const s = await t.run(world, '2026-10-22T06:00:00.000Z');
    assert.equal(s.rows, 1);
    const lines = read(join(t.dataRoot, 'rates', `E-1R-${F}-C`, 'standard_unit_rates.csv'))
      .trim()
      .split('\n');
    assert.deepEqual(lines.slice(1), ['2025-01-01T00:00:00Z,,,1,1', '2026-04-01T00:00:00Z,,,2,2']);
  } finally {
    t.cleanup();
  }
});

test('a valid_to fill-in rewrites the right row in a two-method file', async () => {
  const world = newWorld();
  const V = 'VAR-22-11-01';
  const urls = addProduct(world, V, {
    rows: {
      standard_unit_rates: [
        rate('2025-01-01T00:00:00Z', null, 'DIRECT_DEBIT'),
        rate('2025-01-01T00:00:00Z', null, 'NON_DIRECT_DEBIT'),
      ],
    },
  });
  const t = setup();
  try {
    await t.run(world);
    world.rates[urls.standard_unit_rates] = [
      rate('2025-01-01T00:00:00Z', '2025-07-01T00:00:00Z', 'DIRECT_DEBIT'),
      rate('2025-01-01T00:00:00Z', null, 'NON_DIRECT_DEBIT'),
      rate('2025-07-01T00:00:00Z', null, 'DIRECT_DEBIT', 3),
    ];
    const s = await t.run(world, '2026-10-22T06:00:00.000Z');
    assert.equal(s.rows, 1);
    const lines = read(join(t.dataRoot, 'rates', `E-1R-${V}-C`, 'standard_unit_rates.csv'))
      .trim()
      .split('\n');
    assert.deepEqual(lines.slice(1), [
      '2025-01-01T00:00:00Z,2025-07-01T00:00:00Z,DIRECT_DEBIT,1,1',
      '2025-01-01T00:00:00Z,,NON_DIRECT_DEBIT,1,1',
      '2025-07-01T00:00:00Z,,DIRECT_DEBIT,3,3',
    ]);
  } finally {
    t.cleanup();
  }
});

test('a code outside log.match gets no product or rate files and no requests', async () => {
  const world = newWorld();
  const A = 'AGILE-24-10-01';
  addProduct(world, A);
  const t = setup();
  try {
    await t.run(world);
    assert.equal(existsSync(join(t.dataRoot, 'products')), false);
    assert.equal(existsSync(join(t.dataRoot, 'rates')), false);
    assert.equal(onlyCalls(world, A).length, 0);
  } finally {
    t.cleanup();
  }
});

test('a dual-register tariff gets day and night CSVs and no standard CSV', async () => {
  const world = newWorld();
  const D = 'VAR-22-11-02';
  addProduct(world, D, { detail: { kind: 'dual', fields: { day_unit_rate_exc_vat: 1, night_unit_rate_exc_vat: 2 } } });
  const t = setup();
  try {
    await t.run(world);
    assert.deepEqual(files(join(t.dataRoot, 'rates', `E-2R-${D}-C`)), [
      'day_unit_rates.csv',
      'night_unit_rates.csv',
      'standing_charges.csv',
    ]);
  } finally {
    t.cleanup();
  }
});

test('a rel mismatch between fields and links throws', async () => {
  const world = newWorld();
  const P = 'VAR-22-11-03';
  addProduct(world, P);
  world.details[P].single_register_electricity_tariffs._C.direct_debit_monthly.links.pop();
  const t = setup();
  try {
    await assert.rejects(t.run(world), /links differ from derived endpoints/);
    assert.equal(existsSync(join(t.dataRoot, 'products', `${P}.json`)), false);
  } finally {
    t.cleanup();
  }
});

test('a retired product whose CSV is missing gets it fetched, and an empty endpoint gets a header-only CSV', async () => {
  const { world, urls, R } = standardWorld();
  const t = setup();
  try {
    await t.run(world);
    const csv = join(t.dataRoot, 'rates', `E-1R-${R}-C`, 'standard_unit_rates.csv');
    rmSync(csv);
    world.rates[urls.R.standing_charges] = [];
    rmSync(join(t.dataRoot, 'rates', `E-1R-${R}-C`, 'standing_charges.csv'));
    const s = await t.run(world, '2026-10-22T06:00:00.000Z');
    assert.equal(s.rows, 1);
    assert.equal(s.empty, 1);
    assert.equal(s.skipped, 0);
    assert.equal(read(csv).trim().split('\n').length, 2);
    assert.equal(
      read(join(t.dataRoot, 'rates', `E-1R-${R}-C`, 'standing_charges.csv'))
        .trim()
        .split('\n').length,
      1,
    );
    assert.match(s.lines.at(-1), /empty=1$/);
  } finally {
    t.cleanup();
  }
});

test('a brand outside log.brands is ignored', async () => {
  const world = newWorld();
  addProduct(world, 'COOP-FIX-12M-26-10-19', { list: { brand: 'COOP_ENERGY', term: 12 } });
  const t = setup();
  try {
    const s = await t.run(world);
    assert.equal(s.products, 0);
    assert.equal(existsSync(join(t.dataRoot, 'products')), false);
    assert.equal(onlyCalls(world, 'COOP').length, 0);
  } finally {
    t.cleanup();
  }
});

test('a failing request throws after in-flight work finishes, and a rerun resumes', async () => {
  const { world, V } = standardWorld();
  const t = setup();
  try {
    world.failOn = `${V}-C/standing-charges`;
    await assert.rejects(t.run(world), /HTTP 500/);
    assert.equal(existsSync(join(t.dataRoot, 'rates', `E-1R-${V}-C`, 'standing_charges.csv')), false);
    world.failOn = null;
    const s = await t.run(world);
    assert.equal(s.products, 0);
    assert.ok(existsSync(join(t.dataRoot, 'rates', `E-1R-${V}-C`, 'standing_charges.csv')));
  } finally {
    t.cleanup();
  }
});

test('a retirement whose rate refetch fails is redone on the next run', async () => {
  const { world, urls, V } = standardWorld();
  const t = setup();
  try {
    await t.run(world);
    const row = world.current.find((r) => r.code === V);
    row.available_to = '2026-10-10T00:00:00+01:00';
    world.details[V].available_to = row.available_to;
    world.rates[urls.V.standard_unit_rates] = [rate('2025-01-01T00:00:00Z', '2026-10-10T23:00:00Z', 'DIRECT_DEBIT')];
    world.failOn = `${V}-C/standing-charges`;
    await assert.rejects(t.run(world, '2026-10-22T06:00:00.000Z'), /HTTP 500/);
    world.failOn = null;
    world.rates[urls.V.standing_charges] = [rate('2025-01-01T00:00:00Z', '2026-10-10T23:00:00Z')];
    await t.run(world, '2026-10-23T06:00:00.000Z');
    assert.equal(
      read(join(t.dataRoot, 'rates', `E-1R-${V}-C`, 'standing_charges.csv')).split('\n')[1],
      '2025-01-01T00:00:00Z,2026-10-10T23:00:00Z,,1,1',
    );
    assert.equal(JSON.parse(read(join(t.dataRoot, 'products', `${V}.json`))).available_to, row.available_to);
  } finally {
    t.cleanup();
  }
});
