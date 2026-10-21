import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { KNOWN_SERIES, validate } from '../src/validate.js';

const FAMILY = (id, match) => ({ id, label: id, kind: 'fixed', match, series: 'stepped', fuels: ['electricity'] });
const CONFIG = {
  log: {
    brands: ['OCTOPUS_ENERGY'],
    match: ['^OE-FIX-18M-', '^OE-FIX-12M-', '^OE-FIX-6M-', '^VAR-', '^GO-', '^COSY-', '^INTELLI-', '^IOG-'],
  },
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

const CAP_ROW = (region, from, to) => ({
  from,
  to,
  region,
  electricity: { unit: 27.5, standing: 50.1 },
  gas: { unit: 7.1, standing: 30.2 },
  typicalBill: 1700,
  source: 'https://example.test/cap.pdf',
});
const CAP = ['_C', '_G'].flatMap((r) => [
  CAP_ROW(r, '2026-07-01', '2026-09-30'),
  CAP_ROW(r, '2026-10-01', '2026-12-31'),
]);

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

/** Writes a valid small tree: two rendered products. */
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
  t.write(join(root, 'cap.json'), JSON.stringify(CAP));
  for (const code of ['OE-FIX-12M-26-01-01', 'VAR-22-11-01']) {
    t.product(detailOf(code));
    for (const r of ['_C', '_G']) for (const rel of ['standing_charges', 'standard_unit_rates']) t.rates(code, r, rel);
  }
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
  assert.deepEqual(r, { failures: [], warnings: [], capThrough: '2026-12-31' });
});

test('missing data/ is a failure naming the fix', () => {
  const r = corrupted((t) => rmSync(t.dataRoot, { recursive: true }));
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /data\/products is missing: run npm run collect/);
});

