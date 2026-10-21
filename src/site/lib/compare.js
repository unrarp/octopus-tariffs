import { annualCost } from './cost.js';
import { dailyKwh } from './profile.js';

/** Earliest comparison start: before this the Energy Price Guarantee applied (PLAN.md section 1). */
export const MIN_START = '2023-07-01';

const DAY_MS = 86400000;
const toMs = (day) => Date.parse(`${day}T00:00:00Z`);
const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const priced = (r) => r && r.unit != null && r.standingCharge != null;

/** Series for one tariff from a family-file fuel object ({days, versions:{code:{days}}}) and a version code. */
export function versionSeries(kind, familyFuel, code) {
  const v = familyFuel.versions[code];
  if (!v) throw new Error(`no rates for version ${code}`);
  return { kind, own: v.days, family: familyFuel.days };
}

/** Series for the price cap from the cap file's fuel object; the cap has no family to fall back on. */
export function capSeries(capFuel) {
  return { kind: 'cap', own: capFuel.days, family: [] };
}

/** Rate resolver for a series: day -> {unit, standingCharge} or null when no basis prices that day. */
function resolver({ kind, own, family }) {
  const ownBy = new Map(own.map((r) => [r.day, r]));
  const famBy = new Map(family.map((r) => [r.day, r]));
  const firstDay = own.length ? own[0].day : null;
  const firstPriced = own.find(priced) ?? null;
  return (day) => {
    let r;
    if (firstDay !== null && day >= firstDay) r = ownBy.get(day);
    else if (kind === 'fixed') r = firstPriced;
    else r = famBy.get(day);
    return priced(r) ? r : null;
  };
}

/**
 * Cost in pounds of one fuel for each day in [start, cutoff) at the rates the tariff would have charged,
 * seasonal usage from profile.js. Days with no rate are listed in `unpriced` and add nothing to `cost`.
 */
export function costSince(series, start, cutoff, fuel, annualKwh) {
  if (start < MIN_START) throw new Error(`start ${start} is before ${MIN_START}`);
  const rateOn = resolver(series);
  const unpriced = [];
  let pence = 0;
  let days = 0;
  for (let t = toMs(start); t < toMs(cutoff); t += DAY_MS) {
    days++;
    const day = toDay(t);
    const r = rateOn(day);
    if (!r) unpriced.push(day);
    else if (annualKwh != null) pence += dailyKwh(fuel, annualKwh, day) * r.unit + r.standingCharge;
  }
  return { cost: annualKwh == null ? null : pence / 100, days, unpriced };
}

/** £ for a full year at the rates in force on `day`; null when that day has no rate or kWh is null. */
export function annualAt(series, day, annualKwh) {
  const r = resolver(series)(day);
  return r ? annualCost(r, annualKwh) : null;
}
