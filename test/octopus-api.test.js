import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { listProducts, productDetail, rateRows } from '../src/adapters/octopus-api.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/api/${name}.json`, import.meta.url), 'utf8'));
const retryOpts = { attempts: 3, delays: [0, 0] };

/** A fetch answering from a url -> body map; records every requested url. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (!(url in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(routes[url]) };
  };
  return { fetch, calls };
}

const RATES = 'https://api.octopus.energy/v1/products/P/electricity-tariffs/E-1R-P-C/standard-unit-rates/';
const row = (from) => ({ value_exc_vat: 1, value_inc_vat: 1, valid_from: from, valid_to: null, payment_method: null });

test('listProducts follows next across pages', async () => {
  const p1 = fx('products-page1');
  const p2 = fx('products-page2');
  const { fetch, calls } = fakeFetch({
    'https://api.octopus.energy/v1/products/?page_size=200': p1,
    [p1.next]: p2,
  });
  const rows = await listProducts({ fetch, retryOpts });
  assert.deepEqual(rows, [...p1.results, ...p2.results]);
  assert.equal(calls.length, 2);
});

test('listProducts historical asks for is_historical', async () => {
  const p2 = fx('products-page2');
  const { fetch, calls } = fakeFetch({
    'https://api.octopus.energy/v1/products/?page_size=200&is_historical=true': p2,
  });
  await listProducts({ historical: true, fetch, retryOpts });
  assert.match(calls[0], /is_historical=true/);
});

test('productDetail fetches the product URL', async () => {
  const d = fx('detail-oe-fix-18m-26-09-11');
  const { fetch, calls } = fakeFetch({ 'https://api.octopus.energy/v1/products/OE-FIX-18M-26-09-11/': d });
  assert.deepEqual(await productDetail('OE-FIX-18M-26-09-11', { fetch, retryOpts }), d);
  assert.equal(calls.length, 1);
});

test('rateRows requests page_size=1500, follows next and returns oldest first across pages', async () => {
  const page2 = { count: 4, next: null, previous: null, results: [row('2023-01-01'), row('2022-01-01')] };
  const page1 = {
    count: 4,
    next: `${RATES}?page=2&page_size=1500`,
    previous: null,
    results: [row('2025-01-01'), row('2024-01-01')],
  };
  const { fetch, calls } = fakeFetch({ [`${RATES}?page_size=1500`]: page1, [page1.next]: page2 });
  const rows = await rateRows(RATES, { fetch, retryOpts });
  assert.deepEqual(
    rows.map((r) => r.valid_from),
    ['2022-01-01', '2023-01-01', '2024-01-01', '2025-01-01'],
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0], /page_size=1500/);
});

test('rateRows on a single fixture page returns it oldest first', async () => {
  const f = fx('oe-fix-12m-25-10-01-c-standard-unit-rates');
  const { fetch } = fakeFetch({ [`${RATES}?page_size=1500`]: f });
  const rows = await rateRows(RATES, { fetch, retryOpts });
  assert.deepEqual(rows, [...f.results].reverse());
  assert.ok(rows[0].valid_from < rows[1].valid_from);
});

test('a thrown fetch is retried', async () => {
  const d = fx('detail-oe-fix-18m-26-09-11');
  let n = 0;
  const fetch = async () => {
    if (++n < 3) throw new Error('network down');
    return { ok: true, status: 200, json: async () => d };
  };
  assert.deepEqual(await productDetail('X', { fetch, retryOpts }), d);
  assert.equal(n, 3);
});

test('a non-OK response throws after retries', async () => {
  let n = 0;
  const fetch = async () => {
    n++;
    return { ok: false, status: 500, json: async () => ({}) };
  };
  await assert.rejects(productDetail('X', { fetch, retryOpts }), /HTTP 500/);
  assert.equal(n, 3);
});

test('detail fixture: tariff maps keyed region then payment key, links rels present', () => {
  const d = fx('detail-oe-fix-18m-26-09-11');
  const t = d.single_register_electricity_tariffs._C.direct_debit_monthly;
  assert.equal(t.code, 'E-1R-OE-FIX-18M-26-09-11-C');
  assert.equal(t.standard_unit_rate_inc_vat, 25.7963);
  assert.equal(t.standing_charge_inc_vat, 39.5209);
  assert.deepEqual(t.links.map((l) => l.rel).sort(), ['standard_unit_rates', 'standing_charges']);
  const g = d.single_register_gas_tariffs._C.direct_debit_monthly;
  assert.match(g.code, /^G-1R-/);
  assert.ok(g.links.some((l) => l.rel === 'standing_charges'));
  assert.ok('tariffs_active_at' in d);
});

test('list fixtures: rows carry the list fields and page 1 links to page 2', () => {
  const p1 = fx('products-page1');
  assert.equal(p1.results.length, 5);
  assert.ok(p1.next);
  assert.equal(fx('products-page2').next, null);
  for (const r of p1.results) {
    for (const k of [
      'code',
      'full_name',
      'brand',
      'term',
      'is_variable',
      'available_from',
      'available_to',
      'direction',
    ]) {
      assert.ok(k in r, k);
    }
  }
});

test('rate fixtures: row shape, variable has both payment methods, fixed has 2 rows', () => {
  const keys = ['value_exc_vat', 'value_inc_vat', 'valid_from', 'valid_to', 'payment_method'];
  const names = [
    'var-22-11-01-c-standard-unit-rates',
    'var-22-11-01-c-standing-charges',
    'oe-fix-12m-25-10-01-c-standard-unit-rates',
  ];
  for (const n of names) {
    const f = fx(n);
    assert.ok('count' in f && 'next' in f);
    for (const r of f.results) assert.deepEqual(Object.keys(r), keys);
  }
  const v = fx('var-22-11-01-c-standard-unit-rates');
  assert.deepEqual([...new Set(v.results.map((r) => r.payment_method))].sort(), ['DIRECT_DEBIT', 'NON_DIRECT_DEBIT']);
  assert.equal(fx('oe-fix-12m-25-10-01-c-standard-unit-rates').results.length, 2);
});
