import { addMonths, ukDay } from './days.js';

const BASE = 'https://api.octopus.energy/v1';
const MAPS = {
  single_register_electricity_tariffs: 'electricity',
  dual_register_electricity_tariffs: 'electricity',
  four_rate_ev_electricity_tariffs: 'electricity',
  single_register_gas_tariffs: 'gas',
};

/** The first family whose `match` regex matches the product code, else null. */
export function familyOf(code, families) {
  return families.find((f) => new RegExp(f.match).test(code)) ?? null;
}

/** The rate-endpoint rels of a tariff: standing_charges plus <x>_unit_rates per <x>_unit_rate_exc_vat field. */
function relsOf(tariff) {
  const rels = Object.keys(tariff).flatMap((k) => {
    const m = /^(.+)_unit_rate_exc_vat$/.exec(k);
    return m ? [`${m[1]}_unit_rates`] : [];
  });
  return ['standing_charges', ...rels];
}

/** Every tariff in the detail's maps for the given region keys, with its map, region and payment key. */
function* tariffsOf(detail, regionKeys) {
  for (const map of Object.keys(MAPS)) {
    for (const region of regionKeys) {
      for (const [paymentKey, tariff] of Object.entries(detail[map]?.[region] ?? {})) {
        yield { region, map, paymentKey, tariff };
      }
    }
  }
}

/** The endpoint ({region, map, paymentKey, tariffCode, rel, href}) for one rel of a tariff. */
function endpoint(detail, { region, map, paymentKey, tariff }, rel) {
  const href = `${BASE}/products/${detail.code}/${MAPS[map]}-tariffs/${tariff.code}/${rel.replaceAll('_', '-')}/`;
  return { region, map, paymentKey, tariffCode: tariff.code, rel, href };
}

/** Every rate endpoint of the detail's tariffs in the given regions (an object keyed by region, or an array of keys). */
export function endpointsOf(detail, regions) {
  const keys = Array.isArray(regions) ? regions : Object.keys(regions);
  return [...tariffsOf(detail, keys)].flatMap((t) => relsOf(t.tariff).map((rel) => endpoint(detail, t, rel)));
}

/** Throws, naming the tariff, unless every tariff's derived rels and hrefs equal its live `links` exactly. */
export function checkLinks(detail) {
  const keys = new Set(Object.keys(MAPS).flatMap((m) => Object.keys(detail[m] ?? {})));
  for (const t of tariffsOf(detail, keys)) {
    const derived = relsOf(t.tariff).map((rel) => [rel, endpoint(detail, t, rel).href]);
    const live = (t.tariff.links ?? []).map((l) => [l.rel, l.href]);
    const sorted = (a) => JSON.stringify([...a].sort());
    if (sorted(derived) !== sorted(live)) {
      throw new Error(
        `${t.tariff.code}: links differ from derived endpoints: derived ${sorted(derived)}, live ${sorted(live)}`,
      );
    }
  }
}

/** Whether a product is on sale or within its term on `today` (YYYY-MM-DD); variable products are on sale only. */
export function inTerm(product, today) {
  const to = product.available_to ? ukDay(product.available_to) : null;
  if (product.term == null) return to === null || to >= today;
  return addMonths(to ?? today, product.term) >= today;
}
