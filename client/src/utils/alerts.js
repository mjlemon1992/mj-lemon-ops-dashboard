// Helpers for the live alerts feed (stale vehicles + margin flags).
// The backend (server/routes/shopmonkeySync.js -> buildAlerts) stores a
// structured array on metrics_cache.alerts; the client formats the display text
// so the RO number always matches the exact Shopmonkey order it came from.

// pg may hand the JSONB column back as an array already, or as a JSON string
// depending on the driver — accept either, and never throw.
export function parseAlerts(m) {
  if (!m || m.alerts == null) return [];
  const a = m.alerts;
  if (Array.isArray(a)) return a;
  try {
    const parsed = JSON.parse(a);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${MON[d.getMonth()]} ${d.getDate()}`;
}

// Stable id for React keys and client-side "resolve" tracking.
export function alertId(a) {
  return `${a.type}-${a.ro || a.vehicle || ''}`;
}

export function alertTitle(a) {
  if (a.type === 'margin') return `${a.vehicle || 'Vehicle'} — RO #${a.ro}`;
  return `${a.vehicle || 'Vehicle'} — ${a.customer || 'Customer'}`;
}

export function alertSub(a) {
  if (a.type === 'margin') {
    return `Parts margin ${a.parts_margin}% — below ${a.parts_margin_target}% target`;
  }
  const ci = shortDate(a.checked_in);
  return `RO #${a.ro}${ci ? ` · Checked in ${ci}` : ''} · ${a.days_on_site} days on site`;
}
