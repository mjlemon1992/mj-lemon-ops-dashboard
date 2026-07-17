const express = require('express');
const crypto = require('crypto');
const { authenticateToken, requireRole, canAccessLocation } = require('../middleware/auth');
const { ensureTimeClockTables, paidHoursByMonth, paidHoursByRange, approvedOffDaysByRange, toIsodow } = require('../lib/timeClockSchema');
const { workingDaysBetween, holidaysBetween, openDaySet } = require('../lib/workdays');

// Shop-floor Time Clock. Two surfaces:
//   • KIOSK (public, PIN-gated like the display boards) — a shared tablet in the
//     bay. Opened with the location's display_pin; each punch needs the tech's
//     own clock_pin. Techs clock in/out and start/end unpaid breaks.
//   • CORRECTIONS (JWT, owner + that location's manager) — add/edit/delete
//     punches and set PINs, for missed or wrong entries.
// Monthly paid hours feed the bonus efficiency denominator (see bonus.js).
module.exports = (pool) => {
  const router = express.Router();
  const ensure = () => ensureTimeClockTables(pool);
  const fail = (res, e, code = 500) => res.status(code).json({ error: String(e.message || e) });
  const who = (req) => req.user.email || req.user.name || req.user.role;

  // ── Brute-force throttle for the public PIN surface (per IP+location) ──
  const WINDOW_MS = 10 * 60 * 1000, MAX_FAILS = 10, LOCK_MS = 15 * 60 * 1000;
  const fails = new Map();
  const rlKey = (req, loc) => ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown') + '|' + loc;
  const isLocked = (k) => { const e = fails.get(k); return !!(e && e.lockedUntil > Date.now()); };
  const recordFail = (k) => {
    const now = Date.now(); let e = fails.get(k);
    if (!e || now - e.first > WINDOW_MS) e = { first: now, count: 0, lockedUntil: 0 };
    e.count++; if (e.count >= MAX_FAILS) e.lockedUntil = now + LOCK_MS; fails.set(k, e);
  };
  const pinEqual = (a, b) => {
    const ab = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
    if (!ab.length || ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  };

  const statusOf = (row) => !row ? 'off' : (row.break_started_at ? 'break' : 'on');

  // ══ KIOSK (public, PIN-gated) ══════════════════════════════════════════
  const checkLocPin = async (req, res) => {
    const rk = rlKey(req, req.params.locationId);
    if (isLocked(rk)) { res.status(429).json({ error: 'Too many attempts. Try again later.' }); return null; }
    const { rows } = await pool.query('SELECT display_pin FROM locations WHERE id=$1', [req.params.locationId]);
    if (!rows.length) { res.status(404).json({ error: 'Location not found' }); return null; }
    const pin = (req.query.pin || (req.body || {}).loc_pin || '').toString();
    if (!rows[0].display_pin) { res.status(403).json({ error: 'Set a display PIN for this location first (under Locations).' }); return null; }
    if (!pinEqual(pin, rows[0].display_pin)) { recordFail(rk); res.status(401).json({ error: 'Incorrect PIN' }); return null; }
    fails.delete(rk);
    return true;
  };

  const photoUri = (p) => (p.photo ? `data:${p.photo_mime || 'image/jpeg'};base64,${p.photo.toString('base64')}` : null);

  // Roster + each person's current clock status (+ their colour and photo).
  router.get('/:locationId/roster', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const { rows: people } = await pool.query(
        'SELECT id, name, role, color, photo, photo_mime, (clock_pin IS NOT NULL) AS has_pin FROM bonus_person WHERE location_id=$1 AND active=true ORDER BY role, name',
        [req.params.locationId]);
      const { rows: open } = await pool.query(
        'SELECT person_id, clock_in, break_started_at FROM time_clock_entry WHERE location_id=$1 AND clock_out IS NULL',
        [req.params.locationId]);
      const byId = {}; for (const o of open) byId[o.person_id] = o;
      res.json({
        people: people.map((p) => ({
          id: p.id, name: p.name, role: p.role, has_pin: p.has_pin,
          color: p.color || null, photo: photoUri(p),
          status: statusOf(byId[p.id]), since: byId[p.id] ? (byId[p.id].break_started_at || byId[p.id].clock_in) : null,
          clock_in: byId[p.id] ? byId[p.id].clock_in : null,   // original in-time, always
        })),
      });
    } catch (e) { fail(res, e); }
  });

  // ── Tech self-service (kiosk, person-PIN-authed) ──────────────────────
  const PALETTE = ['#0a84ff', '#34c759', '#ff9f0a', '#ff375f', '#bf5af2', '#5ac8fa', '#ffd60a', '#ff6b35', '#64d2ff', '#30d158'];
  const personAuth = async (req, res) => {
    const { person_id, pin } = req.body || {};
    if (!person_id) { fail(res, 'person_id required', 400); return null; }
    const { rows } = await pool.query('SELECT id, name, clock_pin FROM bonus_person WHERE id=$1 AND location_id=$2 AND active=true', [person_id, req.params.locationId]);
    if (!rows.length) { fail(res, 'Person not found', 404); return null; }
    if (!rows[0].clock_pin) { fail(res, 'No clock PIN set — ask the owner to set one.', 400); return null; }
    const rk = rlKey(req, req.params.locationId) + '|' + person_id;
    if (isLocked(rk)) { fail(res, 'Too many incorrect PINs. Try again later.', 429); return null; }
    if (!pinEqual(pin, rows[0].clock_pin)) { recordFail(rk); fail(res, 'Incorrect PIN', 401); return null; }
    fails.delete(rk);
    return rows[0];
  };

  // Set my colour and/or photo (photo arrives base64, client-resized small).
  router.post('/:locationId/profile', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const person = await personAuth(req, res);
      if (!person) return;
      const { color, photo_base64, photo_mime, clear_photo } = req.body || {};
      if (color !== undefined && color !== null && !PALETTE.includes(color)) return fail(res, 'Pick a colour from the palette', 400);
      let photoBuf, mime;
      if (photo_base64) {
        photoBuf = Buffer.from(String(photo_base64), 'base64');
        if (photoBuf.length > 600 * 1024) return fail(res, 'Photo too large — try again', 400);
        mime = /^image\/(jpeg|png|webp)$/.test(photo_mime || '') ? photo_mime : 'image/jpeg';
      }
      await pool.query(
        `UPDATE bonus_person SET color = CASE WHEN $2 THEN $3 ELSE color END,
                photo = CASE WHEN $4 THEN $5 WHEN $6 THEN NULL ELSE photo END,
                photo_mime = CASE WHEN $4 THEN $7 WHEN $6 THEN NULL ELSE photo_mime END
          WHERE id=$1`,
        [person.id, color !== undefined, color, !!photoBuf, photoBuf || null, !!clear_photo, mime || null]);
      res.json({ ok: true, name: person.name });
    } catch (e) { fail(res, e); }
  });

  // My timesheet for the CURRENT pay period (+ totals).
  router.post('/:locationId/timesheet', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const person = await personAuth(req, res);
      if (!person) return;
      const { rows: lr } = await pool.query('SELECT pay_period_anchor::text AS anchor FROM locations WHERE id=$1', [req.params.locationId]);
      const anchor = (lr[0] && lr[0].anchor) || '2026-01-04';
      const DAY = 86400e3;
      const a = new Date(anchor + 'T12:00:00Z').getTime();
      const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }) + 'T12:00:00Z').getTime();
      const idx = Math.max(0, Math.floor((today - a) / (14 * DAY)));
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      const from = iso(a + idx * 14 * DAY), to = iso(a + idx * 14 * DAY + 13 * DAY);
      const { rows: entries } = await pool.query(
        `SELECT id, clock_in, clock_out, break_seconds, breaks,
                CASE WHEN clock_out IS NULL THEN NULL ELSE ${paidExpr} END AS paid_hours
           FROM time_clock_entry e
          WHERE location_id=$1 AND person_id=$2
            AND (clock_in AT TIME ZONE 'America/Edmonton')::date BETWEEN $3::date AND $4::date
          ORDER BY clock_in DESC`, [req.params.locationId, person.id, from, to]);
      const total = Math.round(entries.reduce((s, e) => s + (e.paid_hours != null ? Number(e.paid_hours) : 0), 0) * 100) / 100;
      res.json({ from, to, entries, total_paid: total, name: person.name });
    } catch (e) { fail(res, e); }
  });

  // "This punch is wrong / a punch is missing" — goes to the admin queue.
  router.post('/:locationId/edit-request', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const person = await personAuth(req, res);
      if (!person) return;
      const { entry_id, note, proposed_clock_in, proposed_clock_out, proposed_break_minutes } = req.body || {};
      if (!note || !String(note).trim()) return fail(res, 'Say what needs changing', 400);
      if (proposed_clock_in && proposed_clock_out && new Date(proposed_clock_out) <= new Date(proposed_clock_in)) {
        return fail(res, 'Proposed clock-out must be after clock-in', 400);
      }
      const { rows: dup } = await pool.query(
        "SELECT 1 FROM time_edit_request WHERE person_id=$1 AND status='pending' AND COALESCE(entry_id::text,'') = COALESCE($2,'') LIMIT 1",
        [person.id, entry_id || null]);
      if (dup.length) return fail(res, 'Already requested — the owner will review it', 409);
      await pool.query(
        `INSERT INTO time_edit_request (location_id, person_id, entry_id, note, proposed_clock_in, proposed_clock_out, proposed_break_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.params.locationId, person.id, entry_id || null, String(note).slice(0, 400),
         proposed_clock_in || null, proposed_clock_out || null,
         proposed_break_minutes != null ? Math.max(0, Math.round(Number(proposed_break_minutes))) : null]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Punch: action = in | break_start | break_end | out. Needs the person's PIN.
  router.post('/:locationId/punch', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const { person_id, pin, action } = req.body || {};
      if (!person_id || !['in', 'break_start', 'break_end', 'out'].includes(action)) return fail(res, 'person_id + valid action required', 400);
      const { rows: pr } = await pool.query('SELECT id, name, clock_pin FROM bonus_person WHERE id=$1 AND location_id=$2 AND active=true', [person_id, req.params.locationId]);
      if (!pr.length) return fail(res, 'Person not found', 404);
      const person = pr[0];
      if (!person.clock_pin) return fail(res, 'No clock PIN set for this person — ask the owner to set one.', 400);
      const rk = rlKey(req, req.params.locationId) + '|' + person_id;
      if (isLocked(rk)) return fail(res, 'Too many incorrect PINs for this person. Try again later.', 429);
      if (!pinEqual(pin, person.clock_pin)) { recordFail(rk); return fail(res, 'Incorrect PIN', 401); }
      fails.delete(rk);

      const { rows: openRows } = await pool.query('SELECT * FROM time_clock_entry WHERE person_id=$1 AND clock_out IS NULL', [person_id]);
      const open = openRows[0];

      if (action === 'in') {
        if (open) return fail(res, `${person.name} is already clocked in`, 409);
        await pool.query('INSERT INTO time_clock_entry (location_id, person_id, clock_in, source, created_by) VALUES ($1,$2,now(),$3,$4)', [req.params.locationId, person_id, 'kiosk', person.name]);
        return res.json({ status: 'on', name: person.name });
      }
      if (!open) return fail(res, `${person.name} is not clocked in`, 409);
      // Break SEGMENTS ([{start,end}]) are recorded alongside the break_seconds
      // total, so timesheets can show when each break actually happened.
      const segs = Array.isArray(open && open.breaks) ? open.breaks : [];
      if (action === 'break_start') {
        if (open.break_started_at) return fail(res, 'Already on break', 409);
        await pool.query('UPDATE time_clock_entry SET break_started_at=now(), breaks=$2 WHERE id=$1',
          [open.id, JSON.stringify([...segs, { start: new Date().toISOString() }])]);
        return res.json({ status: 'break', name: person.name });
      }
      const closeSegs = () => {
        if (!segs.length || segs[segs.length - 1].end) return segs;
        return [...segs.slice(0, -1), { ...segs[segs.length - 1], end: new Date().toISOString() }];
      };
      if (action === 'break_end') {
        if (!open.break_started_at) return fail(res, 'Not on break', 409);
        await pool.query("UPDATE time_clock_entry SET break_seconds = break_seconds + EXTRACT(EPOCH FROM (now() - break_started_at)), break_started_at = NULL, breaks=$2 WHERE id=$1",
          [open.id, JSON.stringify(closeSegs())]);
        // clock_in returned so the kiosk can reassure: the original shift is intact.
        return res.json({ status: 'on', name: person.name, clock_in: open.clock_in });
      }
      // out — auto-close an open break first; report the day's paid hours back.
      const { rows: closed } = await pool.query(
        `UPDATE time_clock_entry
            SET break_seconds = break_seconds + COALESCE(EXTRACT(EPOCH FROM (now() - break_started_at)), 0),
                break_started_at = NULL, breaks=$2, clock_out = now()
          WHERE id=$1
          RETURNING ROUND((EXTRACT(EPOCH FROM (clock_out - clock_in)) - break_seconds)/3600.0, 2) AS paid_hours`,
        [open.id, JSON.stringify(open.break_started_at ? closeSegs() : segs)]);
      return res.json({ status: 'off', name: person.name, paid_hours: Number(closed[0].paid_hours) });
    } catch (e) { fail(res, e); }
  });

  // ══ TIME OFF — kiosk side (PIN-gated) ═════════════════════════════════
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const OFF_TYPES = ['vacation', 'sick', 'unpaid', 'other'];

  // Who's-off board for the kiosk: approved (and pending, flagged) requests
  // from a week back to ~10 weeks out, plus the province's stat holidays for
  // the calendar window (current + next month) — closures show as "Shop closed".
  router.get('/:locationId/timeoff-board', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const { rows } = await pool.query(
        `SELECT r.id, r.person_id, COALESCE(p.name, 'Shop closed') AS person_name, r.start_date::text AS start_date, r.end_date::text AS end_date, r.type, r.status, r.working_days
           FROM time_off_request r LEFT JOIN bonus_person p ON p.id = r.person_id
          WHERE r.location_id = $1 AND r.status IN ('approved','pending')
            AND r.end_date >= (now() AT TIME ZONE 'America/Edmonton')::date - 7
            AND r.start_date <= (now() AT TIME ZONE 'America/Edmonton')::date + 70
          ORDER BY r.start_date`, [req.params.locationId]);
      const { rows: lr } = await pool.query('SELECT province FROM locations WHERE id=$1', [req.params.locationId]);
      const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }) + 'T12:00:00Z');
      const winFrom = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
      const nextEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 0));
      const winTo = nextEnd.toISOString().slice(0, 10);
      res.json({ requests: rows, holidays: holidaysBetween((lr[0] || {}).province || 'ab', winFrom, winTo) });
    } catch (e) { fail(res, e); }
  });

  // A tech requests time off from the kiosk (their own PIN required).
  router.post('/:locationId/timeoff', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const { person_id, pin, start_date, end_date, type, note } = req.body || {};
      if (!person_id || !isDate(start_date) || !isDate(end_date)) return fail(res, 'person_id + start_date + end_date required', 400);
      if (end_date < start_date) return fail(res, 'End date is before start date', 400);
      if (!OFF_TYPES.includes(type || 'vacation')) return fail(res, 'Invalid type', 400);
      const { rows: pr } = await pool.query('SELECT id, name, clock_pin FROM bonus_person WHERE id=$1 AND location_id=$2 AND active=true', [person_id, req.params.locationId]);
      if (!pr.length) return fail(res, 'Person not found', 404);
      if (!pr[0].clock_pin) return fail(res, 'No clock PIN set — ask the owner to set one.', 400);
      const rk = rlKey(req, req.params.locationId) + '|' + person_id;
      if (isLocked(rk)) return fail(res, 'Too many incorrect PINs. Try again later.', 429);
      if (!pinEqual(pin, pr[0].clock_pin)) { recordFail(rk); return fail(res, 'Incorrect PIN', 401); }
      fails.delete(rk);
      const { rows: overlap } = await pool.query(
        `SELECT 1 FROM time_off_request WHERE person_id=$1 AND status IN ('pending','approved') AND start_date <= $3 AND end_date >= $2 LIMIT 1`,
        [person_id, start_date, end_date]);
      if (overlap.length) return fail(res, 'You already have a request covering those dates', 409);
      const { rows: locRows } = await pool.query('SELECT province, open_days FROM locations WHERE id=$1', [req.params.locationId]);
      // Days used = the shop's OPEN days in the range, minus stat holidays —
      // Saturdays/Sundays (or whatever the shop is closed) never count.
      const days = workingDaysBetween((locRows[0] || {}).province || 'ab', start_date, end_date, openDaySet((locRows[0] || {}).open_days));
      const { rows } = await pool.query(
        `INSERT INTO time_off_request (location_id, person_id, start_date, end_date, type, note, working_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.params.locationId, person_id, start_date, end_date, type || 'vacation', String(note || '').slice(0, 300), days]);
      res.json({ ok: true, id: rows[0].id, working_days: days, name: pr[0].name });
    } catch (e) { fail(res, e); }
  });

  // ══ TIME OFF — admin side ═════════════════════════════════════════════
  // Mirror an approved request onto the Shopmonkey calendar (all-day block, no
  // customer). Best-effort: approval stands even if the push fails.
  const smPush = async (locationId, personName, r) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    const { rows } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id=$1', [locationId]);
    const smLoc = rows[0] && rows[0].shopmonkey_location_id;
    if (!apiKey || !smLoc) return { ok: false, error: 'Shopmonkey not configured' };
    const label = { vacation: 'Holiday', sick: 'Sick', unpaid: 'Unpaid leave', other: 'Time off' }[r.type] || 'Time off';
    const title = r.type === 'closure' ? '🚪 Shop closed' : `🏖 ${personName} — ${label}`;
    try {
      const resp = await fetch('https://api.shopmonkey.cloud/v3/appointment', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId: smLoc,
          name: title,
          note: `${r.type === 'closure' ? 'Shop closed' : personName + ' off'} ${r.start_date} to ${r.end_date} (${r.working_days} working day${r.working_days === 1 ? '' : 's'}). Set in the ops dashboard.`,
          allDay: true,
          startDate: `${r.start_date}T15:00:00.000Z`,
          endDate: `${r.end_date}T23:00:00.000Z`,
          color: 'purple',
          sendConfirmation: false,
          sendReminder: false,
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) return { ok: false, error: body.message || `HTTP ${resp.status}` };
      const id = (body.data && body.data.id) || body.id;
      return { ok: true, id };
    } catch (e) { return { ok: false, error: e.message }; }
  };
  const smDelete = async (smAppointmentId) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    if (!apiKey || !smAppointmentId) return;
    try {
      await fetch(`https://api.shopmonkey.cloud/v3/appointment/${smAppointmentId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch { /* best-effort */ }
  };

  // ══ CORRECTIONS + PINs (owner + that location's manager) ══════════════
  const authed = [authenticateToken, requireRole('owner', 'partner', 'manager')];
  const scoped = (req, res, next) => canAccessLocation(req.user, req.params.locationId) ? next() : res.status(403).json({ error: 'Access denied for this location' });
  const paidExpr = "ROUND((EXTRACT(EPOCH FROM (clock_out - clock_in)) - break_seconds)/3600.0, 2)";

  // Entries for review + correction, with computed paid hours. Accepts either
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD (payroll periods) or ?month=YYYY-MM.
  router.get('/:locationId/entries', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { month, from, to } = req.query;
      let range;
      if (isDate(from) && isDate(to)) range = [from, to];
      else if (/^\d{4}-\d{2}$/.test(month || '')) range = null;
      else return fail(res, 'month=YYYY-MM or from+to=YYYY-MM-DD required', 400);
      const where = range
        ? `(e.clock_in AT TIME ZONE 'America/Edmonton')::date BETWEEN $2::date AND $3::date`
        : `to_char(e.clock_in AT TIME ZONE 'America/Edmonton','YYYY-MM')=$2`;
      const params = range ? [req.params.locationId, range[0], range[1]] : [req.params.locationId, month];
      const { rows } = await pool.query(
        `SELECT e.*, p.name AS person_name,
                CASE WHEN e.clock_out IS NULL THEN NULL ELSE ${paidExpr} END AS paid_hours
           FROM time_clock_entry e JOIN bonus_person p ON p.id = e.person_id
          WHERE e.location_id=$1 AND ${where}
          ORDER BY e.clock_in DESC`, params);
      const summary = range
        ? await paidHoursByRange(pool, req.params.locationId, range[0], range[1])
        : await paidHoursByMonth(pool, req.params.locationId, month);
      // Payroll context for the period: per-person approved days off (open days
      // only) and any stat holidays falling inside it (province-based).
      let off_days = {}, closure_days = 0, stat_holidays = [];
      if (range) {
        const { rows: lr } = await pool.query('SELECT province, open_days FROM locations WHERE id=$1', [req.params.locationId]);
        const loc = lr[0] || {};
        const off = await approvedOffDaysByRange(pool, req.params.locationId, range[0], range[1], toIsodow(openDaySet(loc.open_days)));
        off_days = off.byPerson; closure_days = off.closure;
        stat_holidays = holidaysBetween(loc.province || 'ab', range[0], range[1]);
      }
      res.json({ month: month || null, from: range ? range[0] : null, to: range ? range[1] : null, entries: rows, summary, off_days, closure_days, stat_holidays });
    } catch (e) { fail(res, e); }
  });

  // Biweekly pay periods, anchored at locations.pay_period_anchor (a period
  // start date; default 2026-01-04). Returns the current + previous N periods.
  router.get('/:locationId/pay-periods', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { rows } = await pool.query('SELECT pay_period_anchor::text AS anchor FROM locations WHERE id=$1', [req.params.locationId]);
      const anchor = (rows[0] && rows[0].anchor) || '2026-01-04';
      const DAY = 86400e3;
      const a = new Date(anchor + 'T12:00:00Z').getTime();
      const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }) + 'T12:00:00Z').getTime();
      const idx = Math.floor((today - a) / (14 * DAY));
      const periods = [];
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      for (let i = idx; i > idx - 9 && i >= 0; i--) {
        const start = a + i * 14 * DAY;
        periods.push({ from: iso(start), to: iso(start + 13 * DAY), current: i === idx });
      }
      res.json({ anchor, periods });
    } catch (e) { fail(res, e); }
  });

  // Owner sets the biweekly anchor (any past period-START date, e.g. a payday-cycle start).
  router.put('/:locationId/pay-anchor', authenticateToken, requireRole('owner'), async (req, res) => {
    try {
      await ensure();
      const { anchor } = req.body || {};
      if (!isDate(anchor)) return fail(res, 'anchor must be YYYY-MM-DD', 400);
      await pool.query('UPDATE locations SET pay_period_anchor=$2 WHERE id=$1', [req.params.locationId, anchor]);
      res.json({ ok: true, anchor });
    } catch (e) { fail(res, e); }
  });

  // Year's requests + per-person approved totals (working days). Closure days
  // are location-wide and deliberately NOT charged to personal totals.
  router.get('/:locationId/timeoff', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : String(new Date().getFullYear());
      const { rows: requests } = await pool.query(
        `SELECT r.*, r.start_date::text AS start_date, r.end_date::text AS end_date, COALESCE(p.name, 'Shop closed') AS person_name
           FROM time_off_request r LEFT JOIN bonus_person p ON p.id = r.person_id
          WHERE r.location_id=$1 AND (to_char(r.start_date,'YYYY')=$2 OR to_char(r.end_date,'YYYY')=$2)
          ORDER BY r.status='pending' DESC, r.start_date DESC`, [req.params.locationId, year]);
      const totals = {};
      for (const r of requests) if (r.status === 'approved' && r.person_id) totals[r.person_id] = (totals[r.person_id] || 0) + (r.working_days || 0);
      res.json({ year, requests, totals });
    } catch (e) { fail(res, e); }
  });

  // Book a location-wide closure (owner/manager) — created approved directly,
  // applies to the whole crew, mirrors to the Shopmonkey calendar.
  router.post('/:locationId/closure', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { start_date, end_date, note } = req.body || {};
      if (!isDate(start_date) || !isDate(end_date)) return fail(res, 'start_date + end_date required', 400);
      if (end_date < start_date) return fail(res, 'End date is before start date', 400);
      const { rows: locRows } = await pool.query('SELECT province, open_days FROM locations WHERE id=$1', [req.params.locationId]);
      const days = workingDaysBetween((locRows[0] || {}).province || 'ab', start_date, end_date, openDaySet((locRows[0] || {}).open_days));
      const { rows } = await pool.query(
        `INSERT INTO time_off_request (location_id, person_id, start_date, end_date, type, note, working_days, status, decided_by, decided_at)
         VALUES ($1, NULL, $2, $3, 'closure', $4, $5, 'approved', $6, now())
         RETURNING *, start_date::text AS start_date, end_date::text AS end_date`,
        [req.params.locationId, start_date, end_date, String(note || '').slice(0, 300), days, who(req)]);
      const sm = await smPush(req.params.locationId, 'Shop closed', rows[0]);
      if (sm && sm.ok) await pool.query('UPDATE time_off_request SET sm_appointment_id=$2 WHERE id=$1', [rows[0].id, sm.id]);
      res.json({ ok: true, id: rows[0].id, working_days: days, shopmonkey: sm ? (sm.ok ? 'calendar entry created' : `push failed: ${sm.error}`) : null });
    } catch (e) { fail(res, e); }
  });

  // Approve / deny. Approval mirrors to the Shopmonkey calendar (best-effort).
  router.put('/timeoff/:id/decide', ...authed, async (req, res) => {
    try {
      await ensure();
      const action = (req.body || {}).action;
      if (!['approve', 'deny'].includes(action)) return fail(res, 'action must be approve|deny', 400);
      const { rows: rr } = await pool.query(
        `SELECT r.*, r.start_date::text AS start_date, r.end_date::text AS end_date, p.name AS person_name
           FROM time_off_request r JOIN bonus_person p ON p.id=r.person_id WHERE r.id=$1`, [req.params.id]);
      if (!rr.length) return fail(res, 'Request not found', 404);
      const r = rr[0];
      if (!canAccessLocation(req.user, r.location_id)) return fail(res, 'Access denied for this location', 403);
      if (r.status !== 'pending') return fail(res, `Already ${r.status}`, 409);
      let sm = null;
      if (action === 'approve') sm = await smPush(r.location_id, r.person_name, r);
      await pool.query(
        `UPDATE time_off_request SET status=$2, decided_by=$3, decided_at=now(), sm_appointment_id=$4 WHERE id=$1`,
        [r.id, action === 'approve' ? 'approved' : 'denied', who(req), sm && sm.ok ? sm.id : null]);
      res.json({ ok: true, status: action === 'approve' ? 'approved' : 'denied', shopmonkey: sm ? (sm.ok ? 'calendar entry created' : `push failed: ${sm.error}`) : null });
    } catch (e) { fail(res, e); }
  });

  // Cancel a request (pending or approved). Removes the Shopmonkey entry too.
  router.delete('/timeoff/:id', ...authed, async (req, res) => {
    try {
      await ensure();
      const { rows: rr } = await pool.query('SELECT * FROM time_off_request WHERE id=$1', [req.params.id]);
      if (!rr.length) return fail(res, 'Request not found', 404);
      if (!canAccessLocation(req.user, rr[0].location_id)) return fail(res, 'Access denied for this location', 403);
      if (rr[0].sm_appointment_id) await smDelete(rr[0].sm_appointment_id);
      await pool.query("UPDATE time_off_request SET status='cancelled', decided_by=$2, decided_at=now() WHERE id=$1", [req.params.id, who(req)]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Add a punch by hand (missed clock-in etc).
  router.post('/:locationId/entries', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { person_id, clock_in, clock_out, break_minutes, note } = req.body || {};
      if (!person_id || !clock_in) return fail(res, 'person_id + clock_in required', 400);
      if (clock_out && new Date(clock_out) <= new Date(clock_in)) return fail(res, 'clock_out must be after clock_in', 400);
      const { rows } = await pool.query(
        `INSERT INTO time_clock_entry (location_id, person_id, clock_in, clock_out, break_seconds, note, source, created_by, corrected_by, corrected_at)
         VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$7,now()) RETURNING *`,
        [req.params.locationId, person_id, clock_in, clock_out || null, Math.round(Number(break_minutes || 0) * 60), String(note || '').slice(0, 300), who(req)]);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });

  // Edit a punch (fix a wrong time / break). Location checked via the row.
  router.put('/entries/:id', ...authed, async (req, res) => {
    try {
      await ensure();
      const { rows: er } = await pool.query('SELECT * FROM time_clock_entry WHERE id=$1', [req.params.id]);
      if (!er.length) return fail(res, 'Entry not found', 404);
      if (!canAccessLocation(req.user, er[0].location_id)) return fail(res, 'Access denied for this location', 403);
      const b = req.body || {};
      const clockIn = b.clock_in || er[0].clock_in;
      const clockOut = b.clock_out === undefined ? er[0].clock_out : b.clock_out;
      if (clockOut && new Date(clockOut) <= new Date(clockIn)) return fail(res, 'clock_out must be after clock_in', 400);
      let breakSec = b.break_minutes === undefined ? er[0].break_seconds : Math.round(Number(b.break_minutes) * 60);
      // Editing PAID hours directly: keep the punch times, back-compute the
      // break so paid = (out − in) − break stays consistent.
      if (b.paid_hours != null && clockOut) {
        const wallSec = (new Date(clockOut) - new Date(clockIn)) / 1000;
        const paidSec = Number(b.paid_hours) * 3600;
        if (!(paidSec >= 0)) return fail(res, 'paid_hours must be ≥ 0', 400);
        if (paidSec > wallSec) return fail(res, 'Paid hours exceed the shift length — adjust the clock times instead', 400);
        breakSec = Math.round(wallSec - paidSec);
      }
      const { rows } = await pool.query(
        `UPDATE time_clock_entry SET clock_in=$2, clock_out=$3, break_seconds=$4, note=COALESCE($5,note),
                break_started_at=NULL, corrected_by=$6, corrected_at=now() WHERE id=$1 RETURNING *`,
        [req.params.id, clockIn, clockOut || null, Math.max(0, breakSec), b.note != null ? String(b.note).slice(0, 300) : null, who(req)]);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });

  router.delete('/entries/:id', ...authed, async (req, res) => {
    try {
      await ensure();
      const { rows: er } = await pool.query('SELECT location_id FROM time_clock_entry WHERE id=$1', [req.params.id]);
      if (!er.length) return fail(res, 'Entry not found', 404);
      if (!canAccessLocation(req.user, er[0].location_id)) return fail(res, 'Access denied for this location', 403);
      await pool.query('DELETE FROM time_clock_entry WHERE id=$1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // Live clock status for the dashboards (Technicians page polls this): who's
  // clocked in / on break (and since when) right now.
  router.get('/:locationId/status', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { rows } = await pool.query(
        `SELECT p.id, p.name, p.role, p.color, p.photo, p.photo_mime, e.clock_in, e.break_started_at, e.break_seconds
           FROM bonus_person p
           LEFT JOIN time_clock_entry e ON e.person_id = p.id AND e.clock_out IS NULL
          WHERE p.location_id=$1 AND p.active=true
          ORDER BY p.role, p.name`, [req.params.locationId]);
      res.json({
        people: rows.map((r) => ({
          id: r.id, name: r.name, role: r.role, color: r.color || null, photo: photoUri(r),
          status: r.clock_in ? (r.break_started_at ? 'break' : 'on') : 'off',
          clock_in: r.clock_in, break_started_at: r.break_started_at,
        })),
      });
    } catch (e) { fail(res, e); }
  });

  // Mirror the province's remaining stat holidays (this year) onto the
  // Shopmonkey calendar. Idempotent — already-pushed dates are skipped.
  router.post('/:locationId/sync-holidays', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { rows: lr } = await pool.query('SELECT province, shopmonkey_location_id FROM locations WHERE id=$1', [req.params.locationId]);
      const loc = lr[0] || {};
      if (!loc.shopmonkey_location_id || !process.env.SHOPMONKEY_API_KEY) return fail(res, 'Shopmonkey not configured for this location', 400);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
      const hols = holidaysBetween(loc.province || 'ab', today, `${today.slice(0, 4)}-12-31`);
      const { rows: done } = await pool.query('SELECT holiday_date::text AS d FROM holiday_sm_push WHERE location_id=$1', [req.params.locationId]);
      const doneSet = new Set(done.map((r) => r.d));
      const pushed = [], failed = [];
      for (const h of hols) {
        if (doneSet.has(h.date)) continue;
        try {
          const resp = await fetch('https://api.shopmonkey.cloud/v3/appointment', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.SHOPMONKEY_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              locationId: loc.shopmonkey_location_id,
              name: `🎌 ${h.name}`,
              note: `Statutory holiday (${(loc.province || 'AB').toUpperCase()}). Added by the ops dashboard.`,
              allDay: true,
              startDate: `${h.date}T15:00:00.000Z`,
              endDate: `${h.date}T23:00:00.000Z`,
              color: 'red',
              sendConfirmation: false, sendReminder: false,
            }),
          });
          const body = await resp.json().catch(() => ({}));
          if (!resp.ok) { failed.push(`${h.name}: ${body.message || resp.status}`); continue; }
          const id = (body.data && body.data.id) || body.id;
          await pool.query('INSERT INTO holiday_sm_push (location_id, holiday_date, sm_appointment_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.params.locationId, h.date, id || null]);
          pushed.push(h.name);
          await new Promise((r) => setTimeout(r, 250));   // gentle on SM rate limits
        } catch (e) { failed.push(`${h.name}: ${e.message}`); }
      }
      res.json({ ok: true, pushed, already: doneSet.size, failed });
    } catch (e) { fail(res, e); }
  });

  // Timesheet alteration requests from the kiosk — pending queue + resolve.
  router.get('/:locationId/edit-requests', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { rows } = await pool.query(
        `SELECT r.*, p.name AS person_name, e.clock_in, e.clock_out, e.break_seconds
           FROM time_edit_request r
           JOIN bonus_person p ON p.id = r.person_id
           LEFT JOIN time_clock_entry e ON e.id = r.entry_id
          WHERE r.location_id=$1 AND r.status='pending'
          ORDER BY r.requested_at`, [req.params.locationId]);
      res.json({ requests: rows });
    } catch (e) { fail(res, e); }
  });
  router.put('/edit-requests/:id', ...authed, async (req, res) => {
    try {
      await ensure();
      const action = (req.body || {}).action;
      if (!['resolved', 'dismissed', 'apply'].includes(action)) return fail(res, 'action must be resolved|dismissed|apply', 400);
      const { rows: rr } = await pool.query('SELECT * FROM time_edit_request WHERE id=$1', [req.params.id]);
      if (!rr.length) return fail(res, 'Request not found', 404);
      const r = rr[0];
      if (!canAccessLocation(req.user, r.location_id)) return fail(res, 'Access denied for this location', 403);
      // "Apply": put the tech's proposed times straight onto the entry (or
      // create the missing punch), then mark resolved — one tap.
      if (action === 'apply') {
        if (!r.proposed_clock_in && !r.proposed_clock_out && r.proposed_break_minutes == null) {
          return fail(res, 'No proposed times on this request — fix the punch by hand and mark it resolved', 400);
        }
        if (r.entry_id) {
          const { rows: er } = await pool.query('SELECT * FROM time_clock_entry WHERE id=$1', [r.entry_id]);
          if (!er.length) return fail(res, 'The punch this request refers to no longer exists', 404);
          const ci = r.proposed_clock_in || er[0].clock_in;
          const co = r.proposed_clock_out || er[0].clock_out;
          if (co && new Date(co) <= new Date(ci)) return fail(res, 'Proposed times are inverted', 400);
          await pool.query(
            `UPDATE time_clock_entry SET clock_in=$2, clock_out=$3,
                    break_seconds=COALESCE($4, break_seconds), break_started_at=NULL,
                    corrected_by=$5, corrected_at=now() WHERE id=$1`,
            [r.entry_id, ci, co, r.proposed_break_minutes != null ? r.proposed_break_minutes * 60 : null, who(req)]);
        } else {
          if (!r.proposed_clock_in || !r.proposed_clock_out) return fail(res, 'A missing punch needs both proposed times — add it by hand instead', 400);
          await pool.query(
            `INSERT INTO time_clock_entry (location_id, person_id, clock_in, clock_out, break_seconds, note, source, created_by, corrected_by, corrected_at)
             VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$7,now())`,
            [r.location_id, r.person_id, r.proposed_clock_in, r.proposed_clock_out,
             (r.proposed_break_minutes || 0) * 60, `from change request: ${r.note}`.slice(0, 300), who(req)]);
        }
      }
      await pool.query('UPDATE time_edit_request SET status=$2, resolved_by=$3, resolved_at=now() WHERE id=$1',
        [req.params.id, action === 'dismissed' ? 'dismissed' : 'resolved', who(req)]);
      res.json({ ok: true, applied: action === 'apply' });
    } catch (e) { fail(res, e); }
  });

  // ── Pay-period timesheet PDF (individual or whole crew) + email ────────
  const buildTimesheetPdf = async (locationId, from, to, personId) => {
    const PDFDocument = require('pdfkit');
    const { rows: lr } = await pool.query('SELECT name FROM locations WHERE id=$1', [locationId]);
    const locName = (lr[0] && lr[0].name) || 'Location';
    const params = [locationId, from, to];
    let personSql = '';
    if (personId && personId !== 'all') { params.push(personId); personSql = ' AND e.person_id=$4'; }
    const { rows } = await pool.query(
      `SELECT e.*, p.name AS person_name,
              CASE WHEN e.clock_out IS NULL THEN NULL ELSE ${paidExpr} END AS paid_hours
         FROM time_clock_entry e JOIN bonus_person p ON p.id=e.person_id
        WHERE e.location_id=$1 AND (e.clock_in AT TIME ZONE 'America/Edmonton')::date BETWEEN $2::date AND $3::date${personSql}
        ORDER BY p.name, e.clock_in`, params);
    const tz = { timeZone: 'America/Edmonton' };
    const fD = (t) => new Date(t).toLocaleDateString('en-CA', { ...tz, weekday: 'short', month: 'short', day: 'numeric' });
    const fT = (t) => new Date(t).toLocaleTimeString('en-CA', { ...tz, hour: 'numeric', minute: '2-digit' });
    const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
    doc.fontSize(16).font('Helvetica-Bold').text(`${locName} — Timesheet`);
    doc.fontSize(11).font('Helvetica').fillColor('#555').text(`Pay period ${from} to ${to} · generated ${new Date().toLocaleDateString('en-CA', tz)}`);
    doc.moveDown(1);
    const byPerson = {};
    for (const e of rows) (byPerson[e.person_name] = byPerson[e.person_name] || []).push(e);
    let grand = 0;
    for (const [name, list] of Object.entries(byPerson)) {
      doc.fillColor('#000').fontSize(13).font('Helvetica-Bold').text(name);
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica');
      let personTotal = 0;
      for (const e of list) {
        const breaks = Array.isArray(e.breaks) && e.breaks.length
          ? e.breaks.map((b) => `${fT(b.start)}–${b.end ? fT(b.end) : '…'}`).join(', ')
          : (e.break_seconds > 0 ? `${Math.round(e.break_seconds / 60)} min` : '—');
        const paid = e.paid_hours != null ? Number(e.paid_hours) : null;
        if (paid != null) personTotal += paid;
        doc.fillColor('#333').text(
          `${fD(e.clock_in)}    ${fT(e.clock_in)} → ${e.clock_out ? fT(e.clock_out) : 'on shift'}    breaks: ${breaks}    paid: ${paid != null ? paid.toFixed(2) + ' h' : '—'}${e.source === 'manual' ? '    (manual)' : ''}`,
          { indent: 12 });
      }
      personTotal = Math.round(personTotal * 100) / 100;
      grand += personTotal;
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text(`Total: ${personTotal.toFixed(2)} h`, { indent: 12 });
      doc.moveDown(0.8);
    }
    if (!rows.length) doc.fontSize(11).fillColor('#555').text('No punches in this period.');
    if (Object.keys(byPerson).length > 1) {
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text(`Crew total: ${(Math.round(grand * 100) / 100).toFixed(2)} h`);
    }
    doc.end();
    return done;
  };

  router.get('/:locationId/export-pdf', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { from, to, person } = req.query;
      if (!isDate(from) || !isDate(to)) return fail(res, 'from + to (YYYY-MM-DD) required', 400);
      const buf = await buildTimesheetPdf(req.params.locationId, from, to, person);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="timesheet-${from}-to-${to}.pdf"`);
      res.send(buf);
    } catch (e) { fail(res, e); }
  });

  // Email the period PDF (uses the same Gmail app password the brief reads with).
  router.post('/:locationId/email-timesheet', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { from, to, person, email } = req.body || {};
      if (!isDate(from) || !isDate(to)) return fail(res, 'from + to required', 400);
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 'Valid recipient email required', 400);
      const user = process.env.GMAIL_IMAP_USER, pass = process.env.GMAIL_IMAP_PASS;
      if (!user || !pass) return fail(res, 'Email not configured (GMAIL_IMAP_USER / GMAIL_IMAP_PASS)', 400);
      const buf = await buildTimesheetPdf(req.params.locationId, from, to, person);
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
      await transporter.sendMail({
        from: user, to: email,
        subject: `Timesheet ${from} to ${to}${person && person !== 'all' ? ' (individual)' : ' (crew)'}`,
        text: `Attached: the timesheet PDF for the pay period ${from} to ${to}. Generated by the ops dashboard.`,
        attachments: [{ filename: `timesheet-${from}-to-${to}.pdf`, content: buf }],
      });
      res.json({ ok: true, sent_to: email });
    } catch (e) { fail(res, e); }
  });

  // Owner/manager photo fallback — upload a picture for a tech from the admin
  // page when the kiosk camera isn't an option. Same size/format rules.
  router.put('/:locationId/person/:pid/photo', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { photo_base64, photo_mime, clear } = req.body || {};
      if (clear) {
        await pool.query('UPDATE bonus_person SET photo=NULL, photo_mime=NULL WHERE id=$1 AND location_id=$2', [req.params.pid, req.params.locationId]);
        return res.json({ ok: true, cleared: true });
      }
      if (!photo_base64) return fail(res, 'photo_base64 required', 400);
      const buf = Buffer.from(String(photo_base64), 'base64');
      if (buf.length > 600 * 1024) return fail(res, 'Photo too large', 400);
      const mime = /^image\/(jpeg|png|webp)$/.test(photo_mime || '') ? photo_mime : 'image/jpeg';
      const { rows } = await pool.query('UPDATE bonus_person SET photo=$3, photo_mime=$4 WHERE id=$1 AND location_id=$2 RETURNING name', [req.params.pid, req.params.locationId, buf, mime]);
      if (!rows.length) return fail(res, 'Person not found', 404);
      res.json({ ok: true, name: rows[0].name });
    } catch (e) { fail(res, e); }
  });

  // Set / clear a person's kiosk PIN (4–6 digits; null clears).
  router.put('/:locationId/person/:pid/pin', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const pin = (req.body || {}).pin;
      if (pin != null && !/^\d{4,6}$/.test(String(pin))) return fail(res, 'PIN must be 4–6 digits', 400);
      const { rows } = await pool.query('UPDATE bonus_person SET clock_pin=$2 WHERE id=$1 AND location_id=$3 RETURNING id, name', [req.params.pid, pin == null ? null : String(pin), req.params.locationId]);
      if (!rows.length) return fail(res, 'Person not found', 404);
      res.json({ ok: true, name: rows[0].name, has_pin: pin != null });
    } catch (e) { fail(res, e); }
  });

  return router;
};
