/** Each fuel's VAT schedule (PLAN.md §1): the rate in force from each start day, oldest first; the first applies to all earlier days. */
const SCHEDULE = {
  electricity: [
    { from: '0000-01-01', rate: 0.05 },
    { from: '2026-10-01', rate: 0 }, // temporary zero rate
    { from: '2027-04-01', rate: 0.05 },
  ],
  gas: [{ from: '0000-01-01', rate: 0.05 }],
};

/** The schedule entries of `fuel`; throws on an unknown fuel. */
function periodsOf(fuel) {
  const periods = SCHEDULE[fuel];
  if (!periods) throw new Error(`unknown fuel ${JSON.stringify(fuel)}`);
  return periods;
}

/** The VAT rate (0.05 or 0) on a UK day (YYYY-MM-DD) for `fuel`. */
export function vat(fuel, day) {
  return periodsOf(fuel).findLast((p) => p.from <= day).rate;
}

/** The start days of the VAT periods that overlap `[fromDay, toDay)`; one entry means the span lies inside one period. */
export function vatPeriodsBetween(fuel, fromDay, toDay) {
  const periods = periodsOf(fuel);
  return periods
    .filter((p, i) => p.from < toDay && (i + 1 === periods.length || periods[i + 1].from > fromDay))
    .map((p) => p.from);
}
