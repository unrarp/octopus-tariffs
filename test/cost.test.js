import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annualCost, TDCV } from '../src/site/lib/cost.js';

test('annualCost is (unit x kWh + standing x 365) / 100 in pounds', () => {
  assert.equal(annualCost({ unit: 10, standingCharge: 20 }, 1000), (10 * 1000 + 20 * 365) / 100);
  assert.equal(annualCost({ unit: 0, standingCharge: 0 }, 1000), 0);
});

test('annualCost at TDCV: 2,500 kWh electricity and 9,500 kWh gas on live sample values (OE-FIX-18M-26-09-11, region C)', () => {
  assert.equal(Math.round(annualCost({ unit: 25.7963, standingCharge: 39.5209 }, 2500) * 100) / 100, 789.16);
  assert.equal(Math.round(annualCost({ unit: 8.450085, standingCharge: 29.38383 }, 9500) * 100) / 100, 910.01);
});

test('annualCost is null when the unit, standing charge or kWh is null', () => {
  assert.equal(annualCost({ unit: null, standingCharge: 40 }, 2500), null);
  assert.equal(annualCost({ unit: 25, standingCharge: null }, 2500), null);
  assert.equal(annualCost({ unit: 25, standingCharge: 40 }, null), null);
});

test('TDCV is the revised Ofgem pair, 2,500 kWh electricity and 9,500 kWh gas', () => {
  assert.deepEqual(TDCV, { electricity: 2500, gas: 9500 });
});
