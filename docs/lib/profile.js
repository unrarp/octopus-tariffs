/**
 * Monthly shares of annual kWh, Jan to Dec, per fuel; each array sums to 1. Electricity: Elexon Profile Class 1
 * half-hourly demand, Apr 2025 to Mar 2026, summed per month, from Ofgem's cap "Supplementary workbook to annex 2, 3
 * and 4 - demand and losses" v1.19 (one weather year). Gas: Xoserve Annual Load Profile for gas year 2026-27, EUC
 * E2601BND (domestic, non-prepayment), daily ALP summed per month, unweighted mean over the 13 mainland LDZs.
 */
export const SHARES = {
  electricity: [0.1047, 0.0902, 0.0913, 0.0785, 0.0743, 0.0673, 0.0692, 0.0702, 0.0749, 0.0823, 0.0948, 0.1023],
  gas: [0.167, 0.1449, 0.1296, 0.0832, 0.0441, 0.0239, 0.0168, 0.0166, 0.0277, 0.0686, 0.1204, 0.1572],
};

/** Days in a month (1-12) of a year, Gregorian. */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** kWh used on a UK calendar day `YYYY-MM-DD`: annualKwh x the month's share / days in that month. */
export function dailyKwh(fuel, annualKwh, day) {
  const shares = SHARES[fuel];
  if (!shares) throw new Error(`unknown fuel ${fuel}`);
  const [year, month] = day.split('-').map(Number);
  return (annualKwh * shares[month - 1]) / daysInMonth(year, month);
}
