// Regenerates test/fixtures/build/data/ by running collect() against a synthetic API world, so the build is tested
// on exactly what collect writes. Run: node test/fixtures/build/generate.js (output is checked in).
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../../../src/collect.js';
import { ukDay, ukMidnight } from '../../../src/days.js';
import { vat } from '../../../src/vat.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-10-21T06:00:00.000Z';
const BASE = 'https://api.octopus.energy/v1';
const DD = 'DIRECT_DEBIT';
const NDD = 'NON_DIRECT_DEBIT';

/** The API's instant for the start of UK day `day`. */
const at = (day) => new Date(ukMidnight(day)).toISOString().replace('.000Z', 'Z');

/**
 * Rows oldest first from steps [[fromDay|null, exc], ...]. Each row closes where the next step (same payment method) begins
 * unless it is the last or `closeLast` gives its end day. The API's inc VAT is priced at the row's last day, or today when open.
 */
function rows(fuel, steps, { pm = null, closeLast = null } = {}) {
  return steps.map(([from, exc], i) => {
    const toDay = steps[i + 1]?.[0] ?? closeLast;
    const to = toDay ? at(toDay) : null;
    const pricedOn = to ? ukDay(new Date(Date.parse(to) - 1).toISOString()) : ukDay(NOW);
    return {
      value_exc_vat: exc,
      value_inc_vat: Math.round(exc * (1 + vat(fuel, pricedOn)) * 1e6) / 1e6,
      valid_from: from ? at(from) : null,
      valid_to: to,
      payment_method: pm,
    };
  });
}

/** Direct-debit and non-direct-debit rows interleaved oldest first, the non-direct-debit rate 1 higher. */
function twoMethods(fuel, steps) {
  const dd = rows(fuel, steps, { pm: DD });
  const ndd = rows(
    fuel,
    steps.map(([d, v]) => [d, v + 1]),
    { pm: NDD },
  );
  return dd.flatMap((r, i) => [r, ndd[i]]);
}

