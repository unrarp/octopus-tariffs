import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { build } from '../src/build.js';
import { annualAt, capSeries, costSince, versionSeries } from '../src/site/lib/compare.js';
import { annualCost } from '../src/site/lib/cost.js';
import { dailyKwh } from '../src/site/lib/profile.js';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'build');
const NOW = '2026-10-21T06:00:00.000Z';
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} vs ${b}`);
const row = (day, unit, standingCharge) => ({ day, unit, standingCharge });
const dayList = (from, n) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10),
  );
const flat = (from, n, unit, sc) => dayList(from, n).map((d) => row(d, unit, sc));
/** £ expected for the listed [day, unit, standing] triples. */
const expected = (fuel, kwh, triples) =>
  triples.reduce((s, [d, u, sc]) => s + dailyKwh(fuel, kwh, d) * u + sc, 0) / 100;
const same = (from, n, u, sc) => dayList(from, n).map((d) => [d, u, sc]);

let out;
const file = (region, name) => JSON.parse(readFileSync(join(out, 'data', region, `${name}.json`), 'utf8'));
before(async () => {
  out = mkdtempSync(join(tmpdir(), 'compare-'));
  await build({ root: FIXTURE, out, now: NOW, site: join(tmpdir(), 'octopus-tariffs-no-site') });
});

test('built fixed version costed from before it was on sale charges its first-row rate for those days, then its own rows', () => {
  const fuel = file('_C', 'oe-fix-12m').electricity;
  const code = 'OE-FIX-12M-26-05-10';
  const own = fuel.versions[code].days;
  assert.equal(own[0].day, '2026-05-10');
  const r = costSince(versionSeries('fixed', fuel, code), '2026-05-01', '2026-05-12', 'electricity', 2500);
  assert.equal(r.days, 11);
  assert.deepEqual(r.unpriced, []);
  const triples = dayList('2026-05-01', 11).map((d) => [d, own[0].unit, own[0].standingCharge]);
  triples[10] = [own[1].day, own[1].unit, own[1].standingCharge];
  near(r.cost, expected('electricity', 2500, triples));
});

test('built Flexible version costed from before its launch charges the previously on-sale version via the family series', () => {
  const fuel = file('_C', 'flexible').gas;
  const code = 'VAR-25-12-15';
  const own = fuel.versions[code].days;
  assert.equal(own[0].day, '2025-12-15');
  const r = costSince(versionSeries('variable', fuel, code), '2025-12-10', '2025-12-20', 'gas', 9500);
  assert.deepEqual(r.unpriced, []);
  const old = fuel.versions['VAR-25-01-01'].days;
  const triples = dayList('2025-12-10', 10).map((d) => {
    const x = (d < '2025-12-15' ? old : own).find((y) => y.day === d);
    return [d, x.unit, x.standingCharge];
  });
  assert.notEqual(old.find((x) => x.day === '2025-12-10').unit, own[0].unit);
  near(r.cost, expected('gas', 9500, triples));
});

test('built cap series prices its own days and leaves days before the cap file unpriced', () => {
  const fuel = file('_C', 'cap').electricity;
  const r = costSince(capSeries(fuel), '2026-06-29', '2026-07-03', 'electricity', 2500);
  assert.deepEqual(r.unpriced, ['2026-06-29', '2026-06-30']);
  const [a, b] = fuel.days;
  near(
    r.cost,
    expected('electricity', 2500, [
      [a.day, a.unit, a.standingCharge],
      [b.day, b.unit, b.standingCharge],
    ]),
  );
});

test('annualAt on built data is the annual cost at that day', () => {
  const fuel = file('_C', 'flexible').electricity;
  const s = versionSeries('variable', fuel, 'VAR-25-12-15');
  const d = fuel.days.find((x) => x.day === '2026-10-21');
  near(annualAt(s, '2026-10-21', 2500), annualCost(d, 2500));
  near(annualAt(s, '2026-10-21', 2500), (d.unit * 2500 + d.standingCharge * 365) / 100);
});

test('a day no basis prices is listed in unpriced and adds nothing to cost', () => {
  const s = { kind: 'variable', own: flat('2026-01-04', 4, 20, 40), family: flat('2026-01-01', 1, 30, 50) };
  const r = costSince(s, '2026-01-01', '2026-01-06', 'electricity', 2500);
  assert.deepEqual(r.unpriced, ['2026-01-02', '2026-01-03']);
  assert.equal(r.days, 5);
  near(
    r.cost,
    expected('electricity', 2500, [
      ['2026-01-01', 30, 50],
      ['2026-01-04', 20, 40],
      ['2026-01-05', 20, 40],
    ]),
  );
});

test('null rate rows count as unpriced, on the family basis and on the own basis', () => {
  const s = {
    kind: 'variable',
    own: [row('2026-01-03', null, null), row('2026-01-04', 20, 40)],
    family: [row('2026-01-01', null, null)],
  };
  const r = costSince(s, '2026-01-01', '2026-01-05', 'electricity', 2500);
  assert.deepEqual(r.unpriced, ['2026-01-01', '2026-01-02', '2026-01-03']);
});

test('a Flexible rate change inside the window switches rates on the day', () => {
  const own = [...flat('2026-01-01', 3, 20, 40), ...flat('2026-01-04', 3, 30, 50)];
  const r = costSince({ kind: 'variable', own, family: [] }, '2026-01-02', '2026-01-06', 'electricity', 2500);
  near(
    r.cost,
    expected('electricity', 2500, [
      ['2026-01-02', 20, 40],
      ['2026-01-03', 20, 40],
      ['2026-01-04', 30, 50],
      ['2026-01-05', 30, 50],
    ]),
  );
});

test('a fixed version stepping mid-term uses the new rate from the step; days before its rows use its first row', () => {
  const own = [...flat('2026-01-03', 2, 20, 40), ...flat('2026-01-05', 3, 25, 45)];
  const r = costSince(
    { kind: 'fixed', own, family: flat('2026-01-01', 9, 99, 99) },
    '2026-01-01',
    '2026-01-07',
    'gas',
    9500,
  );
  assert.deepEqual(r.unpriced, []);
  near(r.cost, expected('gas', 9500, [...same('2026-01-01', 4, 20, 40), ...same('2026-01-05', 2, 25, 45)]));
});

test('a fixed version with no priced row prices nothing before its rows', () => {
  const s = { kind: 'fixed', own: [row('2026-01-03', null, null)], family: [] };
  assert.equal(costSince(s, '2026-01-01', '2026-01-04', 'gas', 9500).unpriced.length, 3);
});

test('gas and electricity are costed per fuel and summed; electricity-only is the electricity figure alone', () => {
  const e = { kind: 'variable', own: flat('2026-01-01', 10, 25, 40), family: [] };
  const g = { kind: 'variable', own: flat('2026-01-01', 10, 7, 30), family: [] };
  const ce = costSince(e, '2026-01-01', '2026-01-11', 'electricity', 2500).cost;
  const cg = costSince(g, '2026-01-01', '2026-01-11', 'gas', 9500).cost;
  near(ce, expected('electricity', 2500, same('2026-01-01', 10, 25, 40)));
  near(cg, expected('gas', 9500, same('2026-01-01', 10, 7, 30)));
  // gas absent (empty field): only the electricity figure remains, no gas standing charge
  assert.equal(costSince(g, '2026-01-01', '2026-01-11', 'gas', null).cost, null);
  near(
    ce + cg,
    expected('electricity', 2500, same('2026-01-01', 10, 25, 40)) +
      expected('gas', 9500, same('2026-01-01', 10, 7, 30)),
  );
});

test('a start before 2023-07-01 is rejected; 2023-07-01 is accepted', () => {
  const s = { kind: 'variable', own: flat('2023-06-30', 5, 20, 40), family: [] };
  assert.throws(() => costSince(s, '2023-06-30', '2023-07-02', 'electricity', 2500), /2023-07-01/);
  assert.equal(costSince(s, '2023-07-01', '2023-07-02', 'electricity', 2500).days, 1);
});

test('a cutoff at or before the start, or before today, does not throw', () => {
  const s = { kind: 'variable', own: flat('2026-01-01', 10, 20, 40), family: [] };
  assert.deepEqual(costSince(s, '2026-01-05', '2026-01-05', 'electricity', 2500), { cost: 0, days: 0, unpriced: [] });
  assert.equal(costSince(s, '2026-01-05', '2026-01-02', 'electricity', 2500).days, 0);
  assert.equal(costSince(s, '2026-01-01', '2026-01-02', 'electricity', 2500).days, 1);
});

test('null kWh gives a null cost (days and unpriced still reported) and a null annualAt', () => {
  const s = { kind: 'variable', own: flat('2026-01-02', 3, 20, 40), family: [] };
  assert.deepEqual(costSince(s, '2026-01-01', '2026-01-04', 'gas', null), {
    cost: null,
    days: 3,
    unpriced: ['2026-01-01'],
  });
  assert.equal(annualAt(s, '2026-01-02', null), null);
  assert.equal(annualAt(s, '2026-01-01', 9500), null);
  near(annualAt(s, '2026-01-02', 9500), (20 * 9500 + 40 * 365) / 100);
});
