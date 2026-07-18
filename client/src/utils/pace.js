// Working-day pace calculation, province-aware (AB / BC).
// Pace = working days elapsed / working days in month, where a "working day"
// is Mon-Fri excluding that province's statutory holidays. Used so MTD targets
// (revenue, car count) are compared against where the shop *should* be by now,
// counting only days it's actually open.

// Statutory holidays COMPUTED for any year/province — mirrors
// server/lib/workdays.js exactly (dates only; names live server-side).
// No annual list maintenance: Easter via the Gregorian algorithm, the rest
// are fixed dates or Nth-Monday rules, weekend fixed-dates observe Monday.
const _p2 = (n) => String(n).padStart(2, '0');
const _iso = (y, m, d) => `${y}-${_p2(m)}-${_p2(d)}`;
const _dow = (y, m, d) => new Date(y, m - 1, d).getDay();
function _easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return { month: Math.floor((h + l - 7 * m + 114) / 31), day: ((h + l - 7 * m + 114) % 31) + 1 };
}
const _nthMon = (y, m, n) => 1 + ((8 - _dow(y, m, 1)) % 7) + (n - 1) * 7;
const _obsMon = (y, m, d) => { const w = _dow(y, m, d); return w === 6 ? d + 2 : w === 0 ? d + 1 : d; };
const _RULES = {
  newyear: (y) => [_iso(y, 1, _obsMon(y, 1, 1))],
  febFamily: (y) => [_iso(y, 2, _nthMon(y, 2, 3))],
  goodfriday: (y) => { const e = _easter(y); const gf = new Date(y, e.month - 1, e.day - 2); return [_iso(y, gf.getMonth() + 1, gf.getDate())]; },
  victoria: (y) => [_iso(y, 5, 24 - ((_dow(y, 5, 24) + 6) % 7))],
  fetenationale: (y) => [_iso(y, 6, _obsMon(y, 6, 24))],
  nipd: (y) => [_iso(y, 6, _obsMon(y, 6, 21))],
  canada: (y) => [_iso(y, 7, _obsMon(y, 7, 1))],
  nunavut: (y) => [_iso(y, 7, _obsMon(y, 7, 9))],
  civicAug: (y) => [_iso(y, 8, _nthMon(y, 8, 1))],
  discovery: (y) => [_iso(y, 8, _nthMon(y, 8, 3))],
  labour: (y) => [_iso(y, 9, _nthMon(y, 9, 1))],
  tandr: (y) => [_iso(y, 9, 30)],
  thanksgiving: (y) => [_iso(y, 10, _nthMon(y, 10, 2))],
  remembrance: (y) => [_iso(y, 11, 11)],
  christmasPair: (y, withBoxing) => {
    const taken = new Set(); const out = [];
    const place = (d) => { let day = d; while (_dow(y, 12, day) === 0 || _dow(y, 12, day) === 6 || taken.has(day)) day++; taken.add(day); out.push(_iso(y, 12, day)); };
    place(25); if (withBoxing) place(26);
    return out;
  },
};
const _PROV_RULES = {
  ab: [['newyear'], ['febFamily'], ['goodfriday'], ['victoria'], ['canada'], ['labour'], ['thanksgiving'], ['remembrance'], ['christmasPair', true]],
  bc: [['newyear'], ['febFamily'], ['goodfriday'], ['victoria'], ['canada'], ['civicAug'], ['labour'], ['tandr'], ['thanksgiving'], ['remembrance'], ['christmasPair', true]],
  sk: [['newyear'], ['febFamily'], ['goodfriday'], ['victoria'], ['canada'], ['civicAug'], ['labour'], ['thanksgiving'], ['remembrance'], ['christmasPair', false]],
  mb: [['newyear'], ['febFamily'], ['goodfriday'], ['victoria'], ['canada'], ['labour'], ['thanksgiving'], ['christmasPair', false]],
  on: [['newyear'], ['febFamily'], ['goodfriday'], ['victoria'], ['canada'], ['labour'], ['thanksgiving'], ['christmasPair', true]],
  qc: [['newyear'], ['goodfriday'], ['victoria'], ['fetenationale'], ['canada'], ['labour'], ['thanksgiving'], ['christmasPair', false]],
  nb: [['newyear'], ['febFamily'], ['goodfriday'], ['canada'], ['civicAug'], ['labour'], ['remembrance'], ['christmasPair', false]],
  ns: [['newyear'], ['febFamily'], ['goodfriday'], ['canada'], ['labour'], ['remembrance'], ['christmasPair', false]],
  pe: [['newyear'], ['febFamily'], ['goodfriday'], ['canada'], ['labour'], ['remembrance'], ['christmasPair', false]],
  nl: [['newyear'], ['goodfriday'], ['canada'], ['labour'], ['remembrance'], ['christmasPair', false]],
  yt: [['newyear'], ['goodfriday'], ['victoria'], ['canada'], ['discovery'], ['labour'], ['tandr'], ['thanksgiving'], ['remembrance'], ['christmasPair', false]],
  nt: [['newyear'], ['goodfriday'], ['victoria'], ['nipd'], ['canada'], ['civicAug'], ['labour'], ['tandr'], ['thanksgiving'], ['remembrance'], ['christmasPair', false]],
  nu: [['newyear'], ['goodfriday'], ['victoria'], ['canada'], ['nunavut'], ['civicAug'], ['labour'], ['thanksgiving'], ['remembrance'], ['christmasPair', false]],
};
const _hsCache = new Map();
function holidaySet(province, year) {
  const prov = _PROV_RULES[(province || 'ab').toLowerCase()] ? (province || 'ab').toLowerCase() : 'ab';
  const key = `${prov}:${year}`;
  if (!_hsCache.has(key)) {
    const dates = [];
    for (const [rule, arg] of _PROV_RULES[prov]) dates.push(..._RULES[rule](year, arg));
    _hsCache.set(key, new Set(dates));
  }
  return _hsCache.get(key);
}

