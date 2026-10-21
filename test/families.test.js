import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkLinks, endpointsOf, familyOf, inTerm } from '../src/families.js';

const config = JSON.parse(readFileSync(new URL('../families.json', import.meta.url)));
const detail = () =>
  JSON.parse(readFileSync(new URL('./fixtures/api/detail-oe-fix-18m-26-09-11.json', import.meta.url)));
const BASE = 'https://api.octopus.energy/v1/products';

test('familyOf returns the first matching family, else null', () => {
  assert.equal(familyOf('OE-FIX-18M-26-09-11', config.families).id, 'oe-fix-18m');
  assert.equal(familyOf('VAR-22-11-01', config.families).id, 'flexible');
  assert.equal(familyOf('AGILE-24-10-01', config.families), null);
  const two = [
    { id: 'a', match: '^X' },
    { id: 'b', match: '^X' },
  ];
  assert.equal(familyOf('X1', two).id, 'a');
});

test('endpointsOf on the OE-FIX-18M-26-09-11 fixture', () => {
  const eps = endpointsOf(detail(), config.regions).filter((e) => e.region === '_C');
  assert.deepEqual(
    eps.map((e) => [e.map, e.paymentKey, e.tariffCode, e.rel]),
    [
      ['single_register_electricity_tariffs', 'direct_debit_monthly', 'E-1R-OE-FIX-18M-26-09-11-C', 'standing_charges'],
      [
        'single_register_electricity_tariffs',
        'direct_debit_monthly',
        'E-1R-OE-FIX-18M-26-09-11-C',
        'standard_unit_rates',
      ],
      ['dual_register_electricity_tariffs', 'direct_debit_monthly', 'E-2R-OE-FIX-18M-26-09-11-C', 'standing_charges'],
      ['dual_register_electricity_tariffs', 'direct_debit_monthly', 'E-2R-OE-FIX-18M-26-09-11-C', 'day_unit_rates'],
      ['dual_register_electricity_tariffs', 'direct_debit_monthly', 'E-2R-OE-FIX-18M-26-09-11-C', 'night_unit_rates'],
      ['single_register_gas_tariffs', 'direct_debit_monthly', 'G-1R-OE-FIX-18M-26-09-11-C', 'standing_charges'],
      ['single_register_gas_tariffs', 'direct_debit_monthly', 'G-1R-OE-FIX-18M-26-09-11-C', 'standard_unit_rates'],
    ],
  );
  assert.equal(
    eps[1].href,
    `${BASE}/OE-FIX-18M-26-09-11/electricity-tariffs/E-1R-OE-FIX-18M-26-09-11-C/standard-unit-rates/`,
  );
  assert.equal(eps[6].href, `${BASE}/OE-FIX-18M-26-09-11/gas-tariffs/G-1R-OE-FIX-18M-26-09-11-C/standard-unit-rates/`);
  assert.equal(
    endpointsOf(detail(), { _C: 'London' }).every((e) => e.region === '_C'),
    true,
  );
  assert.equal(endpointsOf(detail(), config.regions).length, 14 * 7);
});

test('a dual-register tariff yields day and night rels and no standard one', () => {
  const rels = endpointsOf(detail(), ['_C'])
    .filter((e) => e.map === 'dual_register_electricity_tariffs')
    .map((e) => e.rel);
  assert.deepEqual(rels, ['standing_charges', 'day_unit_rates', 'night_unit_rates']);
});

const evDetail = () => ({
  code: 'IOG-X',
  four_rate_ev_electricity_tariffs: {
    _C: {
      direct_debit_monthly: {
        code: 'E-1R-IOG-X-C',
        standing_charge_exc_vat: 1,
        day_unit_rate_exc_vat: 1,
        night_unit_rate_exc_vat: 1,
        ev_device_peak_unit_rate_exc_vat: 1,
        ev_device_off_peak_unit_rate_exc_vat: 1,
        links: [
          'standing_charges',
          'day_unit_rates',
          'night_unit_rates',
          'ev_device_peak_unit_rates',
          'ev_device_off_peak_unit_rates',
        ].map((rel) => ({
          rel,
          method: 'GET',
          href: `${BASE}/IOG-X/electricity-tariffs/E-1R-IOG-X-C/${rel.replaceAll('_', '-')}/`,
        })),
      },
    },
  },
});

test('a four-rate EV tariff yields all five endpoints', () => {
  const eps = endpointsOf(evDetail(), ['_C']);
  assert.deepEqual(
    eps.map((e) => e.rel),
    [
      'standing_charges',
      'day_unit_rates',
      'night_unit_rates',
      'ev_device_peak_unit_rates',
      'ev_device_off_peak_unit_rates',
    ],
  );
  assert.equal(eps[4].href, `${BASE}/IOG-X/electricity-tariffs/E-1R-IOG-X-C/ev-device-off-peak-unit-rates/`);
  checkLinks(evDetail());
});

test('checkLinks accepts the live fixture and a different link order', () => {
  checkLinks(detail());
  const d = detail();
  d.single_register_electricity_tariffs._C.direct_debit_monthly.links.reverse();
  checkLinks(d);
});

test('checkLinks throws naming the tariff on a rel mismatch or an href mismatch', () => {
  const missing = detail();
  missing.dual_register_electricity_tariffs._C.direct_debit_monthly.links.pop();
  assert.throws(() => checkLinks(missing), /E-2R-OE-FIX-18M-26-09-11-C/);
  const extra = detail();
  extra.single_register_gas_tariffs._B.direct_debit_monthly.standard_unit_rate_exc_vat = 1;
  extra.single_register_gas_tariffs._B.direct_debit_monthly.day_unit_rate_exc_vat = 1;
  assert.throws(() => checkLinks(extra), /G-1R-OE-FIX-18M-26-09-11-B/);
  const href = detail();
  href.single_register_electricity_tariffs._A.direct_debit_monthly.links[0].href += 'x';
  assert.throws(() => checkLinks(href), /E-1R-OE-FIX-18M-26-09-11-A/);
});

test('inTerm for a fixed product is true through the last day of the term, false after', () => {
  const p = { term: 18, available_to: '2026-10-02T00:00:00+01:00' }; // UK day 2026-10-02, term ends 2028-04-02
  assert.equal(inTerm(p, '2028-04-02'), true);
  assert.equal(inTerm(p, '2028-04-03'), false);
  assert.equal(inTerm({ term: 12, available_to: null }, '2026-10-21'), true);
});

test('inTerm for a variable product is on sale only', () => {
  const v = (available_to) => ({ term: null, available_to });
  assert.equal(inTerm(v(null), '2026-10-21'), true);
  assert.equal(inTerm(v('2026-10-21T00:00:00+01:00'), '2026-10-21'), true);
  assert.equal(inTerm(v('2026-10-20T00:00:00+01:00'), '2026-10-21'), false);
});

test('a tariff listed under two payment keys yields each endpoint once', () => {
  const d = detail();
  const map = d.single_register_electricity_tariffs._C;
  map.varying = structuredClone(map.direct_debit_monthly);
  const eps = endpointsOf(d, ['_C']).filter((e) => e.map === 'single_register_electricity_tariffs');
  assert.deepEqual(
    eps.map((e) => e.rel),
    ['standing_charges', 'standard_unit_rates'],
  );
});
