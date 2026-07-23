const express = require('express');
const crypto = require('crypto');
const { authenticateToken, requireRole, canAccessLocation } = require('../middleware/auth');
const { ensureTimeClockTables, paidHoursByMonth, paidHoursByRange, approvedOffDaysByRange, toIsodow } = require('../lib/timeClockSchema');
const { workingDaysBetween, holidaysBetween, openDaySet } = require('../lib/workdays');
const { notifyRoles } = require('../lib/notify');

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
  const LOC_MAX_FAILS = 60;   // per-location backstop: survives X-Forwarded-For spoofing
  const fails = new Map();
  const locFails = new Map();  // keyed by locationId only — IP-independent
  const rlKey = (req, loc) => ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown') + '|' + loc;
  const isLocked = (k, loc) => {
    const e = fails.get(k); if (e && e.lockedUntil > Date.now()) return true;
    const l = locFails.get(loc); return !!(l && l.lockedUntil > Date.now());
  };
  const recordFail = (k, loc) => {
    const now = Date.now();
    let e = fails.get(k);
    if (!e || now - e.first > WINDOW_MS) e = { first: now, count: 0, lockedUntil: 0 };
    e.count++; if (e.count >= MAX_FAILS) e.lockedUntil = now + LOCK_MS; fails.set(k, e);
    if (loc) {
      let l = locFails.get(loc);
      if (!l || now - l.first > WINDOW_MS) l = { first: now, count: 0, lockedUntil: 0 };
      l.count++; if (l.count >= LOC_MAX_FAILS) l.lockedUntil = now + LOC_MS; locFails.set(loc, l);
    }
  };
  const LOC_MS = 15 * 60 * 1000;
  const pinEqual = (a, b) => {
    const ab = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
    if (!ab.length || ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  };

  const statusOf = (row) => !row ? 'off' : (row.break_started_at ? 'break' : 'on');

  // ══ SHIFT RULES ════════════════════════════════════════════════════════
  // Per-location shift window: clock-in before the start records the start;
  // still clocked in past the end auto-clocks out at the end (with an overtime
  // question next time). Applied only on the location's open days.
  const EDM = 'America/Edmonton';
  const edmToday = () => new Date().toLocaleDateString('en-CA', { timeZone: EDM });
  const edmDow = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();   // 0=Sun..6
  const shiftCfg = async (locationId) => {
    const { rows } = await pool.query('SELECT shift_start, shift_end, break_minutes, open_days FROM locations WHERE id=$1', [locationId]);
    const r = rows[0] || {};
    return { start: r.shift_start || null, end: r.shift_end || null, breakMin: r.break_minutes, openSet: openDaySet(r.open_days) };
  };
  const isOpenDay = (cfg, iso) => cfg.openSet.has(edmDow(iso));

  // Insert a follow-up question once per (entry, kind). Params are cast
  // explicitly — each is referenced twice, so Postgres can't infer the type.
  const addFollowup = (locationId, personId, entryId, kind, workDate) => pool.query(
    `INSERT INTO clock_followup (location_id, person_id, entry_id, kind, work_date)
       SELECT $1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::date
        WHERE NOT EXISTS (SELECT 1 FROM clock_followup WHERE entry_id=$3::uuid AND kind=$4::varchar)`,
    [locationId, personId, entryId, kind, workDate]);

  // Close any punch left open past its day's shift end — bounds forgotten
  // clock-outs and raises the overtime (and missed-break) questions.
  const autoCloseStale = async (locationId, cfg) => {
    if (!cfg.end) return;
    // Only clamp punches whose clock-in day is an OPEN day — same gate the
    // clock-in path uses. A forgotten Saturday-emergency punch on a Mon-Fri shop
    // has no shift_end to clamp to, so it's left open for a human to correct
    // rather than force-closed to weekday rules (which over/underpaid). Also fold
    // any in-progress break into break_seconds (capped at the clamped clock_out)
    // so an unfinished break isn't silently paid.
    const openDows = Array.from(cfg.openSet);
    const { rows } = await pool.query(
      `WITH s AS (
         SELECT id, person_id,
           (to_char(clock_in AT TIME ZONE '${EDM}','YYYY-MM-DD')||' '||$2::text)::timestamp AT TIME ZONE '${EDM}' AS end_ts,
           clock_in
         FROM time_clock_entry
          WHERE location_id=$1 AND clock_out IS NULL
            AND EXTRACT(DOW FROM clock_in AT TIME ZONE '${EDM}')::int = ANY($3::int[]))
       UPDATE time_clock_entry e
          SET clock_out = GREATEST(s.end_ts, e.clock_in),
              break_seconds = e.break_seconds + CASE WHEN e.break_started_at IS NOT NULL
                THEN GREATEST(0, EXTRACT(EPOCH FROM (GREATEST(s.end_ts, e.clock_in) - e.break_started_at)))::int ELSE 0 END,
              raw_clock_out = now(), auto_out = true, break_started_at = NULL
         FROM s WHERE e.id = s.id AND now() > s.end_ts
       RETURNING e.id, e.person_id, e.break_seconds, (e.clock_out AT TIME ZONE '${EDM}')::date::text AS work_date`,
      [locationId, cfg.end, openDows]);
    if (!rows.length) return;
    const { rows: pp } = await pool.query('SELECT id, track_break FROM bonus_person WHERE id = ANY($1)', [rows.map((r) => r.person_id)]);
    const tb = Object.fromEntries(pp.map((p) => [p.id, p.track_break !== false]));
    for (const r of rows) {
      await addFollowup(locationId, r.person_id, r.id, 'overtime', r.work_date);
      if (tb[r.person_id] && Number(r.break_seconds) === 0) await addFollowup(locationId, r.person_id, r.id, 'break', r.work_date);
    }
  };

  // Shared punch engine — used by both the PIN kiosk and the RFID fob path.
  const doPunch = async (res, locationId, person, action, cfg) => {
    await autoCloseStale(locationId, cfg);
    const { rows: openRows } = await pool.query('SELECT * FROM time_clock_entry WHERE person_id=$1 AND clock_out IS NULL', [person.id]);
    const open = openRows[0];
    const today = edmToday();
    const clamp = !!(cfg.start && cfg.end && isOpenDay(cfg, today));

    if (action === 'in') {
      if (open) return fail(res, `${person.name} is already clocked in`, 409);
      if (clamp) {
        await pool.query(
          `INSERT INTO time_clock_entry (location_id, person_id, clock_in, raw_clock_in, source, created_by)
             VALUES ($1,$2, GREATEST(now(), ($3::text||' '||$4::text)::timestamp AT TIME ZONE '${EDM}'), now(), 'kiosk', $5)`,
          [locationId, person.id, today, cfg.start, person.name]);
      } else {
        await pool.query('INSERT INTO time_clock_entry (location_id, person_id, clock_in, raw_clock_in, source, created_by) VALUES ($1,$2,now(),now(),$3,$4)', [locationId, person.id, 'kiosk', person.name]);
      }
      return res.json({ status: 'on', name: person.name });
    }
    if (!open) return fail(res, `${person.name} is not clocked in`, 409);
    const segs = Array.isArray(open.breaks) ? open.breaks : [];
    if (action === 'break_start') {
      if (person.track_break === false) return fail(res, 'Break tracking is off for this person', 400);
      if (open.break_started_at) return fail(res, 'Already on break', 409);
      await pool.query('UPDATE time_clock_entry SET break_started_at=now(), breaks=$2 WHERE id=$1', [open.id, JSON.stringify([...segs, { start: new Date().toISOString() }])]);
      return res.json({ status: 'break', name: person.name });
    }
    const closeSegs = () => { if (!segs.length || segs[segs.length - 1].end) return segs; return [...segs.slice(0, -1), { ...segs[segs.length - 1], end: new Date().toISOString() }]; };
    if (action === 'break_end') {
      if (!open.break_started_at) return fail(res, 'Not on break', 409);
      await pool.query("UPDATE time_clock_entry SET break_seconds = break_seconds + EXTRACT(EPOCH FROM (now() - break_started_at)), break_started_at = NULL, breaks=$2 WHERE id=$1", [open.id, JSON.stringify(closeSegs())]);
      return res.json({ status: 'on', name: person.name, clock_in: open.clock_in });
    }
    // out — clamp to shift end on open days; flag OT if clamped, missed break if none logged.
    const { rows: closed } = await pool.query(
      `UPDATE time_clock_entry
          SET break_seconds = break_seconds + COALESCE(EXTRACT(EPOCH FROM (now() - break_started_at)), 0),
              break_started_at = NULL, breaks=$2, raw_clock_out = now(),
              clock_out = CASE WHEN $3 THEN LEAST(now(), ($4::text||' '||$5::text)::timestamp AT TIME ZONE '${EDM}') ELSE now() END
        WHERE id=$1
        RETURNING id, break_seconds, (raw_clock_out > clock_out) AS was_ot,
          (clock_out AT TIME ZONE '${EDM}')::date::text AS work_date,
          ROUND(GREATEST(0, EXTRACT(EPOCH FROM (clock_out - clock_in)) - break_seconds)/3600.0, 2) AS paid_hours`,
      [open.id, JSON.stringify(open.break_started_at ? closeSegs() : segs), clamp, today, cfg.end || '23:59']);
    const c = closed[0];
    const missedBreak = person.track_break !== false && Number(c.break_seconds) === 0;
    if (c.was_ot) await addFollowup(locationId, person.id, c.id, 'overtime', c.work_date);
    if (missedBreak) await addFollowup(locationId, person.id, c.id, 'break', c.work_date);
    return res.json({ status: 'off', name: person.name, paid_hours: Number(c.paid_hours), overtime_flagged: c.was_ot, break_flagged: missedBreak });
  };

  // ══ KIOSK (public, PIN-gated) ══════════════════════════════════════════
  const checkLocPin = async (req, res) => {
    const rk = rlKey(req, req.params.locationId);
    if (isLocked(rk, req.params.locationId)) { res.status(429).json({ error: 'Too many attempts. Try again later.' }); return null; }
    const { rows } = await pool.query('SELECT display_pin FROM locations WHERE id=$1', [req.params.locationId]);
    if (!rows.length) { res.status(404).json({ error: 'Location not found' }); return null; }
    const pin = (req.query.pin || (req.body || {}).loc_pin || '').toString();
    if (!rows[0].display_pin) { res.status(403).json({ error: 'Set a display PIN for this location first (under Locations).' }); return null; }
    if (!pinEqual(pin, rows[0].display_pin)) { recordFail(rk, req.params.locationId); res.status(401).json({ error: 'Incorrect PIN' }); return null; }
    fails.delete(rk);
    return true;
  };

  const photoUri = (p) => (p.photo ? `data:${p.photo_mime || 'image/jpeg'};base64,${p.photo.toString('base64')}` : null);

  // Roster + each person's current clock status (+ their colour and photo).
  router.get('/:locationId/roster', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      await autoCloseStale(req.params.locationId, await shiftCfg(req.params.locationId));
      const { rows: people } = await pool.query(
        'SELECT id, name, role, color, photo, photo_mime, track_break, (clock_pin IS NOT NULL) AS has_pin, (rfid_tag IS NOT NULL) AS has_tag FROM bonus_person WHERE location_id=$1 AND active=true ORDER BY role, name',
        [req.params.locationId]);
      const { rows: open } = await pool.query(
        'SELECT person_id, clock_in, break_started_at FROM time_clock_entry WHERE location_id=$1 AND clock_out IS NULL',
        [req.params.locationId]);
      const byId = {}; for (const o of open) byId[o.person_id] = o;
      res.json({
        people: people.map((p) => ({
          id: p.id, name: p.name, role: p.role, has_pin: p.has_pin, has_tag: p.has_tag, track_break: p.track_break !== false,
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
    if (isLocked(rk, req.params.locationId)) { fail(res, 'Too many incorrect PINs. Try again later.', 429); return null; }
    if (!pinEqual(pin, rows[0].clock_pin)) { recordFail(rk, req.params.locationId); fail(res, 'Incorrect PIN', 401); return null; }
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
      // Personal holiday balance in HOURS (matches QuickBooks): allowance hours
      // vs approved vacation hours (working days × the contractual daily hours).
      const { rows: vp } = await pool.query('SELECT vacation_hours_per_year FROM bonus_person WHERE id=$1', [person.id]);
      const { rows: vu } = await pool.query(
        "SELECT COALESCE(SUM(working_days),0) AS d FROM time_off_request WHERE person_id=$1 AND status='approved' AND type='vacation' AND to_char(start_date,'YYYY')=$2",
        [person.id, String(new Date().getFullYear())]);
      const { rows: lrb } = await pool.query('SELECT open_days, weekly_hours FROM locations WHERE id=$1', [req.params.locationId]);
      const perDayB = Math.round(((Number((lrb[0] || {}).weekly_hours) || 40) / openDaySet((lrb[0] || {}).open_days).size) * 100) / 100;
      const allowance = vp[0] && vp[0].vacation_hours_per_year != null ? Number(vp[0].vacation_hours_per_year) : null;
      const used = Math.round((Number(vu[0].d) || 0) * perDayB * 100) / 100;
      res.json({
        from, to, entries, total_paid: total, name: person.name,
        holidays: { allowance, used, left: allowance != null ? Math.max(0, allowance - used) : null },
      });
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
      notifyRoles(pool, {
        roles: ['owner', 'partner', 'manager'], locationId: req.params.locationId,
        title: '✎ Punch change request', body: `${person.name.split(' ')[0]} — ${String(note).slice(0, 80)}`,
        path: '/time-clock', tag: `edit-${person.id}`,
      });
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
      const { rows: pr } = await pool.query('SELECT id, name, clock_pin, track_break FROM bonus_person WHERE id=$1 AND location_id=$2 AND active=true', [person_id, req.params.locationId]);
      if (!pr.length) return fail(res, 'Person not found', 404);
      const person = pr[0];
      if (!person.clock_pin) return fail(res, 'No clock PIN set for this person — ask the owner to set one.', 400);
      const rk = rlKey(req, req.params.locationId) + '|' + person_id;
      if (isLocked(rk, req.params.locationId)) return fail(res, 'Too many incorrect PINs for this person. Try again later.', 429);
      if (!pinEqual(pin, person.clock_pin)) { recordFail(rk, req.params.locationId); return fail(res, 'Incorrect PIN', 401); }
      fails.delete(rk);
      return doPunch(res, req.params.locationId, person, action, await shiftCfg(req.params.locationId));
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
      const { rows: lr } = await pool.query('SELECT province, open_days, weekly_hours FROM locations WHERE id=$1', [req.params.locationId]);
      const perDayBd = Math.round(((Number((lr[0] || {}).weekly_hours) || 40) / openDaySet((lr[0] || {}).open_days).size) * 100) / 100;
      for (const r of rows) r.hours = Math.round((r.working_days || 0) * perDayBd * 100) / 100;
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
      const { person_id, pin, start_date, end_date, type, note, paid } = req.body || {};
      if (!person_id || !isDate(start_date) || !isDate(end_date)) return fail(res, 'person_id + start_date + end_date required', 400);
      if (end_date < start_date) return fail(res, 'End date is before start date', 400);
      if (!OFF_TYPES.includes(type || 'vacation')) return fail(res, 'Invalid type', 400);
      const { rows: pr } = await pool.query('SELECT id, name, clock_pin FROM bonus_person WHERE id=$1 AND location_id=$2 AND active=true', [person_id, req.params.locationId]);
      if (!pr.length) return fail(res, 'Person not found', 404);
      if (!pr[0].clock_pin) return fail(res, 'No clock PIN set — ask the owner to set one.', 400);
      const rk = rlKey(req, req.params.locationId) + '|' + person_id;
      if (isLocked(rk, req.params.locationId)) return fail(res, 'Too many incorrect PINs. Try again later.', 429);
      if (!pinEqual(pin, pr[0].clock_pin)) { recordFail(rk, req.params.locationId); return fail(res, 'Incorrect PIN', 401); }
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
        `INSERT INTO time_off_request (location_id, person_id, start_date, end_date, type, note, working_days, paid)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [req.params.locationId, person_id, start_date, end_date, type || 'vacation', String(note || '').slice(0, 300), days,
         typeof paid === 'boolean' ? paid : null]);
      const perDayR = Math.round(((Number((locRows[0] || {}).weekly_hours) || 40) / openDaySet((locRows[0] || {}).open_days).size) * 100) / 100;
      notifyRoles(pool, {
        roles: ['owner', 'partner', 'manager'], locationId: req.params.locationId,
        title: '🏖 Time-off request', body: `${pr[0].name.split(' ')[0]} — ${start_date} to ${end_date} (${Math.round(days * perDayR * 100) / 100} h)`,
        path: '/time-clock', tag: `timeoff-${rows[0].id}`,
      });
      res.json({ ok: true, id: rows[0].id, working_days: days, hours: Math.round(days * perDayR * 100) / 100, name: pr[0].name });
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
  const paidExpr = "ROUND(GREATEST(0, EXTRACT(EPOCH FROM (clock_out - clock_in)) - break_seconds)/3600.0, 2)";

  // Payroll components beyond punches (Jamie's contractual rules):
  //  • a stat holiday landing on an OPEN day pays every tech the contractual
  //    daily hours (weekly ÷ open days) without punching;
  //  • approved PAID time off pays the same daily hours per open day taken
  //    (stat holidays inside a holiday never double-pay).
  const periodPayContext = async (locationId, from, to) => {
    const { rows: lr } = await pool.query('SELECT province, open_days, weekly_hours FROM locations WHERE id=$1', [locationId]);
    const loc = lr[0] || {};
    const openSet = openDaySet(loc.open_days);
    const perDay = Math.round(((Number(loc.weekly_hours) || 40) / openSet.size) * 100) / 100;
    const hols = holidaysBetween(loc.province || 'ab', from, to);
    const holSet = new Set(hols.map((h) => h.date));
    const statDays = hols.filter((h) => openSet.has(new Date(h.date + 'T12:00:00').getDay()));
    const { rows: reqs } = await pool.query(
      `SELECT person_id, start_date::text AS s, end_date::text AS e FROM time_off_request
        WHERE location_id=$1 AND status='approved' AND paid=true AND person_id IS NOT NULL
          AND start_date <= $3::date AND end_date >= $2::date`, [locationId, from, to]);
    const paidOffDays = {};
    const paidOffRows = [];   // per-request, clipped to the period — punch-list display
    for (const r of reqs) {
      const s = r.s < from ? from : r.s, e = r.e > to ? to : r.e;
      let days = 0;
      for (let d = new Date(s + 'T12:00:00'); d <= new Date(e + 'T12:00:00'); d.setDate(d.getDate() + 1)) {
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!openSet.has(d.getDay()) || holSet.has(iso)) continue;
        days++;
      }
      if (days > 0) {
        paidOffDays[r.person_id] = (paidOffDays[r.person_id] || 0) + days;
        paidOffRows.push({ person_id: r.person_id, from: s, to: e, days, hours: Math.round(days * perDay * 100) / 100 });
      }
    }
    const paidOffHours = {};
    for (const [pid, days] of Object.entries(paidOffDays)) paidOffHours[pid] = Math.round(days * perDay * 100) / 100;
    return { perDay, statDays, statHours: Math.round(statDays.length * perDay * 100) / 100, paidOffDays, paidOffHours, paidOffRows };
  };

  // Entries for review + correction, with computed paid hours. Accepts either
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD (payroll periods) or ?month=YYYY-MM.
  // Advisors may READ (hours only — no wages exist in the system); corrections
  // stay owner/partner/manager.
  router.get('/:locationId/entries', authenticateToken, requireRole('owner', 'partner', 'manager', 'advisor'), scoped, async (req, res) => {
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
      let off_days = {}, closure_days = 0, stat_holidays = [], pay = null;
      if (range) {
        const { rows: lr } = await pool.query('SELECT province, open_days FROM locations WHERE id=$1', [req.params.locationId]);
        const loc = lr[0] || {};
        const off = await approvedOffDaysByRange(pool, req.params.locationId, range[0], range[1], toIsodow(openDaySet(loc.open_days)));
        off_days = off.byPerson; closure_days = off.closure;
        stat_holidays = holidaysBetween(loc.province || 'ab', range[0], range[1]);
        pay = await periodPayContext(req.params.locationId, range[0], range[1]);
      }
      res.json({
        month: month || null, from: range ? range[0] : null, to: range ? range[1] : null, entries: rows, summary,
        off_days, closure_days, stat_holidays,
        per_day_hours: pay ? pay.perDay : null,
        stat_pay_hours: pay ? pay.statHours : 0,             // added to EVERY tech (stat on an open day = paid day)
        stat_pay_days: pay ? pay.statDays : [],
        paid_timeoff_hours: pay ? pay.paidOffHours : {},     // per person: approved PAID holiday hours in period
        paid_timeoff_rows: pay ? pay.paidOffRows : [],       // per request (clipped) — shown as rows in the punch list
      });
    } catch (e) { fail(res, e); }
  });

  // Biweekly pay periods, anchored at locations.pay_period_anchor (a period
  // start date; default 2026-01-04). Returns the current + previous N periods.
  // Advisors read it for the Home crew-paid deck (dates only).
  router.get('/:locationId/pay-periods', authenticateToken, requireRole('owner', 'partner', 'manager', 'advisor'), scoped, async (req, res) => {
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
  // Advisors may READ (Home decks); deciding stays owner/partner/manager.
  router.get('/:locationId/timeoff', authenticateToken, requireRole('owner', 'partner', 'manager', 'advisor'), scoped, async (req, res) => {
    try {
      await ensure();
      const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : String(new Date().getFullYear());
      const { rows: requests } = await pool.query(
        `SELECT r.*, r.start_date::text AS start_date, r.end_date::text AS end_date, COALESCE(p.name, 'Shop closed') AS person_name
           FROM time_off_request r LEFT JOIN bonus_person p ON p.id = r.person_id
          WHERE r.location_id=$1 AND (to_char(r.start_date,'YYYY')=$2 OR to_char(r.end_date,'YYYY')=$2)
          ORDER BY r.status='pending' DESC, r.start_date DESC`, [req.params.locationId, year]);
      // Per-day contractual hours (weekly ÷ open days) — the days→hours factor.
      const { rows: lr } = await pool.query('SELECT open_days, weekly_hours FROM locations WHERE id=$1', [req.params.locationId]);
      const openSet = openDaySet((lr[0] || {}).open_days);
      const perDay = Math.round(((Number((lr[0] || {}).weekly_hours) || 40) / openSet.size) * 100) / 100;
      for (const r of requests) r.hours = Math.round((r.working_days || 0) * perDay * 100) / 100;
      // totals + vacation_used tracked in HOURS (QuickBooks-native unit).
      const totals = {}, vacation_used = {};
      for (const r of requests) {
        if (r.status !== 'approved' || !r.person_id) continue;
        totals[r.person_id] = Math.round(((totals[r.person_id] || 0) + r.hours) * 100) / 100;
        if (r.type === 'vacation') vacation_used[r.person_id] = Math.round(((vacation_used[r.person_id] || 0) + r.hours) * 100) / 100;
      }
      res.json({ year, requests, totals, vacation_used, per_day_hours: perDay });
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

  // Paid ↔ unpaid on a request (asked of the tech; owner/manager records it).
  router.put('/timeoff/:id/paid', ...authed, async (req, res) => {
    try {
      await ensure();
      const paid = (req.body || {}).paid;
      if (typeof paid !== 'boolean') return fail(res, 'paid must be true/false', 400);
      const { rows: rr } = await pool.query('SELECT location_id FROM time_off_request WHERE id=$1', [req.params.id]);
      if (!rr.length) return fail(res, 'Request not found', 404);
      if (!canAccessLocation(req.user, rr[0].location_id)) return fail(res, 'Access denied for this location', 403);
      await pool.query('UPDATE time_off_request SET paid=$2 WHERE id=$1', [req.params.id, paid]);
      res.json({ ok: true, paid });
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
      if (isNaN(new Date(clock_in).getTime()) || (clock_out && isNaN(new Date(clock_out).getTime()))) return fail(res, 'Invalid clock time', 400);
      if (clock_out && new Date(clock_out) <= new Date(clock_in)) return fail(res, 'clock_out must be after clock_in', 400);
      // Reject a punch that overlaps an existing one for this person (double-pay
      // guard). COALESCE(clock_out,'infinity') so an OPEN shift counts too — else
      // a manual punch inside a live shift both get paid and double-count hours.
      const ov = await pool.query(
        `SELECT 1 FROM time_clock_entry WHERE person_id=$1
           AND clock_in < $3 AND COALESCE(clock_out, 'infinity') > $2 LIMIT 1`,
        [person_id, clock_in, clock_out || clock_in]);
      if (ov.rows.length) return fail(res, 'That overlaps an existing punch for this person', 409);
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
      if (isNaN(new Date(clockIn).getTime()) || (clockOut && isNaN(new Date(clockOut).getTime()))) return fail(res, 'Invalid clock time', 400);
      if (clockOut && new Date(clockOut) <= new Date(clockIn)) return fail(res, 'clock_out must be after clock_in', 400);
      if (clockOut) {
        const ov = await pool.query(
          `SELECT 1 FROM time_clock_entry WHERE person_id=$1 AND id<>$2
             AND clock_in < $4 AND COALESCE(clock_out, 'infinity') > $3 LIMIT 1`,
          [er[0].person_id, er[0].id, clockIn, clockOut]);
        if (ov.rows.length) return fail(res, 'That overlaps an existing punch for this person', 409);
      }
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
  // clocked in / on break (and since when) right now. Advisors read it for
  // the Home crew deck.
  router.get('/:locationId/status', authenticateToken, requireRole('owner', 'partner', 'manager', 'advisor'), scoped, async (req, res) => {
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
    // Pay beyond punches: stat holidays on open days + approved paid time off.
    const pay = await periodPayContext(locationId, from, to);
    const { rows: crew } = await pool.query(
      'SELECT id, name FROM bonus_person WHERE location_id=$1 AND active=true' + (personId && personId !== 'all' ? ' AND id=$2' : ''),
      personId && personId !== 'all' ? [locationId, personId] : [locationId]);
    const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
    doc.fontSize(16).font('Helvetica-Bold').text(`${locName} — Timesheet`);
    doc.fontSize(11).font('Helvetica').fillColor('#555').text(`Pay period ${from} to ${to} · generated ${new Date().toLocaleDateString('en-CA', tz)}`);
    if (pay.statDays.length) doc.text(`Stat holiday${pay.statDays.length > 1 ? 's' : ''} in period: ${pay.statDays.map((h) => `${h.name} (${h.date})`).join(', ')} — paid ${pay.perDay} h each`);
    doc.moveDown(1);
    const byId = {};
    for (const e of rows) (byId[e.person_id] = byId[e.person_id] || []).push(e);
    let grand = 0, anyRows = false;
    for (const person of crew) {
      const list = byId[person.id] || [];
      const statH = pay.statHours;
      const offH = pay.paidOffHours[person.id] || 0;
      if (!list.length && !statH && !offH) continue;
      anyRows = true;
      doc.fillColor('#000').fontSize(13).font('Helvetica-Bold').text(person.name);
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica');
      let clocked = 0;
      for (const e of list) {
        const breaks = Array.isArray(e.breaks) && e.breaks.length
          ? e.breaks.map((b) => `${fT(b.start)}–${b.end ? fT(b.end) : '…'}`).join(', ')
          : (e.break_seconds > 0 ? `${Math.round(e.break_seconds / 60)} min` : '—');
        const paid = e.paid_hours != null ? Number(e.paid_hours) : null;
        if (paid != null) clocked += paid;
        doc.fillColor('#333').text(
          `${fD(e.clock_in)}    ${fT(e.clock_in)} → ${e.clock_out ? fT(e.clock_out) : 'on shift'}    breaks: ${breaks}    paid: ${paid != null ? paid.toFixed(2) + ' h' : '—'}${e.source === 'manual' ? '    (manual)' : ''}`,
          { indent: 12 });
      }
      clocked = Math.round(clocked * 100) / 100;
      if (statH) doc.fillColor('#333').text(`Stat holiday pay: ${pay.statDays.map((h) => h.name).join(', ')}    ${statH.toFixed(2)} h`, { indent: 12 });
      if (offH) doc.fillColor('#333').text(`Paid holiday: ${offH.toFixed(2)} h`, { indent: 12 });
      const personTotal = Math.round((clocked + statH + offH) * 100) / 100;
      grand += personTotal;
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000')
        .text(`Total: ${personTotal.toFixed(2)} h${(statH || offH) ? `  (clocked ${clocked.toFixed(2)} + stat ${statH.toFixed(2)} + holiday ${offH.toFixed(2)})` : ''}`, { indent: 12 });
      doc.moveDown(0.8);
    }
    if (!anyRows) doc.fontSize(11).fillColor('#555').text('No punches or paid days in this period.');
    if (crew.length > 1) {
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
      const buf = await buildTimesheetPdf(req.params.locationId, from, to, person);
      const subject = `Timesheet ${from} to ${to}${person && person !== 'all' ? ' (individual)' : ' (crew)'}`;
      const text = `Attached: the timesheet PDF for the pay period ${from} to ${to}. Generated by the ops dashboard.`;
      const filename = `timesheet-${from}-to-${to}.pdf`;
      // Preferred: hand the PDF to Make over HTTPS (Railway blocks SMTP ports
      // on non-Pro plans); Make sends via the existing Gmail SMTP connection.
      if (process.env.MAKE_TIMESHEET_WEBHOOK) {
        const resp = await fetch(process.env.MAKE_TIMESHEET_WEBHOOK, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: email, subject, text, filename, pdf_base64: buf.toString('base64') }),
        });
        if (!resp.ok) return fail(res, `Make webhook failed: HTTP ${resp.status}`, 502);
        return res.json({ ok: true, sent_to: email, via: 'make' });
      }
      // Fallback: direct SMTP (works on Railway Pro; IPv4 forced — no v6 route).
      const user = process.env.GMAIL_IMAP_USER, pass = process.env.GMAIL_IMAP_PASS;
      if (!user || !pass) return fail(res, 'Email not configured (set MAKE_TIMESHEET_WEBHOOK or GMAIL_IMAP_USER/PASS)', 400);
      const nodemailer = require('nodemailer');
      const dns = require('dns').promises;
      const { address } = await dns.lookup('smtp.gmail.com', { family: 4 });
      const transporter = nodemailer.createTransport({ host: address, port: 465, secure: true, auth: { user, pass }, tls: { servername: 'smtp.gmail.com' } });
      await transporter.sendMail({
        from: user, to: email, subject, text,
        attachments: [{ filename, content: buf }],
      });
      res.json({ ok: true, sent_to: email, via: 'smtp' });
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

  // ══ RE-ORDER BOARD ════════════════════════════════════════════════════
  // A tech flags low misc stock from the kiosk (shop-PIN gated, tagged to the
  // name they tap — no personal PIN, keep it frictionless). It sits on the
  // board as "requested" until anyone with board access (owner/partner/manager
  // for the location) marks it "ordered" (stays visible), then "received" —
  // which clears it from the kiosk board AND the ops dashboard. Every surface
  // reads the same rows, so the status is identical everywhere.

  // Kiosk: create a request.
  router.post('/:locationId/reorder', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const { person_id, item, qty, note } = req.body || {};
      if (!item || !String(item).trim()) return fail(res, 'What are we low on? Enter an item.', 400);
      let personName = null;
      if (person_id) {
        const { rows: pr } = await pool.query('SELECT name FROM bonus_person WHERE id=$1 AND location_id=$2', [person_id, req.params.locationId]);
        personName = pr[0] ? pr[0].name : null;
      }
      const { rows } = await pool.query(
        `INSERT INTO reorder_request (location_id, person_id, person_name, item, qty, note)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, item`,
        [req.params.locationId, person_id || null, personName, String(item).slice(0, 200), (qty ? String(qty).slice(0, 60) : null), String(note || '').slice(0, 500)]);
      // Ping whoever places orders — fire-and-forget, delivery never blocks the kiosk.
      notifyRoles(pool, {
        roles: ['owner', 'partner', 'manager', 'advisor'], locationId: req.params.locationId,
        title: '📦 Re-order request', body: `${rows[0].item}${qty ? ` (${qty})` : ''}${personName ? ` — ${personName.split(' ')[0]}` : ''}`,
        path: '/reorders', tag: `reorder-${rows[0].id}`,
      });
      res.json({ ok: true, id: rows[0].id, item: rows[0].item });
    } catch (e) { fail(res, e); }
  });

  // Kiosk: see the board so a tech knows it's handled. Requested + ordered
  // stay; "received"/"dismissed" drop off immediately (cleared everywhere).
  router.get('/:locationId/reorder-board', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const { rows } = await pool.query(
        `SELECT id, person_name, item, qty, note, status, created_at
           FROM reorder_request
          WHERE location_id=$1 AND status IN ('requested','ordered')
          ORDER BY (status='requested') DESC, created_at DESC LIMIT 40`, [req.params.locationId]);
      res.json({ requests: rows });
    } catch (e) { fail(res, e); }
  });

  // The re-order board is also the SERVICE ADVISOR's surface — the person who
  // actually places the orders. Advisors get the board + ordered/received, and
  // nothing else on the dashboard (no money pages, no payroll actions).
  const orderers = [authenticateToken, requireRole('owner', 'partner', 'manager', 'advisor')];

  // Admin/advisor: the active board (requested + ordered) — same rows the kiosk shows.
  router.get('/:locationId/reorders', ...orderers, scoped, async (req, res) => {
    try {
      await ensure();
      const { rows } = await pool.query(
        `SELECT * FROM reorder_request WHERE location_id=$1 AND status IN ('requested','ordered')
          ORDER BY (status='requested') DESC, created_at DESC LIMIT 100`, [req.params.locationId]);
      res.json({ requests: rows });
    } catch (e) { fail(res, e); }
  });

  // Advance a request: requested → ordered → received (or dismissed). Anyone
  // with board access for the location can do it — the status is shared, so it
  // updates identically on the kiosk, the Time Clock tab and the rail.
  // Advisors can order/receive but NOT dismiss (or resurrect) a tech's request —
  // quietly killing one is an owner/manager call.
  router.put('/reorder/:id', ...orderers, async (req, res) => {
    try {
      await ensure();
      const action = (req.body || {}).action;
      if (!['ordered', 'received', 'dismissed', 'requested'].includes(action)) return fail(res, 'action must be ordered|received|dismissed|requested', 400);
      if (req.user.role === 'advisor' && !['ordered', 'received'].includes(action)) return fail(res, 'Advisors can mark ordered or received only', 403);
      const { rows: rr } = await pool.query('SELECT * FROM reorder_request WHERE id=$1', [req.params.id]);
      if (!rr.length) return fail(res, 'Request not found', 404);
      const r = rr[0];
      if (!canAccessLocation(req.user, r.location_id)) return fail(res, 'Access denied for this location', 403);
      await pool.query(
        'UPDATE reorder_request SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1',
        [r.id, action, who(req)]);
      res.json({ ok: true, id: r.id, status: action });
    } catch (e) { fail(res, e); }
  });

  // ══ RFID QUICK-CLOCK ═══════════════════════════════════════════════════
  // A Bluetooth HID reader "types" the fob's tag id + Enter on the kiosk.
  // Possession of the fob authenticates (no PIN). No action → identify the
  // person + return their state and any pending questions; with action →
  // perform the punch through the same rules engine as the PIN path.
  router.post('/:locationId/rfid', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const tag = (req.body || {}).tag;
      const action = (req.body || {}).action;
      if (!tag || !String(tag).trim()) return fail(res, 'No fob read', 400);
      const { rows: pr } = await pool.query(
        'SELECT id, name, color, photo, photo_mime, track_break FROM bonus_person WHERE location_id=$1 AND rfid_tag=$2 AND active=true',
        [req.params.locationId, String(tag).trim().slice(0, 64)]);
      if (!pr.length) return fail(res, 'Unknown fob — ask the owner to register it.', 404);
      const person = pr[0];
      const cfg = await shiftCfg(req.params.locationId);
      if (action) {
        if (!['in', 'break_start', 'break_end', 'out'].includes(action)) return fail(res, 'bad action', 400);
        return doPunch(res, req.params.locationId, person, action, cfg);
      }
      await autoCloseStale(req.params.locationId, cfg);
      const { rows: openRows } = await pool.query('SELECT clock_in, break_started_at FROM time_clock_entry WHERE person_id=$1 AND clock_out IS NULL', [person.id]);
      const open = openRows[0];
      const { rows: fu } = await pool.query("SELECT id, kind, work_date::text AS work_date FROM clock_followup WHERE person_id=$1 AND status='pending' ORDER BY work_date", [person.id]);
      res.json({
        id: person.id, name: person.name, color: person.color || null, photo: photoUri(person),
        track_break: person.track_break !== false, status: statusOf(open),
        clock_in: open ? open.clock_in : null, since: open ? (open.break_started_at || open.clock_in) : null,
        followups: fu, break_minutes: cfg.breakMin,
      });
    } catch (e) { fail(res, e); }
  });

  // Tech answers a pending follow-up on the kiosk (loc-PIN gated). Overtime →
  // hours; break → minutes (+ whether they took one). Goes to owner approval.
  router.post('/:locationId/followup/:id/answer', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const b = req.body || {};
      const { rows: fr } = await pool.query("SELECT * FROM clock_followup WHERE id=$1 AND location_id=$2 AND status='pending'", [req.params.id, req.params.locationId]);
      if (!fr.length) return fail(res, 'Question not found', 404);
      const f = fr[0];
      let hours = 0, took = null;
      if (f.kind === 'overtime') {
        hours = Number(b.hours);
        if (!Number.isFinite(hours) || hours < 0 || hours > 12) return fail(res, 'Enter overtime hours (0–12)', 400);
      } else {
        took = !!b.took_break;
        if (took) { const m = Number(b.minutes); if (!Number.isFinite(m) || m <= 0 || m > 480) return fail(res, 'Enter your break length in minutes', 400); hours = m / 60; }
      }
      await pool.query("UPDATE clock_followup SET status='answered', answer_hours=$2, took_break=$3, answered_at=now() WHERE id=$1", [f.id, hours, took]);
      pool.query('SELECT name FROM bonus_person WHERE id=$1', [f.person_id]).then(({ rows: pn }) => notifyRoles(pool, {
        roles: ['owner', 'partner', 'manager'], locationId: req.params.locationId,
        title: f.kind === 'overtime' ? '⏱ Overtime claim' : '⏱ Break answer',
        body: `${((pn[0] || {}).name || 'Tech').split(' ')[0]} — ${f.kind === 'overtime' ? `${hours} h overtime` : (took ? `${Math.round(hours * 60)} min break` : 'no break taken')} · needs your OK`,
        path: '/time-clock', tag: `followup-${f.id}`,
      })).catch(() => {});
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ── "My work" — a tech's own invoiced labour this month (kiosk) ─────────
  // Hours only, never dollars (shop-floor rule). Reads tech_work_detail rows
  // persisted by the 2h refresh-tech sync; matches the person to Shopmonkey
  // tech names the same way the bonus billed-hours pull does (first name,
  // accents/case folded). Auth: the person's own PIN or their fob.
  const normName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  router.post('/:locationId/my-work', async (req, res) => {
    try {
      await ensure();
      if (!(await checkLocPin(req, res))) return;
      const { tag } = req.body || {};
      let person;
      if (tag) {
        const { rows } = await pool.query('SELECT id, name FROM bonus_person WHERE location_id=$1 AND rfid_tag=$2 AND active=true', [req.params.locationId, String(tag).trim().slice(0, 64)]);
        if (!rows.length) return fail(res, 'Unknown fob', 404);
        person = rows[0];
      } else {
        person = await personAuth(req, res);
        if (!person) return;
      }
      const month = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }).slice(0, 7);
      const first = normName(person.name).split(' ')[0];
      const work = await pool.query(
        `SELECT order_number, invoiced_date::text AS invoiced_date, vehicle, tech_name, hours_sold, hours_billed, synced_at
           FROM tech_work_detail WHERE location_id=$1 AND month=$2
          ORDER BY invoiced_date DESC NULLS LAST, order_number DESC`, [req.params.locationId, month]).then((r) => r.rows).catch(() => []);
      const mine = work.filter((w) => { const n = normName(w.tech_name); return n === first || n.startsWith(first + ' '); });
      const clocked = (await paidHoursByMonth(pool, req.params.locationId, month))[person.id] || 0;
      res.json({
        name: person.name, month,
        synced_at: work.length ? work[0].synced_at : null,
        total_hours: Math.round(mine.reduce((s, w) => s + Number(w.hours_sold), 0) * 10) / 10,
        total_billed: Math.round(mine.reduce((s, w) => s + Number(w.hours_billed), 0) * 10) / 10,
        vehicles: new Set(mine.map((w) => w.order_number)).size,
        clocked_hours: clocked,
        rows: mine.map((w) => ({ date: w.invoiced_date, ro: w.order_number, vehicle: w.vehicle, hours: Number(w.hours_sold) })),
      });
    } catch (e) { fail(res, e); }
  });

  // ── Admin: RFID enroll + break toggle + shift settings + approvals ──────
  router.put('/:locationId/person/:pid/rfid', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      let tag = (req.body || {}).tag;
      tag = (tag == null || tag === '') ? null : String(tag).trim().slice(0, 64);
      if (tag) {
        const { rows: dup } = await pool.query('SELECT name FROM bonus_person WHERE location_id=$1 AND rfid_tag=$2 AND id<>$3', [req.params.locationId, tag, req.params.pid]);
        if (dup.length) return fail(res, `That fob is already registered to ${dup[0].name}`, 409);
      }
      const { rows } = await pool.query('UPDATE bonus_person SET rfid_tag=$2 WHERE id=$1 AND location_id=$3 RETURNING id, name', [req.params.pid, tag, req.params.locationId]);
      if (!rows.length) return fail(res, 'Person not found', 404);
      res.json({ ok: true, name: rows[0].name, has_tag: !!tag });
    } catch (e) { fail(res, e); }
  });

  router.put('/:locationId/person/:pid/track-break', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const on = !!(req.body || {}).track_break;
      const { rows } = await pool.query('UPDATE bonus_person SET track_break=$2 WHERE id=$1 AND location_id=$3 RETURNING id, name', [req.params.pid, on, req.params.locationId]);
      if (!rows.length) return fail(res, 'Person not found', 404);
      res.json({ ok: true, name: rows[0].name, track_break: on });
    } catch (e) { fail(res, e); }
  });

  // Admin: current shift window + break, plus each person's fob/break state.
  router.get('/:locationId/shift-settings', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { rows: lr } = await pool.query("SELECT to_char(shift_start,'HH24:MI') AS shift_start, to_char(shift_end,'HH24:MI') AS shift_end, break_minutes FROM locations WHERE id=$1", [req.params.locationId]);
      const { rows: pr } = await pool.query('SELECT id, name, role, track_break, (rfid_tag IS NOT NULL) AS has_tag FROM bonus_person WHERE location_id=$1 AND active=true ORDER BY role, name', [req.params.locationId]);
      res.json({ ...(lr[0] || { shift_start: null, shift_end: null, break_minutes: null }), people: pr.map((p) => ({ ...p, track_break: p.track_break !== false })) });
    } catch (e) { fail(res, e); }
  });

  // Owner sets the shift window + standard break (per location).
  router.put('/:locationId/shift-settings', authenticateToken, requireRole('owner', 'partner'), async (req, res) => {
    try {
      await ensure();
      const b = req.body || {};
      const t = (v) => (v == null || v === '') ? null : (/^\d{1,2}:\d{2}$/.test(String(v)) ? String(v) : undefined);
      const start = t(b.shift_start), end = t(b.shift_end);
      if (start === undefined || end === undefined) return fail(res, 'Times must be HH:MM (24-hour), or blank', 400);
      let brk = b.break_minutes;
      brk = (brk == null || brk === '') ? null : Math.round(Number(brk));
      if (brk !== null && (!Number.isFinite(brk) || brk < 0 || brk > 480)) return fail(res, 'Break minutes must be 0–480', 400);
      const { rows } = await pool.query('UPDATE locations SET shift_start=$2, shift_end=$3, break_minutes=$4 WHERE id=$1 RETURNING to_char(shift_start,\'HH24:MI\') AS shift_start, to_char(shift_end,\'HH24:MI\') AS shift_end, break_minutes', [req.params.locationId, start, end, brk]);
      if (!rows.length) return fail(res, 'Location not found', 404);
      res.json({ ok: true, ...rows[0] });
    } catch (e) { fail(res, e); }
  });

  router.get('/:locationId/followups', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const { rows } = await pool.query(
        `SELECT f.id, f.kind, f.status, f.work_date::text AS work_date, f.answer_hours, f.took_break, p.name AS person_name
           FROM clock_followup f JOIN bonus_person p ON p.id = f.person_id
          WHERE f.location_id=$1 AND f.status IN ('pending','answered')
          ORDER BY (f.status='answered') DESC, f.work_date DESC`, [req.params.locationId]);
      res.json({ followups: rows });
    } catch (e) { fail(res, e); }
  });

  // Owner approves (applies to the entry's pay) or dismisses a tech's answer.
  router.put('/followup/:id/decide', ...authed, async (req, res) => {
    try {
      await ensure();
      const action = (req.body || {}).action;
      if (!['approve', 'dismiss'].includes(action)) return fail(res, 'action must be approve|dismiss', 400);
      const { rows: fr } = await pool.query('SELECT * FROM clock_followup WHERE id=$1', [req.params.id]);
      if (!fr.length) return fail(res, 'Not found', 404);
      const f = fr[0];
      if (!canAccessLocation(req.user, f.location_id)) return fail(res, 'Access denied for this location', 403);
      if (action === 'approve' && f.status === 'answered' && f.entry_id) {
        if (f.kind === 'overtime' && Number(f.answer_hours) > 0) {
          await pool.query("UPDATE time_clock_entry SET clock_out = clock_out + ($2::numeric || ' hours')::interval, corrected_by=$3, corrected_at=now() WHERE id=$1", [f.entry_id, Number(f.answer_hours), who(req)]);
        } else if (f.kind === 'break') {
          await pool.query('UPDATE time_clock_entry SET break_seconds = $2, corrected_by=$3, corrected_at=now() WHERE id=$1', [f.entry_id, Math.round(Number(f.answer_hours || 0) * 3600), who(req)]);
        }
      }
      await pool.query("UPDATE clock_followup SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1", [f.id, action === 'approve' ? 'approved' : 'dismissed', who(req)]);
      res.json({ ok: true, status: action === 'approve' ? 'approved' : 'dismissed' });
    } catch (e) { fail(res, e); }
  });

  return router;
};
