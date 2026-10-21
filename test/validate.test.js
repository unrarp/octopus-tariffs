import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { KNOWN_SERIES, validate } from '../src/validate.js';

const FAMILY = (id, match) => ({ id, label: id, kind: 'fixed', match, series: 'stepped', fuels: ['electricity'] });
const CONFIG = {
  log: { brands: ['OCTOPUS_ENERGY'], skipRateHistory: ['^AGILE'] },
  regions: { _C: 'London', _G: 'North West' },
  defaultRegion: '_C',
  paymentMethod: 'DIRECT_DEBIT',
  families: [FAMILY('oe-fix-12m', '^OE-FIX-12M-'), FAMILY('flexible', '^VAR-')],
};

const HEADER = 'valid_from,valid_to,payment_method,value_exc_vat,value_inc_vat';
const DD = 'DIRECT_DEBIT';
const row = (from, to = '', pm = DD) => `${from},${to},${pm},1,1.05`;
const csv = (...rows) => `${[HEADER, ...rows].join('\n')}\n`;
const GOOD_CSV = csv(row('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), row('2026-01-01T00:00:00Z'));

const tariffCode = (code, region) => `E-1R-${code}-${region.slice(1)}`;

/** A product detail with a single-register tariff in each region, as collect stores it. */
function detailOf(code, regions = ['_C', '_G']) {
  return {
    code,
    fetchedAt: '2026-10-21T06:00:00.000Z',
    single_register_electricity_tariffs: Object.fromEntries(
      regions.map((r) => [r, { direct_debit_monthly: { code: tariffCode(code, r), standard_unit_rate_exc_vat: 1 } }]),
    ),
  };
}

/** Writes a valid small tree: two rendered products and an Agile product with no rates. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'validate-'));
  const dataRoot = join(root, 'data');
  const write = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const t = {
    root,
    dataRoot,
    write,
    config: (c) => write(join(root, 'families.json'), JSON.stringify(c)),
    product: (detail) =>
      write(join(dataRoot, 'products', `${detail.code}.json`), `${JSON.stringify(detail, null, 2)}\n`),
    rates: (code, region, rel, text = GOOD_CSV) =>
      write(join(dataRoot, 'rates', tariffCode(code, region), `${rel}.csv`), text),
    run: () => validate({ root, dataRoot }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  t.config(CONFIG);
  for (const code of ['OE-FIX-12M-26-01-01', 'VAR-22-11-01']) {
    t.product(detailOf(code));
    for (const r of ['_C', '_G']) for (const rel of ['standing_charges', 'standard_unit_rates']) t.rates(code, r, rel);
  }
  t.product(detailOf('AGILE-24-01-01', ['_C']));
  return t;
}

/** Runs `corrupt` on a fresh valid tree and returns the validation result. */
function corrupted(corrupt) {
  const t = setup();
  try {
    corrupt(t);
    return t.run();
  } finally {
    t.cleanup();
  }
}

const has = (list, text) => list.some((m) => m.includes(text));

test('a valid tree passes with no failures and no warnings', () => {
  const r = corrupted(() => {});
  assert.deepEqual(r, { failures: [], warnings: [] });
});

test('missing data/ is a failure naming the fix', () => {
  const r = corrupted((t) => rmSync(t.dataRoot, { recursive: true }));
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /data\/products is missing: run npm run collect/);
});

test('an unknown series is rejected (the seam for PLAN §4.3)', () => {
  assert.deepEqual(KNOWN_SERIES, ['stepped']);
  const r = corrupted((t) =>
    t.config({ ...CONFIG, families: [{ ...FAMILY('oe-fix-12m', '^OE-FIX-12M-'), series: 'time-of-use' }] }),
  );
  assert.ok(has(r.failures, 'unknown series "time-of-use"'), r.failures.join('\n'));
});

test('a family id that is not kebab-case fails', () => {
  const r = corrupted((t) => t.config({ ...CONFIG, families: [FAMILY('Oe_Fix', '^OE-FIX-12M-'), CONFIG.families[1]] }));
  assert.ok(has(r.failures, 'family id "Oe_Fix" is not kebab-case'), r.failures.join('\n'));
});

test('two families matching one stored product fail', () => {
  const r = corrupted((t) => t.config({ ...CONFIG, families: [...CONFIG.families, FAMILY('any-fix', '^OE-FIX-')] }));
  assert.ok(
    has(r.failures, 'OE-FIX-12M-26-01-01 is matched by more than one family: oe-fix-12m, any-fix'),
    r.failures.join('\n'),
  );
});

test('a missing CSV for an endpoint of a logged product fails', () => {
  const r = corrupted((t) =>
    rmSync(join(t.dataRoot, 'rates', tariffCode('VAR-22-11-01', '_G'), 'standing_charges.csv')),
  );
  assert.ok(has(r.failures, 'rates/E-1R-VAR-22-11-01-G/standing_charges.csv: missing'), r.failures.join('\n'));
});

test('a CSV under rates/ for a skipRateHistory product fails', () => {
  const r = corrupted((t) => t.rates('AGILE-24-01-01', '_C', 'standing_charges'));
  assert.ok(
    has(r.failures, 'AGILE-24-01-01 skips rate history but rates/E-1R-AGILE-24-01-01-C exists'),
    r.failures.join('\n'),
  );
});

test('a rates/ directory of a skipRateHistory product fails even when its tariff left the detail', () => {
  const r = corrupted((t) => t.rates('AGILE-24-01-01', '_P', 'standing_charges'));
  assert.ok(
    has(r.failures, 'AGILE-24-01-01 skips rate history but rates/E-1R-AGILE-24-01-01-P exists'),
    r.failures.join('\n'),
  );
});

test('a family with no match string or a repeated id fails', () => {
  const r = corrupted((t) =>
    t.config({ ...CONFIG, families: [...CONFIG.families, { ...FAMILY('flex', undefined) }, FAMILY('flex', '^ZZZ-')] }),
  );
  assert.ok(has(r.failures, 'family flex: match undefined is not a string'), r.failures.join('\n'));
  assert.ok(has(r.failures, 'family id "flex" is repeated'), r.failures.join('\n'));
});

test('a duplicate (valid_from, payment_method) key fails', () => {
  const r = corrupted((t) =>
    t.rates(
      'VAR-22-11-01',
      '_C',
      'standard_unit_rates',
      csv(row('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), row('2025-01-01T00:00:00Z')),
    ),
  );
  assert.ok(has(r.failures, 'standard_unit_rates.csv: duplicate key'), r.failures.join('\n'));
});

test('rows out of order within a payment method fail, interleaved methods do not', () => {
  const late = row('2026-01-01T00:00:00Z', '', DD);
  const early = row('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z', DD);
  const r = corrupted((t) => t.rates('VAR-22-11-01', '_C', 'standard_unit_rates', csv(late, early)));
  assert.ok(has(r.failures, 'rows not oldest first at 2025-01-01T00:00:00Z'), r.failures.join('\n'));
  const ok = corrupted((t) =>
    t.rates(
      'VAR-22-11-01',
      '_C',
      'standard_unit_rates',
      csv(
        row('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'A'),
        row('2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'B'),
        row('2026-01-01T00:00:00Z', '', 'A'),
        row('2025-01-01T00:00:00Z', '', 'B'),
      ),
    ),
  );
  assert.deepEqual(ok.failures, []);
});

test('an empty valid_from is allowed only as a payment method first row', () => {
  const first = corrupted((t) =>
    t.rates(
      'VAR-22-11-01',
      '_C',
      'standard_unit_rates',
      csv(row('', '2026-01-01T00:00:00Z'), row('2026-01-01T00:00:00Z')),
    ),
  );
  assert.deepEqual(first.failures, []);
  const later = corrupted((t) =>
    t.rates(
      'VAR-22-11-01',
      '_C',
      'standard_unit_rates',
      csv(row('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), row('', '')),
    ),
  );
  assert.ok(has(later.failures, 'empty valid_from after the first row'), later.failures.join('\n'));
});

test('two open rows for one payment method fail', () => {
  const r = corrupted((t) =>
    t.rates('VAR-22-11-01', '_C', 'standard_unit_rates', csv(row('2025-01-01T00:00:00Z'), row('2026-01-01T00:00:00Z'))),
  );
  assert.ok(has(r.failures, 'more than one open row'), r.failures.join('\n'));
});

test('a links key at any depth or a tariffs_active_at key in a product file fails', () => {
  const nested = corrupted((t) => {
    const d = detailOf('VAR-22-11-01');
    d.single_register_electricity_tariffs._C.direct_debit_monthly.links = [];
    t.product(d);
  });
  assert.ok(
    has(
      nested.failures,
      'products/VAR-22-11-01.json: forbidden key single_register_electricity_tariffs._C.direct_debit_monthly.links',
    ),
    nested.failures.join('\n'),
  );
  const active = corrupted((t) =>
    t.product({ ...detailOf('VAR-22-11-01'), tariffs_active_at: '2026-10-20T18:00:00Z' }),
  );
  assert.ok(has(active.failures, 'forbidden key tariffs_active_at'), active.failures.join('\n'));
});

test('warns, without failing, for a CSV with zero rows', () => {
  const r = corrupted((t) => t.rates('VAR-22-11-01', '_C', 'standing_charges', csv()));
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.warnings, ['rates/E-1R-VAR-22-11-01-C/standing_charges.csv: no rows']);
});

test('warns, without failing, for a family with no stored tariff in a region', () => {
  const r = corrupted((t) =>
    t.config({ ...CONFIG, families: [...CONFIG.families, FAMILY('oe-fix-6m', '^OE-FIX-6M-')] }),
  );
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.warnings, [
    'family oe-fix-6m has no stored tariff in region _C',
    'family oe-fix-6m has no stored tariff in region _G',
  ]);
  const partial = corrupted((t) => {
    t.config({ ...CONFIG, families: [...CONFIG.families, FAMILY('oe-fix-6m', '^OE-FIX-6M-')] });
    t.product(detailOf('OE-FIX-6M-25-01-01', ['_G']));
    for (const rel of ['standing_charges', 'standard_unit_rates']) t.rates('OE-FIX-6M-25-01-01', '_G', rel);
  });
  assert.deepEqual(partial.warnings, ['family oe-fix-6m has no stored tariff in region _C']);
});

test('the command prints prefixed lines and exits 1 on a failure', async () => {
  const { spawnSync } = await import('node:child_process');
  const t = setup();
  try {
    const src = join(dirname(new URL(import.meta.url).pathname), '..', 'src');
    // validate.js resolves its root from its own location, so run a copy laid out as <root>/src/validate.js.
    const copy = (name) => writeFileSync(join(t.root, 'src', name), readFileSync(join(src, name)));
    mkdirSync(join(t.root, 'src'));
    writeFileSync(join(t.root, 'package.json'), '{"type":"module"}');
    for (const n of ['validate.js', 'csv.js', 'families.js', 'days.js']) copy(n);
    t.rates('AGILE-24-01-01', '_C', 'standing_charges');
    const r = spawnSync('node', [join(t.root, 'src', 'validate.js')], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^fail: product AGILE-24-01-01 skips rate history/m);
    assert.match(r.stdout, /check:data: 1 failures, 0 warnings\n$/);
  } finally {
    t.cleanup();
  }
});
