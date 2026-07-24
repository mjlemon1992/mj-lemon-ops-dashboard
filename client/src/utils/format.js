// Shared display formatters — ONE copy. Every page that shows a date, time,
// month, money figure or time-off label imports from here (review finding:
// five drifting private copies).
export const fmtShortDate = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
export const fmtClock = (t) => t ? new Date(t).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : null;
export const monthLabel = (m, { year = false } = {}) => m ? new Date(m + '-15T12:00:00Z').toLocaleDateString('en-CA', year ? { month: 'long', year: 'numeric' } : { month: 'long' }) : '';
export const money = (n) => '$' + Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money0 = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-CA');
export const OFF_LABEL = { vacation: 'Holiday', sick: 'Sick', unpaid: 'Unpaid', other: 'Other', closure: 'Shop closure' };

// Relative "how long ago" for activity feeds and card meta (review finding:
// hand-rolled per component — ReviewRequestsCard, Home fmtSince, etc.).
export const ago = (d) => {
  if (!d) return '';
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (60 * 24))}d ago`;
};

// The OPS mono stack for inline styles that can't use the CSS class. Prefer
// fontFamily: 'var(--font-mono)' in new code; this exists for the few spots
// that need the literal string.
export const MONO = 'var(--font-mono)';