// Count Mon-Fri days in [start..end] (inclusive) that aren't holidays.
function countWorkingDays(year, month, fromDay, toDay, hols) {
  let n = 0;
  for (let d = fromDay; d <= toDay; d++) {
    const dt = new Date(year, month, d);
    const dow = dt.getDay(); // 0 Sun .. 6 Sat
    if (dow === 0 || dow === 6) continue;
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (hols.has(iso)) continue;
    n++;
  }
  return n;
}

// "Today" anchored to the shop's timezone (America/Edmonton — matches every
// server-side date computation), NOT the viewer's browser timezone. A Kelowna
// or overseas viewer at local midnight must not shift the shop's calendar day.
export const shopTodayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
export const shopNow = () => new Date(shopTodayIso() + 'T12:00:00');

// Returns fraction of the month's working days that have elapsed (0..1),
// or null if the month has no working days. `today` optional (defaults now).
export function workingPaceFrac(province, today = shopNow()) {
  const year = today.getFullYear();
  const month = today.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const hols = holidaySet(province, year);
  const totalWD = countWorkingDays(year, month, 1, daysInMonth, hols);
  if (totalWD === 0) return null;
  const elapsedWD = countWorkingDays(year, month, 1, today.getDate(), hols);
  return elapsedWD / totalWD;
}

// Pace % = actual vs (target * workingPaceFrac). Null if no target/data.
export function pacePct(actual, target, province, today = shopNow()) {
  if (!target || target <= 0 || !actual) return null;
  const frac = workingPaceFrac(province, today);
  if (!frac || frac <= 0) return null;
  return Math.round((actual / (target * frac)) * 100);
}

// Working days left in the current month (after today), for the hero band.
export function workingDaysLeftInMonth(province, today = shopNow()) {
  const year = today.getFullYear();
  const month = today.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const hols = holidaySet(province, year);
  if (today.getDate() >= daysInMonth) return 0;
  return countWorkingDays(year, month, today.getDate() + 1, daysInMonth, hols);
}


