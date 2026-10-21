import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import { build } from '../src/build.js';
import { dayRange } from '../src/days.js';
import { TDCV } from '../src/site/lib/cost.js';
import { validate } from '../src/validate.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'build');
const NOW = '2026-10-21T06:00:00.000Z';
const NO_SITE = join(tmpdir(), 'octopus-tariffs-no-site');
const F1 = 'OE-FIX-12M-25-10-01';
const F2 = 'OE-FIX-12M-26-01-15';
const F3 = 'OE-FIX-12M-26-05-10';
const V1 = 'VAR-25-01-01';
const V2 = 'VAR-25-12-15';

const temp = () => mkdtempSync(join(tmpdir(), 'build-'));
const readJson = (out, ...p) => JSON.parse(readFileSync(join(out, 'data', ...p), 'utf8'));
const at = (days, day) => days.find((d) => d.day === day);

let out;
before(async () => {
  out = temp();
  await build({ root: FIXTURE, out, now: NOW, site: NO_SITE });
});

test('families.json lists regions, TDCV, cap boundaries and every version in launch order', () => {
  const f = readJson(out, 'families.json');
  assert.equal(f.generatedAt, NOW);
  assert.deepEqual(f.regions, { _C: 'London', _G: 'North West' });
  assert.equal(f.defaultRegion, '_C');
  assert.equal(f.paymentMethod, 'DIRECT_DEBIT');
  assert.deepEqual(f.tdcv, TDCV);
  assert.deepEqual(f.tdcv, { electricity: 2500, gas: 9500 });
  assert.deepEqual(f.capChanges, ['2026-10-01']);
  assert.equal(f.capThrough, '2026-12-31');
  assert.deepEqual(
    f.families.map((x) => x.id),
    ['oe-fix-12m', 'oe-fix-6m', 'flexible'],
  );
  assert.deepEqual(f.families[0].versions[1], {
    code: F2,
    fullName: 'Octopus 12M Fixed January 2026 v1',
    availableFrom: '2026-01-15',
    availableTo: '2026-03-01',
    term: 12,
  });
  assert.deepEqual(
    f.families[0].versions.map((v) => v.code),
    [F1, F2, F3],
  );
  assert.equal(f.families[2].versions[0].term, null);
  assert.equal(f.families[2].versions[1].availableTo, null);
});

test('window boundaries: a version ends at its own available_to, off-sale days stay as nulls, a gap separates 2 and 3', () => {
  const { electricity } = readJson(out, '_C', 'oe-fix-12m.json');
  const d = electricity.days;
  assert.deepEqual(
    d.map((x) => x.day),
    dayRange('2025-10-01', '2026-10-22'),
    'one point per day from the first launch through generatedAt, none dropped',
  );
  const v = (day) => at(d, day).version;
  assert.equal(v('2025-10-01'), F1);
  assert.equal(v('2025-11-30'), F1);
  assert.equal(v('2025-12-01'), null, 'F1 available_to');
  assert.equal(v('2026-01-14'), null);
  assert.equal(v('2026-01-15'), F2);
  assert.equal(v('2026-02-28'), F2);
  assert.equal(v('2026-03-01'), null, 'F2 available_to');
  assert.equal(v('2026-05-09'), null);
  assert.equal(v('2026-05-10'), F3);
  assert.equal(v('2026-10-21'), F3, 'an open head runs through the generatedAt day');
  assert.deepEqual(at(d, '2026-04-15'), { day: '2026-04-15', unit: null, standingCharge: null, version: null });
});

test('a region without the head tariff has it off sale, and a family never sold there is all null', () => {
  const g = readJson(out, '_G', 'oe-fix-12m.json');
  assert.equal(at(g.electricity.days, '2026-02-01').version, 'OE-FIX-12M-26-01-15');
  assert.deepEqual(at(g.electricity.days, '2026-05-10'), {
    day: '2026-05-10',
    unit: null,
    standingCharge: null,
    version: null,
  });
  assert.deepEqual(at(g.gas.days, '2026-10-21'), {
    day: '2026-10-21',
    unit: null,
    standingCharge: null,
    version: null,
  });
  assert.equal(F3 in g.electricity.versions, false);
  const six = readJson(out, '_G', 'oe-fix-6m.json');
  assert.equal(six.electricity.days.length, dayRange('2025-10-01', '2026-10-22').length);
  assert.ok(six.electricity.days.every((d) => d.unit === null && d.standingCharge === null && d.version === null));
  assert.deepEqual(six.gas.versions, {});
});

