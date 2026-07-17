const express = require('express');
const { authenticateToken, requireRole, requireOwner } = require('../middleware/auth');
const { ensureBonusFuelTables } = require('../lib/bonusFuelSchema');
const { computeRun, round2 } = require('../lib/bonusCalc');
const { workingPaceFrac } = require('../lib/workdays');

// Bonus module (spec: lemonops-bonus-fuelcard-spec-FULL.md). Owner-only
// mutations; owner+partner reads. Everything location-scoped; managers have no
// access (payroll data). Guardrails from spec §6 enforced HERE, not just UI.

const SHOPMONKEY_KEY = () => process.env.SHOPMONKEY_API_KEY;
const TZ = 'America/Edmonton';

// ── month helpers (shop timezone) ──
const monthNow = () => new Date().toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', timeZone: TZ }).slice(0, 7);
const validMonth = (m) => /^\d{4}-\d{2}$/.test(m || '');
// UTC instant of local (Mountain) midnight starting the given YYYY-MM.
function monthStartUtc(month) {
  const [y, m] = month.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, 1));
  const local = new Date(guess.toLocaleString('en-US', { timeZone: TZ }));
  return new Date(guess.getTime() + (guess.getTime() - local.getTime()));
}
function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

// ── prior-month revenue straight from Shopmonkey (same definition as the
// dashboard metric: 5-component pre-tax subtotal, comebacks excluded, unit of
// truth = invoicedDate inside the shop-tz month). Sweep+union+complete-or-throw
// like lib does for MTD; window filtered locally (lt operator support varies).
const subtotalCents = (o) => (o.partsCents || 0) + (o.laborCents || 0) + (o.shopSuppliesCents || 0) + (o.subcontractsCents || 0) + (o.tiresCents || 0);
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function monthRevenue(smLocationId, month) {
  const key = SHOPMONKEY_KEY();
  if (!key) throw new Error('SHOPMONKEY_API_KEY not configured');
  const start = monthStartUtc(month), end = monthStartUtc(nextMonth(month));
  const where = JSON.stringify({ invoicedDate: { gte: start.toISOString() } });
  const sort = JSON.stringify([{ name: 'createdDate', order: 'asc' }]);
  const byId = new Map();
  let total = null;
  for (let sweep = 0; sweep < 5; sweep++) {
    for (let skip = 0; skip < 5000; skip += 100) {
      const p = new URLSearchParams({ where, limit: '100', skip: String(skip), sort });
      const res = await fetch(`https://api.shopmonkey.cloud/v3/order?${p}`, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
      if (!res.ok) throw new Error(`Shopmonkey ${res.status}`);
      const b = await res.json();
      const meta = b.meta || (b.data && b.data.meta) || null;
      if (meta && typeof meta.total === 'number') total = meta.total;
      const batch = Array.isArray(b.data) ? b.data : (b.data && b.data.data) || [];
      for (const o of batch) if (o && o.id) byId.set(o.id, o);
      if (batch.length < 100) break;
      await _sleep(120);
    }
    if (total !== null && byId.size >= total) break;
    await _sleep(200);
  }
  if (total !== null && byId.size < total) throw new Error(`Shopmonkey incomplete (${byId.size}/${total}) — try again or enter revenue manually`);
  let cents = 0;
  for (const o of byId.values()) {
    if (o.deleted || !o.invoicedDate || o.invoicedDate === 'empty') continue;
    if (o.locationId !== smLocationId) continue;
    const inv = new Date(o.invoicedDate);
    if (isNaN(inv) || inv < start || inv >= end) continue;
    const sub = subtotalCents(o);
    if (sub === 0) continue;                       // comebacks excluded
    cents += sub;
  }
  return round2(cents / 100);
}

module.exports = (pool) => {
  const router = express.Router();
  const ensure = () => ensureBonusFuelTables(pool);
  const who = (req) => req.user.email || req.user.name || req.user.role;
  const read = [authenticateToken, requireRole('owner', 'partner')];
  const write = [authenticateToken, requireOwner];
  const fail = (res, e, code = 500) => res.status(code).json({ error: String(e.message || e) });

  const formulaFor = async (locationId, month) => {
    const { rows } = await pool.query(
      `SELECT * FROM formula_version WHERE location_id=$1 AND effective_from_month <= $2
        ORDER BY effective_from_month DESC, version_no DESC LIMIT 1`, [locationId, month]);
    return rows[0] || null;
  };
  const activePeople = async (locationId) => (await pool.query(
    'SELECT id, name, role, efficiency_floor FROM bonus_person WHERE location_id=$1 AND active=true ORDER BY role, name', [locationId])).rows;
  const effInputs = async (locationId, month) => {
    const { rows } = await pool.query('SELECT person_id, billed_hours, clocked_hours FROM efficiency_input WHERE location_id=$1 AND month=$2', [locationId, month]);
    const map = {};
    for (const r of rows) map[r.person_id] = { billed_hours: Number(r.billed_hours), clocked_hours: Number(r.clocked_hours) };
    return map;
  };

  // Guardrail §6.4 — net-profit sanity, the #1 foreseeable bug.
  const netSanity = (net, revenue, confirmed) => {
    if (!(net > 0)) return 'net_profit must be a positive number';
    if (!confirmed && (net > revenue || net > 0.6 * revenue)) {
      return `Net profit $${net.toLocaleString('en-CA')} is ${net > revenue ? 'MORE than revenue' : 'over 60% of revenue'} — this looks like gross profit, not net. The program pays on net. Confirm to proceed.`;
    }
    return null;
  };

  // Shared: compute + insert a draft run (used by calculate and supersede).
  async function createDraftRun(req, res, locationId, month, body, supersedes) {
    const { net_profit, revenue: manualRevenue, revenue_reason, confirm_net, missing_as_full } = body || {};
    if (!validMonth(month)) return fail(res, 'month must be YYYY-MM', 400);
    if (month >= monthNow()) return fail(res, 'Only completed months can be calculated', 400);

    const { rows: appr } = await pool.query(
      "SELECT id FROM bonus_run WHERE location_id=$1 AND month=$2 AND status='approved' AND superseded_by IS NULL", [locationId, month]);
    if (appr.length && !supersedes) return fail(res, 'This month is approved and locked — use Supersede to re-run it', 409);

    const formula = await formulaFor(locationId, month);
    if (!formula) return fail(res, 'No formula version effective for this month', 400);
    const { rows: tr } = await pool.query('SELECT target FROM sales_target WHERE location_id=$1 AND month=$2', [locationId, month]);
    if (!tr.length) return fail(res, `No sales target set for ${month} — set it first`, 400);
    const target = Number(tr[0].target);

    // Revenue: auto from Shopmonkey unless a manual figure (with reason) is given.
    let revenue, revenueSource = 'auto', revenueReason = null;
    if (manualRevenue != null) {
      if (!revenue_reason || !String(revenue_reason).trim()) return fail(res, 'Manual revenue requires a reason (override)', 400);
      revenue = round2(Number(manualRevenue)); revenueSource = 'manual'; revenueReason = String(revenue_reason).slice(0, 400);
    } else {
      const { rows: locRows } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id=$1', [locationId]);
      const smId = locRows[0] && locRows[0].shopmonkey_location_id;
      if (!smId) return fail(res, 'Location not connected to Shopmonkey — enter revenue manually with a reason', 400);
      try { revenue = await monthRevenue(smId, month); }
      catch (e) { return fail(res, `Auto revenue pull failed: ${e.message}`, 502); }
    }

    const net = Number(net_profit);
    const sanity = netSanity(net, revenue, !!confirm_net);
    if (sanity) return res.status(400).json({ error: sanity, needs_confirm: !(net > 0) ? undefined : true });

    const people = await activePeople(locationId);
    if (!people.length) return fail(res, 'No active people configured', 400);
    const efficiency = await effInputs(locationId, month);
    const result = computeRun({ revenue, target, netProfit: net, formula, people, efficiency, missingAsFull: !!missing_as_full });
    if (result.missing.length && !missing_as_full) {
      return res.status(400).json({ error: 'Missing efficiency inputs', missing: result.missing.map((m) => m.name) });
    }

    // Recalculate discards any existing draft for the month (spec §3.1).
    await pool.query("DELETE FROM bonus_run WHERE location_id=$1 AND month=$2 AND status='draft'", [locationId, month]);

    const { rows: runRows } = await pool.query(
      `INSERT INTO bonus_run (location_id, month, formula_version_id, revenue, revenue_source, revenue_override_reason, target, net_profit, rate, tier, status, supersedes, calculated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11,$12) RETURNING *`,
      [locationId, month, formula.id, revenue, revenueSource, revenueReason, target, round2(net), result.rate, result.tier, supersedes || null, who(req)]);
    const run = runRows[0];
    for (const l of result.lines) {
      await pool.query(
        `INSERT INTO bonus_line (bonus_run_id, person_id, person_name, role_at_calc, efficiency, floor_used, multiplier, calculated, paid)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [run.id, l.person_id, l.name, l.role_at_calc, l.efficiency, l.floor_used, l.multiplier, l.calculated]);
    }
    const { rows: lines } = await pool.query('SELECT * FROM bonus_line WHERE bonus_run_id=$1 ORDER BY role_at_calc, person_name', [run.id]);
    res.json({ run, lines, stretch_needed: result.stretch_needed, formula });
  }

  // ── Overview: everything the tab needs in one call ──
  router.get('/:locationId/overview', ...read, async (req, res) => {
    try {
      await ensure();
      const locationId = req.params.locationId;
      const month = validMonth(req.query.month) ? req.query.month : null;
      const { rows: history } = await pool.query(
        'SELECT id, month, status, superseded_by, approved_at FROM bonus_run WHERE location_id=$1 ORDER BY month DESC, calculated_at DESC', [locationId]);
      // default view month: requested, else latest run month, else last calendar month
      const lastCal = (() => { const [y, m] = monthNow().split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
      const viewMonth = month || (history[0] && history[0].month) || lastCal;
      const { rows: runRows } = await pool.query(
        `SELECT * FROM bonus_run WHERE location_id=$1 AND month=$2 AND superseded_by IS NULL
          ORDER BY (status='approved') DESC, calculated_at DESC LIMIT 1`, [locationId, viewMonth]);
      const run = runRows[0] || null;
      const lines = run ? (await pool.query('SELECT * FROM bonus_line WHERE bonus_run_id=$1 ORDER BY role_at_calc, person_name', [run.id])).rows : [];
      const formula = await formulaFor(locationId, viewMonth);
      const { rows: versions } = await pool.query('SELECT * FROM formula_version WHERE location_id=$1 ORDER BY version_no', [locationId]);
      const people = (await pool.query('SELECT * FROM bonus_person WHERE location_id=$1 ORDER BY active DESC, role, name', [locationId])).rows;
      const efficiency = await effInputs(locationId, viewMonth);
      const { rows: targets } = await pool.query('SELECT month, target FROM sales_target WHERE location_id=$1 ORDER BY month', [locationId]);

      // Pace strip (current month, non-binding): MTD revenue vs target, straight-line.
      const cur = monthNow();
      const { rows: mrows } = await pool.query('SELECT revenue_mtd FROM metrics_cache WHERE location_id=$1 ORDER BY created_at DESC LIMIT 1', [locationId]);
      const { rows: ctr } = await pool.query('SELECT target FROM sales_target WHERE location_id=$1 AND month=$2', [locationId, cur]);
      const { rows: locRows } = await pool.query('SELECT province FROM locations WHERE id=$1', [locationId]);
      const curFormula = await formulaFor(locationId, cur);
      let pace = null;
      if (mrows.length && ctr.length) {
        const mtd = Number(mrows[0].revenue_mtd) || 0;
        const tgt = Number(ctr[0].target);
        const frac = workingPaceFrac((locRows[0] && locRows[0].province) || 'ab', new Date());
        pace = {
          month: cur, mtd: round2(mtd), target: tgt,
          projection: frac > 0 ? round2(mtd / frac) : null,
          stretch_needed: curFormula ? round2(tgt * Number(curFormula.stretch_threshold)) : null,
        };
      }
      const stretchNeeded = run ? round2(Number(run.target) * Number((versions.find(v => v.id === run.formula_version_id) || formula || { stretch_threshold: 1.1 }).stretch_threshold)) : (formula && targets.find(t => t.month === viewMonth) ? round2(Number(targets.find(t => t.month === viewMonth).target) * Number(formula.stretch_threshold)) : null);
      res.json({ month: viewMonth, run, lines, stretch_needed: stretchNeeded, formula, versions, people, efficiency, targets, pace, history, current_month: cur });
    } catch (e) { fail(res, e); }
  });

  // ── People ──
  router.post('/:locationId/people', ...write, async (req, res) => {
    try {
      await ensure();
      const { name, role } = req.body || {};
      if (!name || !['tech', 'advisor'].includes(role)) return fail(res, 'name and role (tech|advisor) required', 400);
      const { rows } = await pool.query('INSERT INTO bonus_person (location_id, name, role) VALUES ($1,$2,$3) RETURNING *', [req.params.locationId, String(name).slice(0, 120), role]);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });
  router.put('/people/:personId', ...write, async (req, res) => {
    try {
      await ensure();
      const { name, active, efficiency_floor, role } = req.body || {};
      if (role && !['tech', 'advisor'].includes(role)) return fail(res, 'Invalid role', 400);
      if (efficiency_floor != null && !(efficiency_floor > 0 && efficiency_floor <= 1.5)) return fail(res, 'efficiency_floor must be a fraction like 0.9', 400);
      const { rows } = await pool.query(
        `UPDATE bonus_person SET name=COALESCE($2,name), role=COALESCE($3,role), active=COALESCE($4,active),
                efficiency_floor=$5 WHERE id=$1 RETURNING *`,
        [req.params.personId, name || null, role || null, typeof active === 'boolean' ? active : null,
         efficiency_floor === undefined ? null : efficiency_floor]);   // explicit null clears to default
      if (!rows.length) return fail(res, 'Person not found', 404);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });

  // ── Targets ──
  router.put('/:locationId/target/:month', ...write, async (req, res) => {
    try {
      await ensure();
      const { month } = req.params;
      const target = Number((req.body || {}).target);
      if (!validMonth(month) || !(target > 0)) return fail(res, 'month YYYY-MM and positive target required', 400);
      const { rows: appr } = await pool.query("SELECT id FROM bonus_run WHERE location_id=$1 AND month=$2 AND status='approved' AND superseded_by IS NULL", [req.params.locationId, month]);
      if (appr.length) return fail(res, 'This month has an approved run — supersede it to change inputs', 409);
      await pool.query(
        `INSERT INTO sales_target (location_id, month, target) VALUES ($1,$2,$3)
         ON CONFLICT (location_id, month) DO UPDATE SET target=EXCLUDED.target`,
        [req.params.locationId, month, round2(target)]);
      res.json({ ok: true, month, target: round2(target) });
    } catch (e) { fail(res, e); }
  });

  // ── Efficiency inputs (manual entry; POS import later) ──
  router.put('/:locationId/efficiency/:month', ...write, async (req, res) => {
    try {
      await ensure();
      const { month } = req.params;
      const entries = (req.body || {}).entries;
      if (!validMonth(month) || !Array.isArray(entries)) return fail(res, 'month + entries[] required', 400);
      for (const e of entries) {
        const billed = Number(e.billed_hours), clocked = Number(e.clocked_hours);
        if (!(clocked > 0)) return fail(res, `Clocked hours must be > 0 (${e.person_id})`, 400);   // §6.5
        if (billed / clocked > 1.5) return fail(res, `Efficiency over 150% — check the hours (${e.person_id})`, 400);
        await pool.query(
          `INSERT INTO efficiency_input (location_id, person_id, month, billed_hours, clocked_hours)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (location_id, person_id, month) DO UPDATE SET billed_hours=EXCLUDED.billed_hours, clocked_hours=EXCLUDED.clocked_hours`,
          [req.params.locationId, e.person_id, month, round2(billed), round2(clocked)]);
      }
      res.json({ ok: true, saved: entries.length });
    } catch (e) { fail(res, e); }
  });

  // ── Formula settings: append-only versions (§3.3, guardrail §6.3) ──
  router.post('/:locationId/formula', ...write, async (req, res) => {
    try {
      await ensure();
      const b = req.body || {};
      const eff = String(b.effective_from_month || '');
      if (!validMonth(eff)) return fail(res, 'effective_from_month YYYY-MM required', 400);
      const { rows: mr } = await pool.query('SELECT MAX(month) AS m FROM bonus_run WHERE location_id=$1', [req.params.locationId]);
      if (mr[0].m && eff <= mr[0].m) return fail(res, `Effective month must be after ${mr[0].m} (a change can never affect a calculated month)`, 400);
      for (const [k, lo, hi] of [['base_rate', 0, 0.1], ['stretch_rate', 0, 0.1], ['stretch_threshold', 1, 3], ['group_floor', 0.1, 1.5], ['multiplier_hard_min', 0, 1]]) {
        const v = Number(b[k]);
        if (!(v > lo && v <= hi)) return fail(res, `${k} out of range`, 400);
      }
      const { rows: vr } = await pool.query('SELECT COALESCE(MAX(version_no),0)+1 AS v FROM formula_version WHERE location_id=$1', [req.params.locationId]);
      const { rows } = await pool.query(
        `INSERT INTO formula_version (location_id, version_no, base_rate, stretch_rate, stretch_threshold, efficiency_enabled, group_floor, multiplier_hard_min, effective_from_month, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.params.locationId, vr[0].v, b.base_rate, b.stretch_rate, b.stretch_threshold, b.efficiency_enabled !== false, b.group_floor, b.multiplier_hard_min, eff, who(req)]);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });

  // ── Lifecycle ──
  router.post('/:locationId/calculate', ...write, async (req, res) => {
    try { await ensure(); await createDraftRun(req, res, req.params.locationId, (req.body || {}).month, req.body, null); }
    catch (e) { fail(res, e); }
  });

  // Per-line paid override (draft only; §6.1).
  router.put('/run/:runId/line/:lineId', ...write, async (req, res) => {
    try {
      await ensure();
      const { rows: rr } = await pool.query('SELECT status FROM bonus_run WHERE id=$1', [req.params.runId]);
      if (!rr.length) return fail(res, 'Run not found', 404);
      if (rr[0].status !== 'draft') return fail(res, 'Approved runs are locked — supersede to change anything', 409);   // §6.2
      const { rows: lr } = await pool.query('SELECT calculated FROM bonus_line WHERE id=$1 AND bonus_run_id=$2', [req.params.lineId, req.params.runId]);
      if (!lr.length) return fail(res, 'Line not found', 404);
      const paid = round2(Number((req.body || {}).paid));
      const reason = String((req.body || {}).override_reason || '').trim();
      if (!(paid >= 0)) return fail(res, 'paid must be >= 0', 400);
      const calc = Number(lr[0].calculated);
      if (paid !== calc && !reason) return fail(res, 'Paid differs from calculated — an override reason is required', 400);
      const { rows } = await pool.query(
        `UPDATE bonus_line SET paid=$3, override_reason=$4, override_by=$5, override_at=$6 WHERE id=$1 AND bonus_run_id=$2 RETURNING *`,
        [req.params.lineId, req.params.runId, paid,
         paid === calc ? null : reason, paid === calc ? null : who(req), paid === calc ? null : new Date()]);
      res.json(rows[0]);
    } catch (e) { fail(res, e); }
  });

  // Approve & lock: freeze + post fuel credits (§3.1, §6.6).
  router.post('/run/:runId/approve', ...write, async (req, res) => {
    try {
      await ensure();
      const { rows: rr } = await pool.query('SELECT * FROM bonus_run WHERE id=$1', [req.params.runId]);
      if (!rr.length) return fail(res, 'Run not found', 404);
      const run = rr[0];
      if (run.status !== 'draft') return fail(res, 'Run is already approved', 409);
      const { rows: other } = await pool.query(
        "SELECT id FROM bonus_run WHERE location_id=$1 AND month=$2 AND status='approved' AND superseded_by IS NULL AND id<>$3", [run.location_id, run.month, run.id]);
      if (other.length && !run.supersedes) return fail(res, 'Another approved run exists for this month', 409);
      const { rows: lines } = await pool.query('SELECT * FROM bonus_line WHERE bonus_run_id=$1', [run.id]);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("UPDATE bonus_run SET status='approved', approved_by=$2, approved_at=NOW() WHERE id=$1", [run.id, who(req)]);
        const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
        if (run.supersedes) {
          // Ledger net effect must equal the NEW run (spec §3.1): post per-person deltas.
          const { rows: oldLines } = await client.query('SELECT person_id, paid FROM bonus_line WHERE bonus_run_id=$1', [run.supersedes]);
          const oldPaid = Object.fromEntries(oldLines.map((l) => [l.person_id, Number(l.paid)]));
          for (const l of lines) {
            const delta = round2(Number(l.paid) - (oldPaid[l.person_id] || 0));
            if (delta !== 0) {
              await client.query(
                `INSERT INTO fuel_ledger (location_id, person_id, type, amount, occurred_on, source, bonus_run_id, memo, created_by)
                 VALUES ($1,$2,'bonus_credit',$3,$4,'bonus_run',$5,$6,$7)`,
                [run.location_id, l.person_id, delta, today, run.id, `${run.month} bonus (supersede correction)`, who(req)]);
            }
          }
          await client.query('UPDATE bonus_run SET superseded_by=$2 WHERE id=$1', [run.supersedes, run.id]);
        } else {
          for (const l of lines) {
            if (Number(l.paid) > 0) {
              await client.query(
                `INSERT INTO fuel_ledger (location_id, person_id, type, amount, occurred_on, source, bonus_run_id, memo, created_by)
                 VALUES ($1,$2,'bonus_credit',$3,$4,'bonus_run',$5,$6,$7)`,
                [run.location_id, l.person_id, Number(l.paid), today, run.id, `${run.month} profit-share bonus`, who(req)]);
            }
          }
        }
        await client.query('COMMIT');
      } catch (err) { await client.query('ROLLBACK'); throw err; }
      finally { client.release(); }
      res.json({ ok: true, id: run.id, credited: lines.filter((l) => Number(l.paid) > 0).length });
    } catch (e) { fail(res, e); }
  });

  // Supersede an approved run: new draft pointing back at it (§3.1).
  router.post('/run/:runId/supersede', ...write, async (req, res) => {
    try {
      await ensure();
      const { rows: rr } = await pool.query('SELECT * FROM bonus_run WHERE id=$1', [req.params.runId]);
      if (!rr.length) return fail(res, 'Run not found', 404);
      const old = rr[0];
      if (old.status !== 'approved') return fail(res, 'Only approved runs can be superseded (drafts: just recalculate)', 400);
      if (old.superseded_by) return fail(res, 'Run is already superseded', 409);
      await createDraftRun(req, res, old.location_id, old.month, req.body, old.id);
    } catch (e) { fail(res, e); }
  });

  // ── Export (CSV/XLSX): the payroll/CRA record (§5) ──
  router.get('/run/:runId/export', ...read, async (req, res) => {
    try {
      await ensure();
      const { rows: rr } = await pool.query('SELECT * FROM bonus_run WHERE id=$1', [req.params.runId]);
      if (!rr.length) return fail(res, 'Run not found', 404);
      const run = rr[0];
      const { rows: fv } = await pool.query('SELECT * FROM formula_version WHERE id=$1', [run.formula_version_id]);
      const { rows: lines } = await pool.query('SELECT * FROM bonus_line WHERE bonus_run_id=$1 ORDER BY role_at_calc, person_name', [run.id]);
      const { rows: locRows } = await pool.query('SELECT name FROM locations WHERE id=$1', [run.location_id]);
      const locSlug = String((locRows[0] || {}).name || 'location').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const f = fv[0] || {};
      const head = {
        month: run.month, status: run.status + (run.superseded_by ? ' (superseded)' : ''),
        formula_version: f.version_no, base_rate: f.base_rate, stretch_rate: f.stretch_rate,
        stretch_threshold: f.stretch_threshold, efficiency_enabled: f.efficiency_enabled,
        group_floor: f.group_floor, multiplier_hard_min: f.multiplier_hard_min,
        revenue: run.revenue, revenue_source: run.revenue_source, target: run.target,
        net_profit: run.net_profit, rate: run.rate, tier: run.tier,
        calculated_by: run.calculated_by, calculated_at: run.calculated_at,
        approved_by: run.approved_by, approved_at: run.approved_at,
      };
      const rows = lines.map((l) => ({
        person: l.person_name, role: l.role_at_calc,
        efficiency: l.efficiency == null ? '' : round2(Number(l.efficiency) * 100) + '%',
        floor: l.floor_used == null ? '' : round2(Number(l.floor_used) * 100) + '%',
        multiplier: l.multiplier == null ? '' : round2(Number(l.multiplier)),
        calculated: Number(l.calculated), paid: Number(l.paid),
        override_reason: l.override_reason || '', override_by: l.override_by || '', override_at: l.override_at || '',
      }));
      const totals = { person: 'TOTAL', calculated: round2(rows.reduce((s, r) => s + r.calculated, 0)), paid: round2(rows.reduce((s, r) => s + r.paid, 0)) };
      const fname = `${locSlug}-bonus-${run.month}`;
      if ((req.query.format || 'csv') === 'xlsx') {
        const XLSX = require('xlsx');
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([head]), 'Run');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([...rows, totals]), 'Distribution');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.set('Content-Disposition', `attachment; filename="${fname}.xlsx"`);
        return res.send(buf);
      }
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [
        Object.keys(head).join(','), Object.values(head).map(esc).join(','), '',
        Object.keys(rows[0] || totals).join(','),
        ...[...rows, totals].map((r) => Object.values(r).map(esc).join(',')),
      ].join('\n');
      res.set('Content-Type', 'text/csv');
      res.set('Content-Disposition', `attachment; filename="${fname}.csv"`);
      res.send(csv);
    } catch (e) { fail(res, e); }
  });

  return router;
};