/** A product: list fields plus, per region, per fuel, {unit, standing} rate rows (oldest first). */
const PRODUCTS = [
  {
    code: 'OE-FIX-12M-25-10-01',
    full_name: 'Octopus 12M Fixed October 2025 v1',
    term: 12,
    from: '2025-10-01',
    to: '2025-12-01',
    exit: 7500,
    key: 'direct_debit_monthly',
    regions: {
      // A mid-term step on 2026-03-31, and a second row that spans the 2026-10-01 VAT step (priced at the later 0 %).
      _C: {
        electricity: {
          unit: rows('electricity', [['2025-10-01', 22.0], ['2026-03-31', 19.5]], { closeLast: '2026-10-11' }),
          standing: rows('electricity', [['2025-10-01', 40.0]]),
        },
        gas: { unit: rows('gas', [['2025-10-01', 6.8]]), standing: rows('gas', [['2025-10-01', 29.0]]) },
      },
      _G: {
        electricity: {
          unit: rows('electricity', [['2025-10-01', 23.0], ['2026-03-31', 20.5]], { closeLast: '2026-10-11' }),
          standing: rows('electricity', [['2025-10-01', 40.5]]),
        },
        gas: { unit: rows('gas', [['2025-10-01', 7.1]]), standing: rows('gas', [['2025-10-01', 29.3]]) },
      },
    },
  },
  {
    // The only electricity unit row has a null valid_from: it reads as the product's available_from.
    code: 'OE-FIX-12M-26-01-15',
    full_name: 'Octopus 12M Fixed January 2026 v1',
    term: 12,
    from: '2026-01-15',
    to: '2026-03-01',
    exit: 7500,
    key: 'direct_debit_monthly',
    regions: {
      _C: {
        electricity: { unit: rows('electricity', [[null, 21.0]]), standing: rows('electricity', [['2026-01-15', 41.0]]) },
        gas: { unit: rows('gas', [['2026-01-15', 7.2]]), standing: rows('gas', [['2026-01-15', 29.5]]) },
      },
      _G: {
        electricity: { unit: rows('electricity', [[null, 22.0]]), standing: rows('electricity', [['2026-01-15', 41.5]]) },
        gas: { unit: rows('gas', [['2026-01-15', 7.5]]), standing: rows('gas', [['2026-01-15', 29.8]]) },
      },
    },
  },
  {
    // The head, on sale after a gap since version 2; sold in London only, so off sale in region G.
    code: 'OE-FIX-12M-26-05-10',
    full_name: 'Octopus 12M Fixed May 2026 v1',
    term: 12,
    from: '2026-05-10',
    to: null,
    exit: 7500,
    key: 'direct_debit_monthly',
    regions: {
      _C: {
        electricity: { unit: rows('electricity', [['2026-05-10', 28.0]]), standing: rows('electricity', [['2026-05-10', 41.4]]) },
        gas: { unit: rows('gas', [['2026-05-10', 9.3]]), standing: rows('gas', [['2026-05-10', 29.2]]) },
      },
    },
  },
  {
    // Seasonal and London only: it ended 2026-04-01 and never had a region G tariff.
    code: 'OE-FIX-6M-25-10-01',
    full_name: 'Octopus 6M Winter Fix October 2025 v1',
    term: 6,
    from: '2025-10-01',
    to: '2026-04-01',
    exit: 7500,
    key: 'direct_debit_monthly',
    regions: {
      _C: {
        electricity: { unit: rows('electricity', [['2025-10-01', 24.0]]), standing: rows('electricity', [['2025-10-01', 42.0]]) },
        gas: { unit: rows('gas', [['2025-10-01', 7.5]]), standing: rows('gas', [['2025-10-01', 29.7]]) },
      },
    },
  },
  {
    // Version 1 of Flexible (keyed direct_debit_monthly, as the stored products before VAR-22-11-01 are; version 2 is keyed varying): 3 steps between its launch and version 2's, and available_to after the hand-over, so
    // version 2 supplies the family line from 2025-12-15 although version 1 keeps stepping.
    code: 'VAR-25-01-01',
    full_name: 'Flexible Octopus January 2025 v1',
    term: null,
    from: '2025-01-01',
    to: '2026-02-01',
    exit: 0,
    key: 'direct_debit_monthly',
    regions: {
      _C: {
        electricity: {
          unit: twoMethods('electricity', [['2025-01-01', 30.0], ['2025-04-01', 28.0], ['2025-07-01', 26.0], ['2025-10-01', 27.0], ['2026-01-01', 29.0]]),
          standing: twoMethods('electricity', [['2025-01-01', 50.0], ['2025-07-01', 51.0], ['2026-01-01', 52.0]]),
        },
        gas: {
          unit: twoMethods('gas', [['2025-01-01', 8.0], ['2025-07-01', 7.5], ['2026-01-01', 7.9]]),
          standing: twoMethods('gas', [['2025-01-01', 29.0]]),
        },
      },
      _G: {
        electricity: {
          unit: twoMethods('electricity', [['2025-01-01', 31.0], ['2025-04-01', 29.0], ['2025-07-01', 27.0], ['2025-10-01', 28.0], ['2026-01-01', 30.0]]),
          standing: twoMethods('electricity', [['2025-01-01', 50.5], ['2025-07-01', 51.5], ['2026-01-01', 52.5]]),
        },
        gas: {
          unit: twoMethods('gas', [['2025-01-01', 8.3], ['2025-07-01', 7.8], ['2026-01-01', 8.2]]),
          standing: twoMethods('gas', [['2025-01-01', 29.4]]),
        },
      },
    },
  },
  {
    code: 'VAR-25-12-15',
    full_name: 'Flexible Octopus December 2025 v2',
    term: null,
    from: '2025-12-15',
    to: null,
    exit: 0,
    key: 'varying',
    regions: {
      _C: {
        electricity: {
          unit: twoMethods('electricity', [['2025-12-15', 27.5], ['2026-01-01', 29.5], ['2026-04-01', 25.0], ['2026-07-01', 26.5], ['2026-10-01', 26.6]]),
          standing: twoMethods('electricity', [['2025-12-15', 50.5], ['2026-01-01', 52.5], ['2026-10-01', 41.4]]),
        },
        gas: {
          unit: twoMethods('gas', [['2025-12-15', 8.1], ['2026-01-01', 8.2], ['2026-04-01', 7.0], ['2026-07-01', 7.3], ['2026-10-01', 7.6]]),
          standing: twoMethods('gas', [['2025-12-15', 29.1]]),
        },
      },
      _G: {
        electricity: {
          unit: twoMethods('electricity', [['2025-12-15', 28.5], ['2026-01-01', 30.5], ['2026-04-01', 26.0], ['2026-07-01', 27.5], ['2026-10-01', 27.6]]),
          standing: twoMethods('electricity', [['2025-12-15', 51.0], ['2026-01-01', 53.0], ['2026-10-01', 41.9]]),
        },
        gas: {
          unit: twoMethods('gas', [['2025-12-15', 8.4], ['2026-01-01', 8.5], ['2026-04-01', 7.3], ['2026-07-01', 7.6], ['2026-10-01', 7.9]]),
          standing: twoMethods('gas', [['2025-12-15', 29.5]]),
        },
      },
    },
  },
];