test('Flexible: the later version supplies the family line from its launch although the earlier is still on sale', () => {
  const { electricity, gas } = readJson(out, '_C', 'flexible.json');
  const e = electricity.days;
  assert.deepEqual(at(e, '2025-12-14'), { day: '2025-12-14', unit: 28.35, standingCharge: 53.55, version: V1 }); // 27 x 1.05, 51 x 1.05
  assert.deepEqual(at(e, '2025-12-15'), { day: '2025-12-15', unit: 28.875, standingCharge: 53.025, version: V2 }); // 27.5 x 1.05, 50.5 x 1.05
  assert.equal(at(e, '2026-01-01').unit, 30.975, 'V2 steps to 29.5 while V1 would have stepped to 29');
  assert.equal(at(e, '2026-01-01').version, V2);
  assert.equal(at(e, '2026-02-15').version, V2, 'V1 available_to has passed; V2 carries on');
  assert.equal(at(gas.days, '2025-12-15').version, V2);
  assert.equal(at(gas.days, '2025-12-15').unit, 8.505);
});

test('Flexible: three steps between its two launches, direct debit rows only', () => {
  const e = readJson(out, '_C', 'flexible.json').electricity.days;
  const between = e.filter((d) => d.day < '2025-12-15').map((d) => d.unit);
  assert.deepEqual([...new Set(between)], [31.5, 29.4, 27.3, 28.35]); // 30, 28, 26, 27 exc; the non-direct-debit rows are +1
});

test('a fixed version keeps its own series: the mid-term step lands on its day, from launch to term end', () => {
  const { electricity, gas } = readJson(out, '_C', 'oe-fix-12m.json');
  const v = electricity.versions[F1];
  assert.equal(v.exitFee, 75, 'exit_fees_inc_vat 7500 pence is 75 pounds');
  assert.equal(v.days[0].day, '2025-10-01');
  assert.equal(v.days.at(-1).day, '2026-09-30', 'launch + 12 months is the first day after the term');
  assert.equal(at(v.days, '2026-03-30').unit, 23.1); // 22 x 1.05
  assert.equal(at(v.days, '2026-03-31').unit, 20.475); // 19.5 x 1.05
  assert.equal(at(electricity.days, '2026-03-30').unit, null, 'F1 is off sale by then: the family line is null');
  assert.equal(at(v.days, '2026-03-31').standingCharge, 42);
  assert.equal(gas.versions[F1].days.length, v.days.length);
  assert.equal(readJson(out, '_C', 'flexible.json').electricity.versions[V1].exitFee, 0);
});

test('a version still inside its term at generatedAt runs to generatedAt; a variable one always does', () => {
  const fixed = readJson(out, '_C', 'oe-fix-12m.json').electricity.versions;
  assert.equal(fixed[F2].days.at(-1).day, '2026-10-21');
  assert.equal(fixed[F3].days.at(-1).day, '2026-10-21');
  const flex = readJson(out, '_C', 'flexible.json').electricity.versions;
  assert.equal(flex[V1].days[0].day, '2025-01-01');
  assert.equal(flex[V1].days.at(-1).day, '2026-10-21', 'V1 prices past its available_to');
  assert.equal(at(flex[V1].days, '2026-01-01').unit, 30.45); // 29 x 1.05: V1's own step, not V2's
});

