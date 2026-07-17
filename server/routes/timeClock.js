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

  // Roster + each person's current clock status.
  router.get('/:locationId/roster', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const { rows: people } = await pool.query(
        'SELECT id, name, role, (clock_pin IS NOT NULL) AS has_pin FROM bonus_person WHERE location_id=$1 AND active=true ORDER BY role, name',
        [req.params.locationId]);
      const { rows: open } = await pool.query(
        'SELECT person_id, clock_in, break_started_at FROM time_clock_entry WHERE location_id=$1 AND clock_out IS NULL',
        [req.params.locationId]);
      const byId = {}; for (const o of open) byId[o.person_id] = o;
      res.json({
        people: people.map((p) => ({
          id: p.id, name: p.name, role: p.role, has_pin: p.has_pin,
          status: statusOf(byId[p.id]), since: byId[p.id] ? (byId[p.id].break_started_at || byId[p.id].clock_in) : null,
          clock_in: byId[p.id] ? byId[p.id].clock_in : null,   // original in-time, always
        })),
      });
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
      if (action === 'break_start') {
        if (open.break_started_at) return fail(res, 'Already on break', 409);
        await pool.query('UPDATE time_clock_entry SET break_started_at=now() WHERE id=$1', [open.id]);
        return res.json({ status: 'break', name: person.name });
      }
      if (action === 'break_end') {
        if (!open.break_started_at) return fail(res, 'Not on break', 409);
        await pool.query("UPDATE time_clock_entry SET break_seconds = break_seconds + EXTRACT(EPOCH FROM (now() - break_started_at)), break_started_at = NULL WHERE id=$1", [open.id]);
        // clock_in returned so the kiosk can reassure: the original shift is intact.
        return res.json({ status: 'on', name: person.name, clock_in: open.clock_in });
      }
      // out — auto-close an open break first; report the day's paid hours back.
      const { rows: closed } = await pool.query(
        `UPDATE time_clock_entry
            SET break_seconds = break_seconds + COALESCE(EXTRACT(EPOCH FROM (now() - break_started_at)), 0),
                break_started_at = NULL, clock_out = now()
          WHERE id=$1
          RETURNING ROUND((EXTRACT(EPOCH FROM (clock_out - clock_in)) - break_seconds)/3600.0, 2) AS paid_hours`, [open.id]);
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
      const breakSec = b.break_minutes === undefined ? er[0].break_seconds : Math.round(Number(b.break_minutes) * 60);
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
