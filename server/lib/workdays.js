// Server-side working-day + available-hours math, province-aware.
// Mirrors client/src/utils/pace.js so revenue pace and tech efficiency use the
// SAME definition of a "working day" (Mon-Fri minus that province's statutory
// holidays). Available hours = (weekly hours / 5) per working day elapsed, so
// efficiency = hours_sold / available_hours measures sold work against the
// ~40h/week a tech is on the clock, net of stat holidays (per Jamie's def).

// Statutory holidays, COMPUTED for any year — no annual list maintenance.
// Every Canadian stat is deterministic: Easter via the anonymous Gregorian
// algorithm, the rest are fixed dates or Nth-Monday rules. Fixed-date national
// holidays that land on a weekend observe the following weekday (the shop-
// closure convention, e.g. Boxing Day Sat 2026 → observed Mon Dec 28);
// commemorative dates (Remembrance, Truth & Reconciliation) stay put.
const p2 = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;
const dow = (y, m, d) => new Date(y, m - 1, d).getDay();

function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}
function nthMonday(y, m, n) {
  const first = dow(y, m, 1);
  const day = 1 + ((8 - first) % 7) + (n - 1) * 7;
  return { day, shifted: false };
}
// Fixed date; weekend → following Monday (marked observed).
function observedMonday(y, m, d) {
  const w = dow(y, m, d);
  if (w === 6) return { m, day: d + 2, shifted: true };
  if (w === 0) return { m, day: d + 1, shifted: true };
  return { m, day: d, shifted: false };
}

// Each rule returns [{date, name}] for a year (christmas pair returns two).
const RULES = {
  newyear: (y) => { const o = observedMonday(y, 1, 1); return [{ date: iso(y, 1, o.day), name: "New Year's Day" + (o.shifted ? ' (observed)' : '') }]; },
  febFamily: (y, name) => [{ date: iso(y, 2, nthMonday(y, 2, 3).day), name: name || 'Family Day' }],
  goodfriday: (y) => { const e = easterSunday(y); const gf = new Date(y, e.month - 1, e.day - 2); return [{ date: iso(y, gf.getMonth() + 1, gf.getDate()), name: 'Good Friday' }]; },
  victoria: (y, name) => { const w = dow(y, 5, 24); const day = 24 - ((w + 6) % 7); return [{ date: iso(y, 5, day), name: name || 'Victoria Day' }]; },
  fetenationale: (y) => { const o = observedMonday(y, 6, 24); return [{ date: iso(y, 6, o.day), name: 'Fête nationale' + (o.shifted ? ' (observed)' : '') }]; },
  nipd: (y) => { const o = observedMonday(y, 6, 21); return [{ date: iso(y, 6, o.day), name: 'National Indigenous Peoples Day' + (o.shifted ? ' (observed)' : '') }]; },
  canada: (y) => { const o = observedMonday(y, 7, 1); return [{ date: iso(y, 7, o.day), name: 'Canada Day' + (o.shifted ? ' (observed)' : '') }]; },
  nunavut: (y) => { const o = observedMonday(y, 7, 9); return [{ date: iso(y, 7, o.day), name: 'Nunavut Day' + (o.shifted ? ' (observed)' : '') }]; },
  civicAug: (y, name) => [{ date: iso(y, 8, nthMonday(y, 8, 1).day), name: name || 'Civic Holiday' }],
  discovery: (y) => [{ date: iso(y, 8, nthMonday(y, 8, 3).day), name: 'Discovery Day' }],
  labour: (y) => [{ date: iso(y, 9, nthMonday(y, 9, 1).day), name: 'Labour Day' }],
  tandr: (y) => [{ date: iso(y, 9, 30), name: 'Truth & Reconciliation Day' }],
  thanksgiving: (y) => [{ date: iso(y, 10, nthMonday(y, 10, 2).day), name: 'Thanksgiving' }],
  remembrance: (y) => [{ date: iso(y, 11, 11), name: 'Remembrance Day' }],
  christmasPair: (y, withBoxing) => {
    // Christmas then Boxing each take the next open weekday, chaining around
    // weekends (Fri 25 + Sat 26 → Boxing observed Mon; Sat+Sun → Mon + Tue).
    const taken = new Set();
    const place = (d, name) => {
      let day = d, shifted = false;
      while (dow(y, 12, day) === 0 || dow(y, 12, day) === 6 || taken.has(day)) { day++; shifted = true; }
      taken.add(day);
      return { date: iso(y, 12, day), name: name + (shifted ? ' (observed)' : '') };
    };
    const out = [place(25, 'Christmas Day')];
    if (withBoxing) out.push(place(26, 'Boxing Day'));
    return out;
  },
};