test('a row whose only valid_from is null reads as the product available_from', () => {
  const { electricity } = readJson(out, '_C', 'oe-fix-12m.json');
  assert.equal(at(electricity.days, '2026-01-14').unit, null);
  assert.equal(at(electricity.days, '2026-01-15').unit, 22.05); // 21 x 1.05
  assert.equal(electricity.versions[F2].days[0].day, '2026-01-15');
  assert.equal(electricity.versions[F2].days[0].unit, 22.05);
});

test('inc VAT is derived at the day: electricity drops to 0 % on 2026-10-01, gas stays at 5 %', () => {
  const { electricity, gas } = readJson(out, '_C', 'oe-fix-12m.json');
  assert.equal(at(electricity.days, '2026-09-30').unit, 29.4); // 28 x 1.05
  assert.equal(at(electricity.days, '2026-10-01').unit, 28);
  assert.equal(at(electricity.days, '2026-09-30').standingCharge, 43.47); // 41.4 x 1.05
  assert.equal(at(electricity.days, '2026-10-01').standingCharge, 41.4);
  assert.equal(at(gas.days, '2026-09-30').unit, 9.765);
  assert.equal(at(gas.days, '2026-10-01').unit, 9.765);
  const v = electricity.versions[F2].days;
  assert.equal(at(v, '2026-09-30').unit, 22.05);
  assert.equal(at(v, '2026-10-01').unit, 21);
});

test('the API inc VAT is never emitted: a row priced by the API at 0 % still gets 5 % before the step', () => {
  const v = readJson(out, '_C', 'oe-fix-12m.json').electricity.versions[F1].days;
  assert.equal(at(v, '2026-04-01').unit, 20.475, 'the stored row says 19.5 inc, the output 19.5 x 1.05');
});

test('cap series: inc VAT derived like every row, null after a region runs out of periods', () => {
  const c = readJson(out, '_C', 'cap.json');
  assert.equal(c.electricity.days[0].day, '2026-07-01');
  assert.equal(c.electricity.days.at(-1).day, '2026-10-21');
  assert.deepEqual(at(c.electricity.days, '2026-09-30'), {
    day: '2026-09-30',
    unit: 25.725,
    standingCharge: 50.4,
    version: null,
  });
  assert.deepEqual(at(c.electricity.days, '2026-10-01'), {
    day: '2026-10-01',
    unit: 26,
    standingCharge: 49,
    version: null,
  });
  assert.deepEqual(at(c.gas.days, '2026-10-01'), {
    day: '2026-10-01',
    unit: 6.405,
    standingCharge: 29.925,
    version: null,
  });
  assert.deepEqual(c.electricity.versions, {});
  const g = readJson(out, '_G', 'cap.json');
  assert.equal(at(g.electricity.days, '2026-09-30').unit, 25.725);
  assert.deepEqual(at(g.electricity.days, '2026-10-01'), {
    day: '2026-10-01',
    unit: null,
    standingCharge: null,
    version: null,
  });
  assert.equal(g.gas.days.length, c.gas.days.length);
});

test('the per-family CSV has the documented header, empty cells for null, and a row per day', () => {
  const lines = readFileSync(join(out, 'data', '_C', 'oe-fix-12m.csv'), 'utf8')
    .trimEnd()
    .split('\n');
  assert.equal(
    lines[0],
    'day,electricity_version,electricity_unit_rate,electricity_standing_charge,gas_version,gas_unit_rate,gas_standing_charge',
  );
  assert.equal(lines.length, 1 + dayRange('2025-10-01', '2026-10-22').length);
  assert.equal(lines[1], `2025-10-01,${F1},23.1,42,${F1},7.14,30.45`);
  assert.ok(lines.includes('2025-12-01,,,,,,'));
  assert.equal(lines.at(-1), `2026-10-21,${F3},28,41.4,${F3},9.765,30.66`);
});

test('.nojekyll is written and the vendored chart library is copied to a non-default out', () => {
  assert.ok(existsSync(join(out, '.nojekyll')));
  assert.ok(existsSync(join(out, 'vendor', 'chart.umd.js')));
});

