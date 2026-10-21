/** Ofgem Typical Domestic Consumption Values (kWh a year) as revised on 2026-07-01 (PLAN.md section 1, You row). */
export const TDCV = { electricity: 2500, gas: 9500 };

/** Estimated £ a year: (unit p/kWh × kWh + standing p/day × 365) / 100; null when the unit, standing charge or kWh is null. */
export function annualCost({ unit, standingCharge }, kWhPerYear) {
  if (unit == null || standingCharge == null || kWhPerYear == null) return null;
  return (unit * kWhPerYear + standingCharge * 365) / 100;
}
