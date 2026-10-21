import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyKwh, SHARES } from '../src/site/lib/profile.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('each fuel has twelve monthly shares summing to 1', () => {
  for (const fuel of ['electricity', 'gas']) {
    assert.equal(SHARES[fuel].length, 12);
    assert.ok(Math.abs(sum(SHARES[fuel]) - 1) < 1e-9, fuel);
  }
});

test('January gas share exceeds July', () => {
  assert.ok(SHARES.gas[0] > SHARES.gas[6]);
});

test('dailyKwh is share / days in month, and sums to the annual kWh over a calendar year (leap and not)', () => {
  assert.ok(Math.abs(dailyKwh('gas', 9500, '2026-01-10') - (9500 * 0.167) / 31) < 1e-12);
  assert.ok(Math.abs(dailyKwh('electricity', 2500, '2028-02-10') - (2500 * 0.0902) / 29) < 1e-12);
  for (const [year, n] of [
    [2026, 365],
    [2028, 366],
  ]) {
    for (const fuel of ['electricity', 'gas']) {
      let total = 0;
      for (let i = 0; i < n; i++)
        total += dailyKwh(fuel, 3000, new Date(Date.UTC(year, 0, 1 + i)).toISOString().slice(0, 10));
      assert.ok(Math.abs(total - 3000) < 1e-6, `${fuel} ${year}`);
    }
  }
});