test('building twice gives identical output', async () => {
  const again = temp();
  try {
    await build({ root: FIXTURE, out: again, now: NOW, site: NO_SITE });
    for (const f of ['families.json', '_C/flexible.json', '_G/cap.json', '_C/oe-fix-12m.csv']) {
      assert.equal(readFileSync(join(again, 'data', f), 'utf8'), readFileSync(join(out, 'data', f), 'utf8'));
    }
  } finally {
    rmSync(again, { recursive: true, force: true });
  }
});

test('only versions on sale since 2023-07-01 get their own series, but all appear in the family line', async () => {
  const root = temp();
  const o = temp();
  try {
    cpSync(FIXTURE, root, { recursive: true });
    const old = 'OE-FIX-12M-22-01-01';
    const tariffCode = `E-1R-${old}-C`;
    const detail = {
      code: old,
      full_name: 'Octopus 12M Fixed January 2022 v1',
      term: 12,
      available_from: '2022-01-01T00:00:00Z',
      available_to: '2022-02-01T00:00:00Z',
      single_register_electricity_tariffs: {
        _C: { direct_debit_monthly: { code: tariffCode, exit_fees_inc_vat: 5000 } },
      },
    };
    const w = (p, s) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, s);
    };
    w(join(root, 'data', 'products', `${old}.json`), JSON.stringify(detail));
    const head = 'valid_from,valid_to,payment_method,value_exc_vat,value_inc_vat\n';
    for (const rel of ['standard_unit_rates', 'standing_charges']) {
      w(join(root, 'data', 'rates', tariffCode, `${rel}.csv`), `${head}2022-01-01T00:00:00Z,,,10,10.5\n`);
    }
    await build({ root, out: o, now: NOW, site: NO_SITE });
    const { electricity, gas } = readJson(o, '_C', 'oe-fix-12m.json');
    assert.equal(electricity.days[0].day, '2022-01-01');
    assert.equal(electricity.days[0].version, old);
    assert.equal(electricity.days[0].unit, 10.5);
    assert.equal(old in electricity.versions, false);
    assert.equal(F1 in electricity.versions, true);
    assert.equal(gas.days[0].version, null, 'a fuel the version has no tariff for is off sale');
    assert.equal(readJson(o, 'families.json').families[0].versions[0].code, old);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(o, { recursive: true, force: true });
  }
});

test('Flexible: tariffs keyed direct_debit_monthly (older stored products) and varying (newer) both build', () => {
  const stored = (code) => JSON.parse(readFileSync(join(FIXTURE, 'data', 'products', `${code}.json`), 'utf8'));
  assert.ok(stored(V1).single_register_electricity_tariffs._C.direct_debit_monthly);
  assert.ok(stored(V2).single_register_electricity_tariffs._C.varying);
  const e = readJson(out, '_C', 'flexible.json').electricity;
  assert.equal(at(e.days, '2025-01-01').version, V1);
  assert.equal(at(e.days, '2025-01-01').unit, 31.5);
  assert.ok(V1 in e.versions && V2 in e.versions);
});

