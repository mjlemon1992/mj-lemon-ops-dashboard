// Read-only calendar access for the morning brief via Google Calendar's private
// "secret address in iCal format" feeds (no OAuth). Parses each .ics and returns
// events in the window, expanding simple recurring events.
const ical = require('node-ical');

// urls: array of secret iCal URLs (capital, personal, hwy97). Returns
// { ok, error, events:[{title, start, end, allDay, calendar}] } sorted by start.
async function upcomingEvents(urls = [], { days = 7 } = {}) {
  const list = (urls || []).filter(Boolean);
  if (!list.length) return { ok: false, error: 'CAL_ICAL_URLS not set', events: [] };
  const now = new Date();
  const end = new Date(now.getTime() + days * 86400 * 1000);
  const events = [];
  let anyOk = false;
  let lastErr = '';

  for (const url of list) {
    try {
      const data = await ical.async.fromURL(url);
      anyOk = true;
      const calName = (data && data.WR_CALNAME) || '';
      for (const k in data) {
        const ev = data[k];
        if (!ev || ev.type !== 'VEVENT') continue;
        const allDay = !!(ev.start && ev.start.dateOnly);
        const push = (start, evEnd) => {
          if (!start) return;
          const s = new Date(start);
          if (s >= now && s <= end) {
            events.push({ title: ev.summary || '(busy)', start: s, end: evEnd ? new Date(evEnd) : null, allDay, calendar: calName });
          }
        };
        if (ev.rrule) {
          // Expand recurrences within the window.
          let dates = [];
          try { dates = ev.rrule.between(now, end, true); } catch (e) { dates = []; }
          const durMs = ev.end && ev.start ? (new Date(ev.end) - new Date(ev.start)) : 0;
          for (const d of dates) {
            const key = d.toISOString().slice(0, 10);
            if (ev.exdate && ev.exdate[key]) continue; // skip cancelled occurrence
            push(d, durMs ? new Date(d.getTime() + durMs) : null);
          }
        } else {
          push(ev.start, ev.end);
        }
      }
    } catch (e) { lastErr = e.message; }
  }

  events.sort((a, b) => a.start - b.start);
  if (!anyOk) return { ok: false, error: lastErr || 'no calendar feeds reachable', events: [] };
  return { ok: true, events };
}

module.exports = { upcomingEvents };