const MAPS = {
  electricity: ['single_register_electricity_tariffs', 'E-1R-', 'standard_unit_rates'],
  gas: ['single_register_gas_tariffs', 'G-1R-', 'standard_unit_rates'],
};

/** The fake API: list rows, details and rate endpoints built from PRODUCTS. */
function world() {
  const list = [];
  const details = {};
  const rates = {};
  for (const p of PRODUCTS) {
    const listRow = {
      code: p.code,
      full_name: p.full_name,
      brand: 'OCTOPUS_ENERGY',
      term: p.term,
      is_variable: p.term === null,
      available_from: `${at(p.from).slice(0, 19)}Z`,
      available_to: p.to ? at(p.to) : null,
      links: [{ href: `${BASE}/products/${p.code}/`, method: 'GET', rel: 'self' }],
    };
    list.push(listRow);
    const detail = { ...listRow, tariffs_active_at: NOW };
    for (const [region, fuels] of Object.entries(p.regions)) {
      for (const [fuel, { unit, standing }] of Object.entries(fuels)) {
        const [map, prefix, unitRel] = MAPS[fuel];
        const tariffCode = `${prefix}${p.code}-${region.slice(1)}`;
        const href = (rel) => `${BASE}/products/${p.code}/${fuel}-tariffs/${tariffCode}/${rel.replaceAll('_', '-')}/`;
        detail[map] ??= {};
        detail[map][region] = {
          [p.key]: {
            code: tariffCode,
            standard_unit_rate_exc_vat: unit.at(-1).value_exc_vat,
            standing_charge_exc_vat: standing.at(-1).value_exc_vat,
            exit_fees_exc_vat: p.exit,
            exit_fees_inc_vat: p.exit,
            exit_fees_type: 'FLAT',
            links: ['standing_charges', unitRel].map((rel) => ({ href: href(rel), method: 'GET', rel })),
          },
        };
        rates[href(unitRel)] = unit;
        rates[href('standing_charges')] = standing;
      }
    }
    details[p.code] = detail;
  }
  const fetch = async (url) => {
    const body = (b) => ({ ok: true, status: 200, json: async () => structuredClone(b) });
    if (url === `${BASE}/products/?page_size=200`) return body({ next: null, results: list });
    if (url === `${BASE}/products/?page_size=200&is_historical=true`) return body({ next: null, results: [] });
    const code = /\/products\/([^/]+)\/$/.exec(url)?.[1];
    if (code && details[code]) return body(details[code]);
    const href = url.replace(/\?page_size=1500$/, '');
    if (href in rates) return body({ next: null, results: [...rates[href]].reverse() });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch };
}

rmSync(join(ROOT, 'data'), { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
await collect({
  root: ROOT,
  fetch: world().fetch,
  retryOpts: { attempts: 1, delays: [0] },
  now: NOW,
});
