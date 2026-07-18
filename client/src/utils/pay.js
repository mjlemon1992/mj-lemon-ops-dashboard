// Crew paid hours for a pay period — THE payroll formula, computed in one
// place for the Time Clock summary strip and the Home hero band alike:
// clocked + stat pay × headcount + paid holiday hours.
export function crewPaidHours(entriesPayload, headcount) {
  if (!entriesPayload) return null;
  const clocked = Object.values(entriesPayload.summary || {}).reduce((a, v) => a + Number(v || 0), 0);
  const hol = Object.values(entriesPayload.paid_timeoff_hours || {}).reduce((a, v) => a + Number(v || 0), 0);
  const stat = Number(entriesPayload.stat_pay_hours || 0) * (headcount || 0);
  return Math.round((clocked + stat + hol) * 100) / 100;
}
