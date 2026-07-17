const express = require('express');
const crypto = require('crypto');
const { authenticateToken, requireRole, canAccessLocation } = require('../middleware/auth');
const { ensureTimeClockTables, paidHoursByMonth } = require('../lib/timeClockSchema');

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
        return res.json({ status: 'on', name: person.name });
      }
      // out — auto-close an open break first
      await pool.query(
        `UPDATE time_clock_entry
            SET break_seconds = break_seconds + COALESCE(EXTRACT(EPOCH FROM (now() - break_started_at)), 0),
                break_started_at = NULL, clock_out = now()
          WHERE id=$1`, [open.id]);
      return res.json({ status: 'off', name: person.name });
    } catch (e) { fail(res, e); }
  });

  // ══ CORRECTIONS + PINs (owner + that location's manager) ══════════════
  const authed = [authenticateToken, requireRole('owner', 'partner', 'manager')];
  const scoped = (req, res, next) => canAccessLocation(req.user, req.params.locationId) ? next() : res.status(403).json({ error: 'Access denied for this location' });
  const paidExpr = "ROUND((EXTRACT(EPOCH FROM (clock_out - clock_in)) - break_seconds)/3600.0, 2)";

  // Month of entries for review + correction, with computed paid hours.
  router.get('/:locationId/entries', ...authed, scoped, async (req, res) => {
    try {
      await ensure();
      const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
      if (!month) return fail(res, 'month=YYYY-MM required', 400);
      const { rows } = await pool.query(
        `SELECT e.*, p.name AS person_name,
                CASE WHEN e.clock_out IS NULL THEN NULL ELSE ${paidExpr} END AS paid_hours
           FROM time_clock_entry e JOIN bonus_person p ON p.id = e.person_id
          WHERE e.location_id=$1 AND to_char(e.clock_in AT TIME ZONE 'America/Edmonton','YYYY-MM')=$2
          ORDER BY e.clock_in DESC`, [req.params.locationId, month]);
      const summary = await paidHoursByMonth(pool, req.params.locationId, month);
      res.json({ month, entries: rows, summary });
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
