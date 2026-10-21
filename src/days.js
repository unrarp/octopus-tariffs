const UK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The UK-local calendar day (YYYY-MM-DD) of an ISO instant. */
export function ukDay(iso) {
  const p = Object.fromEntries(UK.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** A YYYY-MM-DD string `n` days later (earlier when negative), by UTC arithmetic. */
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A YYYY-MM-DD string `n` calendar months later, the day of month clamped to the target month's length. */
export function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m + n, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** Every day from `from` up to but excluding `to`. */
export function dayRange(from, to) {
  const out = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}
