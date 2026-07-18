// Working-day pace calculation, province-aware (AB / BC).
// Pace = working days elapsed / working days in month, where a "working day"
// is Mon-Fri excluding that province's statutory holidays. Used so MTD targets
// (revenue, car count) are compared against where the shop *should* be by now,
// counting only days it's actually open.

// 2026 statutory holiday dates by province (YYYY-MM-DD).
// AB: 9 official stats + Boxing Day (shop closes). BC: provincial stats incl.
// BC Day and Truth & Reconciliation. Update yearly or extend as needed.
const HOLIDAYS = {
  ab: {
    2026: [
      '2026-01-01', // New Year's Day
      '2026-02-16', // Family Day
      '2026-04-03', // Good Friday
      '2026-05-18', // Victoria Day
      '2026-07-01', // Canada Day
      '2026-09-07', // Labour Day
      '2026-10-12', // Thanksgiving
      '2026-11-11', // Remembrance Day
      '2026-12-25', // Christmas Day
      '2026-12-28'  // Boxing Day (observed Mon, Dec 26 is Sat) - shop closes
    ]
  },
  bc: {
    2026: [
      '2026-01-01', // New Year's Day
      '2026-02-16', // Family Day (BC)
      '2026-04-03', // Good Friday
      '2026-05-18', // Victoria Day
      '2026-07-01', // Canada Day
      '2026-08-03', // BC Day
      '2026-09-07', // Labour Day
      '2026-09-30', // Truth & Reconciliation (BC observes)
      '2026-10-12', // Thanksgiving
      '2026-11-11', // Remembrance Day
      '2026-12-25', // Christmas Day
      '2026-12-28'  // Boxing Day (observed)
    ]
  }
};

function holidaySet(province, year) {
  const prov = (province || 'ab').toLowerCase();
  const list = (HOLIDAYS[prov] && HOLIDAYS[prov][year]) || (HOLIDAYS.ab[year] || []);
  return new Set(list);
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


