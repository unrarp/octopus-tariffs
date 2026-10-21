import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daily } from '../src/series/stepped.js';

const DD = 'DIRECT_DEBIT';
const row = (valid_from, valid_to, value_exc_vat, payment_method = null) => ({
  valid_from,
  valid_to,
  payment_method,
  value_exc_vat,
  value_inc_vat: 0,
});
const opts = (o) => ({
  from: '2026-09-29',
  to: '2026-10-03',
  paymentMethod: DD,
  fuel: 'electricity',
  availableFrom: '2026-01-01',
  ...o,
});
const run = (unitRows, o, standingRows = []) => daily({ unitRows, standingRows }, opts(o));
const units = (out) => out.map((d) => d.unit);

test('BST start: valid_from 23:00Z the day before covers that UK day, not the previous one', () => {
  const out = run([row('2026-09-30T23:00:00Z', null, 10)], {});
  assert.deepEqual(
    out.map((d) => [d.day, d.unit]),
    [
      ['2026-09-29', null],
      ['2026-09-30', null],
      ['2026-10-01', 10], // electricity VAT 0 from 2026-10-01
      ['2026-10-02', 10],
    ],
  );
});

test('GMT start: valid_from 00:00Z covers that day, one second later does not', () => {
  const o = { from: '2026-01-01', to: '2026-01-03' };
  assert.deepEqual(units(run([row('2026-01-02T00:00:00Z', null, 10)], o)), [null, 10.5]);
  assert.deepEqual(units(run([row('2026-01-02T00:00:01Z', null, 10)], o)), [null, null]);
});

test('a valid_to at the next UK midnight excludes that day', () => {
  const rows = [row('2026-09-28T23:00:00Z', '2026-09-30T23:00:00Z', 10)];
  assert.deepEqual(units(run(rows, {})), [10.5, 10.5, null, null]);
});

test('a mid-term step switches on the day its row starts', () => {
  const rows = [row('2026-01-01T00:00:00Z', '2026-09-30T23:00:00Z', 20), row('2026-09-30T23:00:00Z', null, 30)];
  assert.deepEqual(units(run(rows, {})), [21, 21, 30, 30]);
});

test('the VAT step on 2026-10-01 hits electricity but not gas', () => {
  const rows = [row('2026-01-01T00:00:00Z', null, 10)];
  assert.deepEqual(units(run(rows, {})), [10.5, 10.5, 10, 10]);
  assert.deepEqual(units(run(rows, { fuel: 'gas' })), [10.5, 10.5, 10.5, 10.5]);
});

test('values are rounded to 4 dp and the standing charge gets the same treatment', () => {
  const out = run([row('2026-01-01T00:00:00Z', null, 25.7963)], { to: '2026-09-30' }, [
    row('2026-01-01T00:00:00Z', null, 39.5209),
  ]);
  assert.equal(out[0].unit, 27.0861); // 27.086115
  assert.equal(out[0].standingCharge, 41.4969); // 41.496945
});

test('payment-method filtering with interleaved rows keeps the configured method and null rows only', () => {
  const rows = [
    row('2026-01-01T00:00:00Z', '2026-09-30T23:00:00Z', 1, 'PREPAYMENT'),
    row('2026-01-01T00:00:00Z', '2026-09-30T23:00:00Z', 20, DD),
    row('2026-09-30T23:00:00Z', null, 2, 'PREPAYMENT'),
    row('2026-09-30T23:00:00Z', null, 30, DD),
  ];
  assert.deepEqual(units(run(rows, {})), [21, 21, 30, 30]);
  assert.deepEqual(units(run([row('2026-01-01T00:00:00Z', null, 10, 'PREPAYMENT')], {})), [null, null, null, null]);
});

test('a null valid_from reads as availableFrom', () => {
  assert.deepEqual(units(run([row(null, null, 10)], { availableFrom: '2026-09-30' })), [null, 10.5, 10, 10]);
});

test('days with no covering row are null per metric, one entry per day in [from, to)', () => {
  const out = run([row('2026-09-30T23:00:00Z', null, 10)], {});
  assert.equal(out.length, 4);
  assert.ok(out.every((d) => d.standingCharge === null));
  assert.deepEqual(run([], { from: '2026-10-01', to: '2026-10-01' }), []);
});
