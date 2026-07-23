const express = require('express');
const { authenticateToken, requireRole, requireOwner, canAccessLocation } = require('../middleware/auth');
const { ensureBonusFuelTables } = require('../lib/bonusFuelSchema');
const { round2 } = require('../lib/bonusCalc');

// Fuel Card module (spec §4). One physical group card per location; the ledger
// tracks each person's share. Credits positive, purchases negative. Everything
// derived (credited/used/remaining/variance) is computed here, never stored.
// Extras are LEDGER ROWS (top-ups), never edits to computed values.

module.exports = (pool) => {
  const router = express.Router();
  const ensure = () => ensureBonusFuelTables(pool);
  const who = (req) => req.user.email || req.user.name || req.user.role;
  // Managers get their own location's card: viewing + day-to-day ledger logging
  // (purchases, top-ups, assigning). Reconcile and settings stay owner-only.
  const read = [authenticateToken, requireRole('owner', 'partner', 'manager')];
  const write = [authenticateToken, requireOwner];
  const scoped = (req, res, next) => canAccessLocation(req.user, req.params.locationId)
    ? next() : res.status(403).json({ error: 'Access denied for this location' });
  const fail = (res, e, code = 500) => res.status(code).json({ error: String(e.message || e) });

  // ── Summary: tiles + per-person + activity in one call ──
  router.get('/:locationId/summary', ...read, scoped, async (req, res) => {
    try {
      await ensure();
      const locationId = req.params.locationId;
      const { rows: people } = await pool.query('SELECT id, name, role, active FROM bonus_person WHERE location_id=$1 ORDER BY role, name', [locationId]);
      const { rows: ledger } = await pool.query(
        `SELECT l.*, p.name AS person_name FROM fuel_ledger l LEFT JOIN bonus_person p ON p.id = l.person_id
          WHERE l.location_id=$1 ORDER BY (l.person_id IS NULL AND l.type='purchase') DESC, l.occurred_on DESC, l.created_at DESC LIMIT 200`, [locationId]);
      const { rows: snaps } = await pool.query('SELECT * FROM card_snapshot WHERE location_id=$1 ORDER BY statement_date DESC, created_at DESC LIMIT 1', [locationId]);
      const { rows: settings } = await pool.query('SELECT * FROM fuel_settings WHERE location_id=$1', [locationId]);

      // Per-person credited/used and the whole-card sums are computed in SQL, NOT
      // from the 200-row activity feed above. Two bugs lived here: occurred_on is a
      // DATE (pg returns a JS Date, so String(d).slice(0,4) was "Sun " and the year
      // filter never matched → every tile read $0), and the LIMIT 200 feed dropped
      // older ledger rows so balances/variance drifted once a location passed 200
      // entries. SUM(...) over the full table fixes both.
      const year = new Date().getFullYear();
      const per = {};
      for (const p of people) per[p.id] = { person_id: p.id, name: p.name, role: p.role, active: p.active, credited: 0, used: 0 };
      const { rows: agg } = await pool.query(
        // Classify by TYPE, not sign: 'used' is only fuel purchased; everything
        // else (bonus_credit, topup, adjustment) nets into 'credited' so a negative
        // supersede clawback correctly REDUCES credit instead of reading as fuel used.
        `SELECT person_id,
                COALESCE(SUM(amount) FILTER (WHERE type <> 'purchase'), 0)::numeric AS credited,
                COALESCE(SUM(-amount) FILTER (WHERE type = 'purchase'), 0)::numeric AS used
           FROM fuel_ledger
          WHERE location_id = $1 AND person_id IS NOT NULL
            AND EXTRACT(YEAR FROM occurred_on) = $2
          GROUP BY person_id`, [locationId, year]);
      for (const a of agg) if (per[a.person_id]) { per[a.person_id].credited = round2(Number(a.credited)); per[a.person_id].used = round2(Number(a.used)); }
      const { rows: sums } = await pool.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS ledger_sum,
                COALESCE(SUM(-amount) FILTER (WHERE person_id IS NULL AND amount < 0), 0)::numeric AS unassigned_used
           FROM fuel_ledger WHERE location_id = $1`, [locationId]);
      const ledgerSum = round2(Number(sums[0].ledger_sum));
      const unassignedUsed = round2(Number(sums[0].unassigned_used));
      const perList = Object.values(per).map((p) => ({ ...p, remaining: round2(p.credited - p.used) }));
      const creditedYtd = round2(perList.reduce((s, p) => s + p.credited, 0));
      const usedYtd = round2(perList.reduce((s, p) => s + p.used, 0));
      const remaining = round2(perList.reduce((s, p) => s + p.remaining, 0));
      const snap = snaps[0] || null;
      // Variance = actual balance − Σledger (spec: unassigned purchases hit the
      // card math but nobody's share — exactly what variance surfaces).
      const variance = snap ? round2(Number(snap.actual_balance) - ledgerSum) : null;
      const unassigned = ledger.filter((l) => !l.person_id && l.type === 'purchase');
      res.json({
        tiles: {
          card_balance: snap ? Number(snap.actual_balance) : null,
          statement_date: snap ? snap.statement_date : null,
          credited_ytd: creditedYtd, used_ytd: usedYtd, remaining_owed: remaining,
          ledger_sum: ledgerSum, variance,
          unassigned_count: unassigned.length,
          unassigned_total: round2(unassigned.reduce((s, l) => s + Math.abs(Number(l.amount)), 0)),
        },
        people: perList, ledger, settings: settings[0] || { sweep_enabled: false, sweep_days: 90 },
      });
    } catch (e) { fail(res, e); }
  });

  // ── Log a ledger row: purchase / top-up / adjustment ──
  router.post('/:locationId/ledger', ...read, scoped, async (req, res) => {
    try {
      await ensure();
      const { type, person_id, amount, occurred_on, memo } = req.body || {};
      if (!['purchase', 'topup', 'adjustment'].includes(type)) return fail(res, 'type must be purchase|topup|adjustment', 400);
      const amt = Number(amount);
      if (!(Math.abs(amt) > 0)) return fail(res, 'amount required', 400);
      // Normalize sign: purchases negative, top-ups positive, adjustments as given.
      const signed = type === 'purchase' ? -Math.abs(amt) : type === 'topup' ? Math.abs(amt) : round2(amt);
      const date = occurred_on || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
      const { rows } = await pool.query(
        `INSERT INTO fuel_ledger (location_id, person_id, type, amount, occurred_on, source, memo, created_by)
         VALUES ($1,$2,$3,$4,$5,'manual',$6,$7) RETURNING *`,
        [req.params.locationId, person_id || null, type, round2(signed), date, String(memo || '').slice(0, 300), who(req)]);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });

  // ── Assign an unassigned purchase to a person (logged update) ──
  router.put('/ledger/:id/assign', ...read, async (req, res) => {
    try {
      await ensure();
      const { person_id } = req.body || {};
      if (!person_id) return fail(res, 'person_id required', 400);
      const { rows: lr } = await pool.query('SELECT location_id FROM fuel_ledger WHERE id=$1', [req.params.id]);
      if (!lr.length) return fail(res, 'Ledger row not found', 404);
      if (!canAccessLocation(req.user, lr[0].location_id)) return fail(res, 'Access denied for this location', 403);
      const { rows } = await pool.query(
        `UPDATE fuel_ledger SET person_id=$2, memo = COALESCE(memo,'') || ' · assigned by ' || $3 WHERE id=$1 RETURNING *`,
        [req.params.id, person_id, who(req)]);
      if (!rows.length) return fail(res, 'Ledger row not found', 404);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });

  // ── Reconcile: snapshot the actual card balance ──
  router.post('/:locationId/reconcile', ...write, async (req, res) => {
    try {
      await ensure();
      const bal = Number((req.body || {}).actual_balance);
      if (!Number.isFinite(bal)) return fail(res, 'actual_balance required', 400);
      const date = (req.body || {}).statement_date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
      const { rows } = await pool.query(
        'INSERT INTO card_snapshot (location_id, statement_date, actual_balance, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
        [req.params.locationId, date, round2(bal), who(req)]);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });

  // ── Sweep policy setting (default OFF; no behavior yet — spec §4) ──
  router.put('/:locationId/settings', ...write, async (req, res) => {
    try {
      await ensure();
      const { sweep_enabled, sweep_days } = req.body || {};
      const { rows } = await pool.query(
        `INSERT INTO fuel_settings (location_id, sweep_enabled, sweep_days) VALUES ($1,$2,$3)
         ON CONFLICT (location_id) DO UPDATE SET sweep_enabled=EXCLUDED.sweep_enabled, sweep_days=EXCLUDED.sweep_days RETURNING *`,
        [req.params.locationId, !!sweep_enabled, Number(sweep_days) > 0 ? Math.round(Number(sweep_days)) : 90]);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });

  // ── Export: full ledger + per-person summary + latest snapshot (§5) ──
  router.get('/:locationId/export', ...read, scoped, async (req, res) => {
    try {
      await ensure();
      const locationId = req.params.locationId;
      const { rows: ledger } = await pool.query(
        `SELECT l.occurred_on, l.type, p.name AS person, l.amount, l.source, l.memo, l.created_by, l.created_at
           FROM fuel_ledger l LEFT JOIN bonus_person p ON p.id=l.person_id
          WHERE l.location_id=$1 ORDER BY l.occurred_on, l.created_at`, [locationId]);
      const { rows: people } = await pool.query('SELECT id, name FROM bonus_person WHERE location_id=$1', [locationId]);
      const nameOf = Object.fromEntries(people.map((p) => [p.id, p.name]));
      const { rows: sums } = await pool.query(
        `SELECT person_id, SUM(CASE WHEN type <> 'purchase' THEN amount ELSE 0 END) AS credited,
                SUM(CASE WHEN type = 'purchase' THEN -amount ELSE 0 END) AS used, SUM(amount) AS remaining
           FROM fuel_ledger WHERE location_id=$1 GROUP BY person_id`, [locationId]);
      const summary = sums.map((s) => ({ person: s.person_id ? (nameOf[s.person_id] || s.person_id) : 'UNASSIGNED', credited: Number(s.credited), used: Number(s.used), remaining: Number(s.remaining) }));
      const { rows: snaps } = await pool.query('SELECT statement_date, actual_balance, created_by FROM card_snapshot WHERE location_id=$1 ORDER BY statement_date DESC LIMIT 1', [locationId]);
      const { rows: locRows } = await pool.query('SELECT name FROM locations WHERE id=$1', [locationId]);
      const locSlug = String((locRows[0] || {}).name || 'location').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const month = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }).slice(0, 7);
      const fname = `${locSlug}-fuel-${month}`;
      if ((req.query.format || 'csv') === 'xlsx') {
        const XLSX = require('xlsx');
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ledger), 'Ledger');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Per person');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(snaps), 'Reconciliation');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.set('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
        return res.send(buf);
      }
      // Neutralize spreadsheet formula injection: a manager-entered memo like
      // "=cmd|..." must not execute when the owner opens the CSV in Excel.
      const esc = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
      const section = (title, rows) => rows.length ? [title, Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(esc).join(','))] : [title, '(none)'];
      const csv = [...section('LEDGER', ledger), '', ...section('PER PERSON', summary), '', ...section('LATEST RECONCILIATION', snaps)].join('\n');
      res.set('Content-Type', 'text/csv');
      res.set('Content-Disposition', `attachment; filename="${fname}.csv"`);
      res.send(csv);
    } catch (e) { fail(res, e); }
  });

  return router;
};