// Which rules apply per province/territory (+ local names where they differ).
const PROV_RULES = {
  ab: [['newyear'], ['febFamily'], ['goodfriday'], ['victoria'], ['canada'], ['labour'], ['thanksgiving'], ['remembrance'], ['christmasPair', true]],
  bc: [['newyear'], ['febFamily'], ['goodfriday'], ['victoria'], ['canada'], ['civicAug', 'BC Day'], ['labour'], ['tandr'], ['thanksgiving'], ['remembrance'], ['christmasPair', true]],
  sk: [['newyear'], ['febFamily'], ['goodfriday'], ['victoria'], ['canada'], ['civicAug', 'Saskatchewan Day'], ['labour'], ['thanksgiving'], ['remembrance'], ['christmasPair', false]],
  mb: [['newyear'], ['febFamily', 'Louis Riel Day'], ['goodfriday'], ['victoria'], ['canada'], ['labour'], ['thanksgiving'], ['christmasPair', false]],
  on: [['newyear'], ['febFamily'], ['goodfriday'], ['victoria'], ['canada'], ['labour'], ['thanksgiving'], ['christmasPair', true]],
  qc: [['newyear'], ['goodfriday'], ['victoria', "National Patriots' Day"], ['fetenationale'], ['canada'], ['labour'], ['thanksgiving'], ['christmasPair', false]],
  nb: [['newyear'], ['febFamily'], ['goodfriday'], ['canada'], ['civicAug', 'New Brunswick Day'], ['labour'], ['remembrance'], ['christmasPair', false]],
  ns: [['newyear'], ['febFamily', 'Heritage Day'], ['goodfriday'], ['canada'], ['labour'], ['remembrance'], ['christmasPair', false]],
  pe: [['newyear'], ['febFamily', 'Islander Day'], ['goodfriday'], ['canada'], ['labour'], ['remembrance'], ['christmasPair', false]],
  nl: [['newyear'], ['goodfriday'], ['canada'], ['labour'], ['remembrance'], ['christmasPair', false]],
  yt: [['newyear'], ['goodfriday'], ['victoria'], ['canada'], ['discovery'], ['labour'], ['tandr'], ['thanksgiving'], ['remembrance'], ['christmasPair', false]],
  nt: [['newyear'], ['goodfriday'], ['victoria'], ['nipd'], ['canada'], ['civicAug'], ['labour'], ['tandr'], ['thanksgiving'], ['remembrance'], ['christmasPair', false]],
  nu: [['newyear'], ['goodfriday'], ['victoria'], ['canada'], ['nunavut'], ['civicAug'], ['labour'], ['thanksgiving'], ['remembrance'], ['christmasPair', false]],
};

const _holCache = new Map();
function holidaysForYear(province, year) {
  const prov = PROV_RULES[(province || 'ab').toLowerCase()] ? (province || 'ab').toLowerCase() : 'ab';
  const key = `${prov}:${year}`;
  if (!_holCache.has(key)) {
    const out = [];
    for (const [rule, arg] of PROV_RULES[prov]) out.push(...RULES[rule](year, arg));
    out.sort((a, b) => a.date.localeCompare(b.date));
    _holCache.set(key, out);
  }
  return _holCache.get(key);
}
function holidayName(province, date) {
  const y = Number(String(date).slice(0, 4));
  const hit = holidaysForYear(province, y).find((h) => h.date === date);
  return hit ? hit.name : 'Stat holiday';
}
function holidaySet(province, year) {
  return new Set(holidaysForYear(province, year).map((h) => h.date));
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
  holidaysForYear,
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
