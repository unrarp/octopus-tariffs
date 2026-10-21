import { dayRange, ukMidnight } from '../days.js';
import { vat } from '../vat.js';

/** The value_exc_vat of the row covering instant `ms`, among rows of `paymentMethod` or null; null when none does. */
function pick(rows, ms, paymentMethod, availableFrom) {
  let found = null;
  for (const r of rows) {
    if (r.payment_method !== null && r.payment_method !== paymentMethod) continue;
    const start = r.valid_from == null ? ukMidnight(availableFrom) : Date.parse(r.valid_from);
    const end = r.valid_to == null ? Number.POSITIVE_INFINITY : Date.parse(r.valid_to);
    if (start <= ms && ms < end) found = r;
  }
  return found?.value_exc_vat ?? null;
}

/** `exc` with VAT for `fuel` on `day`, rounded to 4 dp; null stays null. */
function incVat(exc, fuel, day) {
  return exc === null ? null : Math.round(exc * (1 + vat(fuel, day)) * 1e4) / 1e4;
}

/** One {day, unit, standingCharge} per UK day in [from, to): the exc-VAT row in force at that day's UK midnight, plus VAT (PLAN.md §4.2). */
export function daily({ unitRows, standingRows }, { from, to, paymentMethod, fuel, availableFrom }) {
  return dayRange(from, to).map((day) => {
    const ms = ukMidnight(day);
    return {
      day,
      unit: incVat(pick(unitRows, ms, paymentMethod, availableFrom), fuel, day),
      standingCharge: incVat(pick(standingRows, ms, paymentMethod, availableFrom), fuel, day),
    };
  });
}
