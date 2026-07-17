// Server-side working-day + available-hours math, province-aware.
// Mirrors client/src/utils/pace.js so revenue pace and tech efficiency use the
// SAME definition of a "working day" (Mon-Fri minus that province's statutory
// holidays). Available hours = (weekly hours / 5) per working day elapsed, so
// efficiency = hours_sold / available_hours measures sold work against the
// ~40h/week a tech is on the clock, net of stat holidays (per Jamie's def).

// Statutory holidays per province/territory, 2026. Each province gets its own
// legal list — Family Day doesn't exist in QC, Saskatchewan Day isn't BC Day,
// etc. The Locations province dropdown selects which list applies.
const HOLIDAYS = {
  ab: { 2026: ['2026-01-01', '2026-02-16', '2026-04-03', '2026-05-18', '2026-07-01', '2026-09-07', '2026-10-12', '2026-11-11', '2026-12-25', '2026-12-28'] },
  bc: { 2026: ['2026-01-01', '2026-02-16', '2026-04-03', '2026-05-18', '2026-07-01', '2026-08-03', '2026-09-07', '2026-09-30', '2026-10-12', '2026-11-11', '2026-12-25', '2026-12-28'] },
  sk: { 2026: ['2026-01-01', '2026-02-16', '2026-04-03', '2026-05-18', '2026-07-01', '2026-08-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-12-25'] },
  mb: { 2026: ['2026-01-01', '2026-02-16', '2026-04-03', '2026-05-18', '2026-07-01', '2026-09-07', '2026-10-12', '2026-12-25'] },
  on: { 2026: ['2026-01-01', '2026-02-16', '2026-04-03', '2026-05-18', '2026-07-01', '2026-09-07', '2026-10-12', '2026-12-25', '2026-12-28'] },
  qc: { 2026: ['2026-01-01', '2026-04-03', '2026-05-18', '2026-06-24', '2026-07-01', '2026-09-07', '2026-10-12', '2026-12-25'] },
  nb: { 2026: ['2026-01-01', '2026-02-16', '2026-04-03', '2026-07-01', '2026-08-03', '2026-09-07', '2026-11-11', '2026-12-25'] },
  ns: { 2026: ['2026-01-01', '2026-02-16', '2026-04-03', '2026-07-01', '2026-09-07', '2026-11-11', '2026-12-25'] },
  pe: { 2026: ['2026-01-01', '2026-02-16', '2026-04-03', '2026-07-01', '2026-09-07', '2026-11-11', '2026-12-25'] },
  nl: { 2026: ['2026-01-01', '2026-04-03', '2026-07-01', '2026-09-07', '2026-11-11', '2026-12-25'] },
  yt: { 2026: ['2026-01-01', '2026-04-03', '2026-05-18', '2026-07-01', '2026-08-17', '2026-09-07', '2026-09-30', '2026-10-12', '2026-11-11', '2026-12-25'] },
  nt: { 2026: ['2026-01-01', '2026-04-03', '2026-05-18', '2026-06-22', '2026-07-01', '2026-08-03', '2026-09-07', '2026-09-30', '2026-10-12', '2026-11-11', '2026-12-25'] },
  nu: { 2026: ['2026-01-01', '2026-04-03', '2026-05-18', '2026-07-01', '2026-07-09', '2026-08-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-12-25'] }
};

// Display names: nationwide defaults + per-province naming (Feb 16 and Aug 3
// mean different things in different provinces).
const HOLIDAY_NAMES = {
  '2026-01-01': "New Year's Day", '2026-02-16': 'Family Day', '2026-04-03': 'Good Friday',
  '2026-05-18': 'Victoria Day', '2026-06-22': 'National Indigenous Peoples Day (observed)',
  '2026-06-24': 'Fête nationale', '2026-07-01': 'Canada Day', '2026-07-09': 'Nunavut Day',
  '2026-08-03': 'Civic Holiday', '2026-08-17': 'Discovery Day',
  '2026-09-07': 'Labour Day', '2026-09-30': 'Truth & Reconciliation Day',
  '2026-10-12': 'Thanksgiving', '2026-11-11': 'Remembrance Day',
  '2026-12-25': 'Christmas Day', '2026-12-28': 'Boxing Day (observed)'
};
const PROV_HOLIDAY_NAMES = {
  bc: { '2026-08-03': 'BC Day' },
  sk: { '2026-08-03': 'Saskatchewan Day' },
  mb: { '2026-02-16': 'Louis Riel Day' },
  qc: { '2026-05-18': "National Patriots' Day" },
  nb: { '2026-08-03': 'New Brunswick Day' },
  ns: { '2026-02-16': 'Heritage Day' },
  pe: { '2026-02-16': 'Islander Day' }
};
function holidayName(province, date) {
  const prov = (province || '').toLowerCase();
  return (PROV_HOLIDAY_NAMES[prov] && PROV_HOLIDAY_NAMES[prov][date]) || HOLIDAY_NAMES[date] || 'Stat holiday';
}

// A shop's open days as a Set of JS weekday numbers (0=Sun..6=Sat), from the
// locations.open_days CSV ('mon,tue,...'). Default: Mon–Fri.
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function openDaySet(csv) {
  const parts = String(csv || '').toLowerCase().split(',').map((s) => s.trim()).filter((s) => DOW[s] != null);
  return parts.length ? new Set(parts.map((s) => DOW[s])) : new Set([1, 2, 3, 4, 5]);
}

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

// Working days (shop's open days minus stat holidays) in [from..to], dates as
// 'YYYY-MM-DD'. openDays: Set of JS weekday numbers (default Mon–Fri). Sizes
// time-off requests and holiday-adjusts the schedule denominator.
function workingDaysBetween(province, from, to, openDays) {
  const open = openDays || new Set([1, 2, 3, 4, 5]);
  const start = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  let n = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (!open.has(d.getDay())) continue;
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (holidaySet(province, d.getFullYear()).has(iso)) continue;
    n++;
  }
  return n;
}

// Stat holidays falling inside [from..to] for a province → [{date, name}],
// named the way that province names them.
function holidaysBetween(province, from, to) {
  const years = new Set([Number(from.slice(0, 4)), Number(to.slice(0, 4))]);
  const out = [];
  for (const y of years) {
    for (const d of holidaySet(province, y)) {
      if (d >= from && d <= to) out.push({ date: d, name: holidayName(province, d) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Open-days-aware month working-day count (bonus schedule denominator). The
// Mon–Fri variants above stay untouched — pace/display keep their behaviour.
function workingDaysInMonthOpen(province, monthDate, openDays) {
  const year = monthDate.getFullYear(), month = monthDate.getMonth();
  const open = openDays || new Set([1, 2, 3, 4, 5]);
  const hols = holidaySet(province, year);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let n = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month, d);
    if (!open.has(dt.getDay())) continue;
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (hols.has(iso)) continue;
    n++;
  }
  return n;
}

module.exports = {
  workingDaysElapsed,
  workingDaysInMonth,
  workingPaceFrac,
  availableHoursMTD,
  efficiencyPct,
  workingDaysBetween,
  holidaysBetween,
  workingDaysInMonthOpen,
  openDaySet
};