test('versions launched the same day order by code, so the earlier codes get zero-length windows', async () => {
  const root = temp();
  const o = temp();
  try {
    cpSync(FIXTURE, root, { recursive: true });
    const dir = join(root, 'data', 'products');
    const base = JSON.parse(readFileSync(join(dir, `${V2}.json`), 'utf8'));
    // Same launch day as V2; both sort after it by code, and share its tariffs.
    for (const code of ['VAR-25-12-15-B', 'VAR-25-12-15-A']) {
      writeFileSync(join(dir, `${code}.json`), JSON.stringify({ ...base, code }));
    }
    await build({ root, out: o, now: NOW, site: NO_SITE });
    const codes = readJson(o, 'families.json').families[2].versions.map((v) => v.code);
    assert.deepEqual(codes, [V1, V2, 'VAR-25-12-15-A', 'VAR-25-12-15-B']);
    const e = readJson(o, '_C', 'flexible.json').electricity;
    assert.equal(at(e.days, '2025-12-15').version, 'VAR-25-12-15-B', 'the last code of the tie supplies the line');
    assert.equal(at(e.days, '2026-10-21').version, 'VAR-25-12-15-B');
    assert.equal(V2 in e.versions, false, 'a zero-length window is not emitted');
    assert.equal('VAR-25-12-15-A' in e.versions, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(o, { recursive: true, force: true });
  }
});

test('a cap that ends before generatedAt warns on stderr and still builds', async () => {
  const o = temp();
  const warnings = [];
  try {
    await build({ root: FIXTURE, out: o, now: NOW, site: NO_SITE, warn: (m) => warnings.push(m) });
    assert.deepEqual(warnings, []);
    await build({ root: FIXTURE, out: o, now: '2027-01-05T06:00:00Z', site: NO_SITE, warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cap\.json ends 2026-12-31, before 2027-01-05/);
    const c = readJson(o, '_C', 'cap.json');
    assert.equal(c.electricity.days.at(-1).day, '2027-01-05');
    assert.equal(at(c.electricity.days, '2027-01-05').unit, null);
    assert.equal(at(c.electricity.days, '2026-12-31').unit, 26);
  } finally {
    rmSync(o, { recursive: true, force: true });
  }
});

test('the day of generatedAt is the UK day', async () => {
  const o = temp();
  try {
    await build({ root: FIXTURE, out: o, now: '2026-10-21T23:30:00Z', site: NO_SITE }); // 00:30 BST on the 22nd
    assert.equal(readJson(o, '_C', 'flexible.json').electricity.days.at(-1).day, '2026-10-22');
  } finally {
    rmSync(o, { recursive: true, force: true });
  }
});

// Validation of the build output

const validateOut = (docsRoot) => validate({ root: FIXTURE, docsRoot });

test('the fixture and its build validate: only the cap and 6M region warnings', () => {
  const r = validateOut(out);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.warnings, [
    'cap.json: region _G has no cap after 2026-09-30 (others run to 2026-12-31)',
    'family oe-fix-6m has no stored tariff in region _G',
  ]);
});

/** Validates a copy of the build whose files `edit` has changed. */
function tamper(edit) {
  const copy = temp();
  try {
    cpSync(out, copy, { recursive: true });
    const file = (...p) => {
      const path = join(copy, 'data', ...p);
      return {
        read: () => JSON.parse(readFileSync(path, 'utf8')),
        write: (v) => writeFileSync(path, JSON.stringify(v)),
        path,
      };
    };
    edit(file);
    return validateOut(copy).failures;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

const has = (list, text) => list.some((m) => m.includes(text));

test('build validation: a missing family file or cap file fails', () => {
  assert.ok(
    has(
      tamper((f) => rmSync(f('_G', 'flexible.json').path)),
      'docs/data/_G/flexible.json: missing',
    ),
  );
  assert.ok(
    has(
      tamper((f) => rmSync(f('_C', 'cap.json').path)),
      'docs/data/_C/cap.json: missing',
    ),
  );
});

test('build validation: a gap in the days fails', () => {
  const failures = tamper((f) => {
    const file = f('_C', 'flexible.json');
    const j = file.read();
    j.electricity.days.splice(100, 1);
    file.write(j);
  });
  assert.ok(
    has(failures, 'docs/data/_C/flexible.json: electricity day 2025-04-10 is followed by 2025-04-12 (skips to)'),
    failures.join('\n'),
  );
});

test('build validation: a repeated day fails', () => {
  const failures = tamper((f) => {
    const file = f('_C', 'flexible.json');
    const j = file.read();
    j.gas.days.splice(100, 0, j.gas.days[100]);
    file.write(j);
  });
  assert.ok(has(failures, 'gas day 2025-04-11 is followed by 2025-04-11 (repeats)'), failures.join('\n'));
});

test('build validation: days that stop before the generatedAt day fail', () => {
  const failures = tamper((f) => {
    const file = f('_C', 'cap.json');
    const j = file.read();
    j.electricity.days.pop();
    file.write(j);
  });
  assert.ok(has(failures, 'days end 2026-10-20, want 2026-10-21'), failures.join('\n'));
});

test('build validation: a version that families.json does not list fails, null is fine', () => {
  const failures = tamper((f) => {
    const file = f('_C', 'oe-fix-12m.json');
    const j = file.read();
    j.electricity.days[3].version = 'OE-FIX-12M-99-99-99';
    file.write(j);
  });
  assert.ok(has(failures, 'has version OE-FIX-12M-99-99-99, not a listed version'), failures.join('\n'));
  assert.equal(
    tamper((f) => {
      const file = f('_C', 'cap.json');
      const j = file.read();
      j.gas.days[3].version = 'VAR-25-01-01';
      file.write(j);
    }).length,
    1,
    'the cap lists no versions',
  );
});

test('build validation: a family missing from the built families.json fails', () => {
  const failures = tamper((f) => {
    const file = f('families.json');
    const j = file.read();
    j.families.pop();
    file.write(j);
  });
  assert.ok(has(failures, 'docs/data/families.json: family flexible is missing'), failures.join('\n'));
});

test('build validation: every configured region is checked, even one the built families.json omits', () => {
  const failures = tamper((f) => {
    const file = f('families.json');
    const j = file.read();
    delete j.regions._G;
    file.write(j);
    rmSync(f('_G', 'flexible.json').path);
  });
  assert.ok(has(failures, 'docs/data/_G/flexible.json: missing'), failures.join('\n'));
  assert.ok(has(failures, 'region _G is missing'), failures.join('\n'));
});

test('build validation: a built family whose fuels differ from the config fails', () => {
  const failures = tamper((f) => {
    const file = f('families.json');
    const j = file.read();
    j.families[0].fuels = ['electricity'];
    file.write(j);
  });
  assert.ok(has(failures, 'oe-fix-12m: fuels'), failures.join('\n'));
});

test('build validation: a family file whose days start after the first launch fails', () => {
  const failures = tamper((f) => {
    const file = f('_C', 'flexible.json');
    const j = file.read();
    j.gas.days.shift();
    file.write(j);
  });
  assert.ok(has(failures, 'flexible.json: gas days start 2025-01-02, want 2025-01-01'), failures.join('\n'));
});

test('build validation: a cap file whose days start after the first cap period fails', () => {
  const failures = tamper((f) => {
    const file = f('_G', 'cap.json');
    const j = file.read();
    j.electricity.days.shift();
    file.write(j);
  });
  assert.ok(has(failures, 'cap.json: electricity days start'), failures.join('\n'));
});

// Asset hashing

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);

/** A temp site of stand-in files whose imports form profile <- cost <- compare <- app. */
function standInSite(profileSource = 'export const SHARES = [1];\n') {
  const site = temp();
  const w = (f, s) => {
    mkdirSync(dirname(join(site, f)), { recursive: true });
    writeFileSync(join(site, f), s);
  };
  w('lib/profile.js', profileSource);
  w('lib/cost.js', "import { SHARES } from './profile.js';\nexport const cost = () => SHARES;\n");
  w(
    'lib/compare.js',
    "import { cost } from './cost.js';\nimport { SHARES } from './profile.js';\nexport const cmp = () => [cost, SHARES];\n",
  );
  w(
    'app.js',
    "import { cmp } from './lib/compare.js';\nimport { cost } from './lib/cost.js';\nexport default [cmp, cost];\n",
  );
  w('app.css', 'body { margin: 0; }\n');
  w(
    'index.html',
    '<link rel="stylesheet" href="./app.css"><script src="./vendor/chart.umd.js"></script><script type="module" src="./app.js"></script>\n',
  );
  return site;
}

async function buildSite(site) {
  const o = temp();
  await build({ root: FIXTURE, out: o, now: NOW, site });
  const read = (f) => readFileSync(join(o, f), 'utf8');
  const v = (src, f) => new RegExp(`'\\./(?:lib/)?${f}\\.js\\?v=([0-9a-f]{8})'`).exec(src)?.[1];
  const html = read('index.html');
  const page = (f) => new RegExp(`(?:href|src)="\\./${f.replace('.', '\\.')}\\?v=([0-9a-f]{8})"`).exec(html)?.[1];
  const result = {
    o,
    read,
    cost: read('lib/cost.js'),
    compare: read('lib/compare.js'),
    app: read('app.js'),
    html,
    // The ?v= each importer carries for each target.
    seen: {
      profileInCost: v(read('lib/cost.js'), 'profile'),
      costInCompare: v(read('lib/compare.js'), 'cost'),
      profileInCompare: v(read('lib/compare.js'), 'profile'),
      compareInApp: v(read('app.js'), 'compare'),
      costInApp: v(read('app.js'), 'cost'),
      appInHtml: page('app.js'),
      cssInHtml: page('app.css'),
      chartInHtml: page('vendor/chart.umd.js'),
    },
  };
  return result;
}

test('import hashes cascade: one byte in profile.js changes the URLs of cost.js, compare.js and app.js', async () => {
  const siteA = standInSite('export const SHARES = [1];\n');
  const siteB = standInSite('export const SHARES = [2];\n');
  let a;
  let b;
  try {
    a = await buildSite(siteA);
    b = await buildSite(siteB);
    for (const k of Object.keys(a.seen)) assert.match(a.seen[k], /^[0-9a-f]{8}$/, k);
    assert.notEqual(a.seen.profileInCost, b.seen.profileInCost);
    assert.notEqual(a.seen.costInCompare, b.seen.costInCompare, 'cost.js URL changed');
    assert.notEqual(a.seen.compareInApp, b.seen.compareInApp, 'compare.js URL changed');
    assert.notEqual(a.seen.costInApp, b.seen.costInApp);
    assert.notEqual(a.seen.appInHtml, b.seen.appInHtml, 'app.js URL changed');
    assert.equal(a.seen.cssInHtml, b.seen.cssInHtml, 'unrelated assets keep their URL');
    assert.equal(a.seen.chartInHtml, b.seen.chartInHtml);
    // Each URL is the hash of the stamped file it points to.
    assert.equal(a.seen.profileInCost, sha(readFileSync(join(a.o, 'lib', 'profile.js'))));
    assert.equal(a.seen.costInCompare, sha(a.cost));
    assert.equal(a.seen.profileInCompare, a.seen.profileInCost);
    assert.equal(a.seen.compareInApp, sha(a.compare));
    assert.equal(a.seen.appInHtml, sha(a.app));
    assert.equal(a.seen.chartInHtml, sha(readFileSync(join(a.o, 'vendor', 'chart.umd.js'))));
    assert.ok(!/href="\/|src="\//.test(a.html), 'no root-absolute URLs');
  } finally {
    for (const d of [siteA, siteB, a?.o, b?.o]) if (d) rmSync(d, { recursive: true, force: true });
  }
});

test('a site with only some of the assets still builds', async () => {
  const site = temp();
  const o = temp();
  try {
    mkdirSync(join(site, 'lib'));
    writeFileSync(join(site, 'lib', 'cost.js'), 'export const x = 1;\n');
    await build({ root: FIXTURE, out: o, now: NOW, site });
    assert.equal(readFileSync(join(o, 'lib', 'cost.js'), 'utf8'), 'export const x = 1;\n');
    assert.equal(existsSync(join(o, 'index.html')), false);
  } finally {
    rmSync(site, { recursive: true, force: true });
    rmSync(o, { recursive: true, force: true });
  }
});

test('a rebuild removes stale files under data/ and leaves vendor/ alone', async () => {
  const o = temp();
  try {
    await build({ root: FIXTURE, out: o, now: NOW, site: NO_SITE });
    writeFileSync(join(o, 'data', '_C', 'retired-family.json'), '{}');
    await build({ root: FIXTURE, out: o, now: NOW, site: NO_SITE });
    assert.equal(existsSync(join(o, 'data', '_C', 'retired-family.json')), false);
    assert.ok(existsSync(join(o, 'vendor', 'chart.umd.js')));
  } finally {
    rmSync(o, { recursive: true, force: true });
  }
});