test('an unknown series is rejected (the seam for PLAN §4.3)', () => {
  assert.deepEqual(
    KNOWN_SERIES,
    readdirSync(join(import.meta.dirname, '../src/series'))
      .map((n) => n.replace(/\.js$/, ''))
      .sort(),
  );
  assert.ok(KNOWN_SERIES.includes('stepped'));
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

test('a product file whose code matches no log.match pattern fails', () => {
  const r = corrupted((t) => t.product(detailOf('AGILE-24-01-01', ['_C'])));
  assert.ok(has(r.failures, 'products/AGILE-24-01-01.json: code matches no log.match pattern'), r.failures.join('\n'));
});

test('a rates/ directory of no stored product fails, also when its tariff left the detail', () => {
  const r = corrupted((t) => {
    t.rates('AGILE-24-01-01', '_C', 'standing_charges');
    t.rates('VAR-22-11-01', '_P', 'standing_charges'); // VAR-22-11-01 is stored but has no _P tariff
  });
  assert.ok(has(r.failures, 'rates/E-1R-AGILE-24-01-01-C belongs to no stored product'), r.failures.join('\n'));
  assert.ok(has(r.failures, 'rates/E-1R-VAR-22-11-01-P belongs to no stored product'), r.failures.join('\n'));
});

test('a rendered family whose match is not listed in log.match fails', () => {
  const r = corrupted((t) => t.config({ ...CONFIG, families: [...CONFIG.families, FAMILY('agile', '^AGILE-')] }));
  assert.ok(has(r.failures, 'family agile: match "^AGILE-" is not in log.match'), r.failures.join('\n'));
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
    for (const n of ['validate.js', 'csv.js', 'families.js', 'days.js', 'vat.js']) copy(n);
    mkdirSync(join(t.root, 'src', 'series'));
    copy('series/stepped.js');
    t.rates('AGILE-24-01-01', '_C', 'standing_charges');
    const r = spawnSync('node', [join(t.root, 'src', 'validate.js')], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^fail: rates\/E-1R-AGILE-24-01-01-C belongs to no stored product/m);
    assert.match(r.stdout, /check:data: 1 failures, 0 warnings\n$/);
  } finally {
    t.cleanup();
  }
});

/** Validates a corrupted copy of the cap fixture. */
const capRun = (edit) =>
  corrupted((t) => t.write(join(t.root, 'cap.json'), JSON.stringify(edit(structuredClone(CAP)))));

test('cap.json: a missing or non-array file fails', () => {
  assert.ok(has(corrupted((t) => rmSync(join(t.root, 'cap.json'))).failures, 'cap.json: unreadable'));
  assert.ok(has(capRun(() => ({})).failures, 'cap.json: not an array'));
});

test('cap.json: a region not in families.json fails', () => {
  const r = capRun((rows) => rows.map((x, i) => (i === 0 ? { ...x, region: '_Z' } : x)));
  assert.ok(has(r.failures, 'region "_Z" is not in families.json'), r.failures.join('\n'));
});

test('cap.json: wrong types and missing fields fail', () => {
  for (const [what, edit] of [
    ['electricity.unit', (x) => ({ ...x, electricity: { ...x.electricity, unit: '27.5' } })],
    ['gas.standing', (x) => ({ ...x, gas: { unit: 7.1 } })],
    ['typicalBill', (x) => ({ ...x, typicalBill: null })],
    ['source', (x) => ({ ...x, source: undefined })],
    ['from', (x) => ({ ...x, from: '2026-7-1' })],
    ['to', (x) => ({ ...x, to: 20261231 })],
    ['to', (x) => ({ ...x, to: '2026-02-30' })],
  ]) {
    const r = capRun((rows) => rows.map((x, i) => (i === 0 ? edit(x) : x)));
    assert.ok(has(r.failures, `cap.json[0]: ${what} `), `${what}: ${r.failures}`);
  }
});

test('cap.json: from after to fails', () => {
  const r = capRun((rows) => rows.map((x, i) => (i === 0 ? { ...x, from: '2026-10-01', to: '2026-09-30' } : x)));
  assert.ok(has(r.failures, 'from 2026-10-01 is after to 2026-09-30'), r.failures.join('\n'));
});

test('cap.json: overlapping periods in a region fail', () => {
  const r = capRun((rows) => rows.map((x, i) => (i === 0 ? { ...x, to: '2026-10-01' } : x)));
  assert.ok(
    has(r.failures, 'region _C periods 2026-07-01..2026-10-01 and 2026-10-01..2026-12-31 overlap'),
    r.failures.join('\n'),
  );
});

test('cap.json: a region missing a period warns but passes, and a gap warns', () => {
  const missing = capRun((rows) => rows.filter((x) => !(x.region === '_G' && x.from === '2026-10-01')));
  assert.deepEqual(missing.failures, []);
  assert.deepEqual(missing.warnings, ['cap.json: region _G has no cap after 2026-09-30 (others run to 2026-12-31)']);
  assert.equal(missing.capThrough, '2026-12-31');
  const none = capRun((rows) => rows.filter((x) => x.region !== '_G'));
  assert.deepEqual(none.warnings, ['cap.json: region _G has no cap rows']);
  const gap = capRun((rows) =>
    rows.map((x) => (x.region === '_G' && x.from === '2026-10-01' ? { ...x, from: '2026-10-05' } : x)),
  );
  assert.deepEqual(gap.failures, []);
  assert.deepEqual(gap.warnings, ['cap.json: region _G has no cap between 2026-09-30 and 2026-10-05']);
});

test('cap.json: capThrough is the latest period end', () => {
  assert.equal(capRun((rows) => rows.filter((x) => x.to === '2026-09-30')).capThrough, '2026-09-30');
});

const tampered =
  (code, region, rel, ...rows) =>
  (t) =>
    t.rates(code, region, rel, csv(...rows));
const closed = (from, to, exc, inc, pm = DD) => `${from},${to},${pm},${exc},${inc}`;

test('VAT: a closed row of a rendered family whose inc VAT is not exc x (1 + VAT) fails', () => {
  const r = corrupted(
    tampered(
      'VAR-22-11-01',
      '_C',
      'standard_unit_rates',
      closed('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 1.2),
    ),
  );
  assert.ok(
    has(r.failures, 'rates/E-1R-VAR-22-11-01-C/standard_unit_rates.csv: row 2025-01-01'),
    r.failures.join('\n'),
  );
  assert.equal(r.failures.length, 1);
});

test('VAT: the check follows the schedule, so a row wholly after 2026-10-01 must carry 0 % electricity VAT', () => {
  const wrong = closed('2026-10-02T00:00:00Z', '2026-11-01T00:00:00Z', 1, 1.05);
  const right = closed('2026-10-02T00:00:00Z', '2026-11-01T00:00:00Z', 1, 1);
  assert.equal(corrupted(tampered('VAR-22-11-01', '_C', 'standing_charges', wrong)).failures.length, 1);
  assert.equal(corrupted(tampered('VAR-22-11-01', '_C', 'standing_charges', right)).failures.length, 0);
});

test('VAT: a closed row spanning the 2026-10-01 step is skipped, priced at either rate', () => {
  for (const inc of [1, 1.05]) {
    const r = corrupted(
      tampered(
        'VAR-22-11-01',
        '_C',
        'standard_unit_rates',
        closed('2026-09-01T00:00:00Z', '2026-11-01T00:00:00Z', 1, inc),
      ),
    );
    assert.deepEqual(r.failures, []);
  }
});

test('VAT: a row ending at 23:00Z on 2026-09-30 (UK 2026-10-01) is inside the 5 % period, not spanning', () => {
  const r = corrupted(
    tampered('VAR-22-11-01', '_C', 'standard_unit_rates', closed('2026-06-30T23:00:00Z', '2026-09-30T23:00:00Z', 1, 1)),
  );
  assert.equal(r.failures.length, 1);
});

test('VAT: a null valid_from reads as the product available_from', () => {
  const edit = (availableFrom, inc) => (t) => {
    t.product({ ...detailOf('VAR-22-11-01'), available_from: availableFrom });
    t.rates('VAR-22-11-01', '_C', 'standard_unit_rates', csv(closed('', '2026-11-01T00:00:00Z', 1, inc)));
  };
  assert.deepEqual(corrupted(edit('2026-10-05T00:00:00+01:00', 1)).failures, []); // inside 0 %: correct
  assert.equal(corrupted(edit('2026-10-05T00:00:00+01:00', 1.05)).failures.length, 1);
  assert.deepEqual(corrupted(edit('2026-09-01T00:00:00+01:00', 1)).failures, []); // spans the step: skipped
});

test('VAT: products outside every rendered family are not checked', () => {
  const r = corrupted((t) => {
    t.product(detailOf('GO-24-01-01'));
    t.rates(
      'GO-24-01-01',
      '_C',
      'standing_charges',
      csv(closed('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1, 1.2)),
    );
    t.rates('GO-24-01-01', '_C', 'standard_unit_rates');
    t.rates('GO-24-01-01', '_G', 'standing_charges');
    t.rates('GO-24-01-01', '_G', 'standard_unit_rates');
  });
  assert.deepEqual(r.failures, []);
});

test('VAT: a gas row is checked against the gas schedule, 5 % on both sides of 2026-10-01', () => {
  const edit = (inc) => (t) => {
    const detail = detailOf('VAR-22-11-01');
    detail.single_register_gas_tariffs = {
      _C: { direct_debit_monthly: { code: 'G-1R-VAR-22-11-01-C', standard_unit_rate_exc_vat: 1 } },
    };
    t.product(detail);
    for (const rel of ['standing_charges', 'standard_unit_rates']) {
      t.write(
        join(t.dataRoot, 'rates', 'G-1R-VAR-22-11-01-C', `${rel}.csv`),
        csv(closed('2026-10-02T00:00:00Z', '2026-11-01T00:00:00Z', 1, inc)),
      );
    }
  };
  assert.deepEqual(corrupted(edit(1.05)).failures, []);
  assert.equal(corrupted(edit(1)).failures.length, 2);
});
