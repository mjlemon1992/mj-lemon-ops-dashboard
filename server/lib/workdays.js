// Server-side working-day + available-hours math, province-aware.
// Mirrors client/src/utils/pace.js so revenue pace and tech efficiency use the
// SAME definition of a "working day" (Mon-Fri minus that province's statutory
// holidays). Available hours = (weekly hours / 5) per working day elapsed, so
// efficiency = hours_sold / available_hours measures sold work against the
// ~40h/week a tech is on the clock, net of stat holidays (per Jamie's def).

const HOLIDAYS = {
  ab: {
    2026: [
      '2026-01-01', '2026-02-16', '2026-04-03', '2026-05-18', '2026-07-01',
      '2026-09-07', '2026-10-12', '2026-11-11', '2026-12-25', '2026-12-28'
    ]
  },
  bc: {
    2026: [
      '2026-01-01', '2026-02-16', '2026-04-03', '2026-05-18', '2026-07-01',
      '2026-08-03', '2026-09-07', '2026-09-30', '2026-10-12', '2026-11-11',
      '2026-12-25', '2026-12-28'
    ]
  }
};

function holidaySet(province, year) {
  const prov = (province || 'ab').toLowerCase();
  const list = (HOLIDAYS[prov] && HOLIDAYS[prov][year]) || (HOLIDAYS.ab[year] || []);
  return new Set(list);
}

// Count Mon-Fri days in [fromDay..toDay] (inclusive) that aren't holidays.
function countWorkingDays(year, month, fromDay, toDay, hols) {
  let n = 0;
  for (let d = fromDay; d <= toDay; d++) {
    const dt = new Date(year, month, d);
    const dow = dt.getDay();
    if (dow === 0 || dow === 6) continue;
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (hols.has(iso)) continue;
    n++;
  }
  return n;
}

// Working days elapsed so far this month (incl. today), province-aware.
function workingDaysElapsed(province, today = new Date()) {
  const year = today.getFullYear();
  const month = today.getMonth();
  const hols = holidaySet(province, year);
  return countWorkingDays(year, month, 1, today.getDate(), hols);
}

// Total working days in the current month, province-aware.
function workingDaysInMonth(province, today = new Date()) {
  const year = today.getFullYear();
  const month = today.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const hols = holidaySet(province, year);
  return countWorkingDays(year, month, 1, daysInMonth, hols);
}

// Fraction (0..1) of the month's working days elapsed — for revenue pace.
function workingPaceFrac(province, today = new Date()) {
  const total = workingDaysInMonth(province, today);
  if (!total) return null;
  return workingDaysElapsed(province, today) / total;
}

// Hours a tech is expected on the clock MTD: (weekly hours / 5) per working day.
function availableHoursMTD(province, hoursPerWeek = 40, today = new Date()) {
  const perDay = (Number(hoursPerWeek) || 40) / 5;
  return workingDaysElapsed(province, today) * perDay;
}

// Efficiency % = hours sold / available hours. Null if no available hours yet.
function efficiencyPct(hoursSold, province, hoursPerWeek = 40, today = new Date()) {
  const avail = availableHoursMTD(province, hoursPerWeek, today);
  if (!avail || avail <= 0 || hoursSold == null) return null;
  return Math.round((Number(hoursSold) / avail) * 1000) / 10;
}

module.exports = {
  workingDaysElapsed,
  workingDaysInMonth,
  workingPaceFrac,
  availableHoursMTD,
  efficiencyPct
};
