import assert from 'node:assert/strict';
import { test } from 'node:test';
import { vat, vatPeriodsBetween } from '../src/vat.js';

test('electricity VAT is 5% to 2026-09-30, 0% from 2026-10-01 to 2027-03-31, 5% from 2027-04-01', () => {
  assert.equal(vat('electricity', '2023-07-01'), 0.05);
  assert.equal(vat('electricity', '2026-09-30'), 0.05);
  assert.equal(vat('electricity', '2026-10-01'), 0);
  assert.equal(vat('electricity', '2027-03-31'), 0);
  assert.equal(vat('electricity', '2027-04-01'), 0.05);
});

test('gas VAT is 5% throughout', () => {
  for (const day of ['2020-01-01', '2026-09-30', '2026-10-01', '2027-03-31', '2027-04-01']) {
    assert.equal(vat('gas', day), 0.05);
  }
});

test('an unknown fuel throws', () => {
  assert.throws(() => vat('coal', '2026-01-01'), /unknown fuel/);
});

test('vatPeriodsBetween lists the periods overlapping [from, to)', () => {
  assert.deepEqual(vatPeriodsBetween('electricity', '2026-09-01', '2026-10-01'), ['0000-01-01']); // ends before the step
  assert.deepEqual(vatPeriodsBetween('electricity', '2026-09-30', '2026-10-02'), ['0000-01-01', '2026-10-01']);
  assert.deepEqual(vatPeriodsBetween('electricity', '2026-10-01', '2027-04-01'), ['2026-10-01']); // exactly the zero period
  assert.deepEqual(vatPeriodsBetween('electricity', '2027-03-31', '2027-04-02'), ['2026-10-01', '2027-04-01']);
  assert.deepEqual(vatPeriodsBetween('electricity', '2027-04-01', '2028-01-01'), ['2027-04-01']);
  assert.equal(vatPeriodsBetween('electricity', '2025-01-01', '2028-01-01').length, 3);
  assert.equal(vatPeriodsBetween('gas', '2025-01-01', '2028-01-01').length, 1);
});
