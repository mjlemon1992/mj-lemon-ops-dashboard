const express = require('express');
const { authenticateToken, requireRole, canAccessLocation } = require('../middleware/auth');
const { actualRevenueByMonth } = require('../lib/shopmonkey');

module.exports = (pool) => {
  const router = express.Router();

  // Owner/partner set targets anywhere; a manager only for their own location.
  const assertLoc = (req, res) => {
    if (canAccessLocation(req.user, req.params.locationId)) return true;
    res.status(403).json({ error: 'Access denied for this location' });
    return false;
  };

  router.get('/:locationId/:year', authenticateToken, async (req, res) => {
    try {
      if (['manager', 'advisor'].includes(req.user.role) && req.user.location_id !== req.params.locationId) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const result = await pool.query(
        'SELECT * FROM targets WHERE location_id = $1 AND year = $2 ORDER BY month',
        [req.params.locationId, req.params.year]
      );
      // Advisors get the shop-floor targets only (revenue pace, car count,
      // hours, efficiency) — margin/ARO/pph targets are stripped server-side.
      if (req.user.role === 'advisor') {
        return res.json(result.rows.map((r) => ({
          location_id: r.location_id, year: r.year, month: r.month,
          revenue: r.revenue, car_count: r.car_count,
          labour_hours: r.labour_hours, efficiency: r.efficiency,
        })));
      }
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/:locationId/:year/:month', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    const { revenue, car_count, parts_margin, labour_margin, labour_hours, efficiency, avg_ro_value, pph } = req.body;
    if (!assertLoc(req, res)) return;
    try {
      const result = await pool.query(
        `INSERT INTO targets (location_id, year, month, revenue, car_count, parts_margin, labour_margin, labour_hours, efficiency, avg_ro_value, pph)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (location_id, year, month) DO UPDATE SET
           revenue=$4, car_count=$5, parts_margin=$6, labour_margin=$7, labour_hours=$8, efficiency=$9, avg_ro_value=$10, pph=$11, updated_at=NOW()
         RETURNING *`,
        [req.params.locationId, req.params.year, req.params.month, revenue, car_count, parts_margin || 55, labour_margin || 70, labour_hours, efficiency || 80, avg_ro_value, pph]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:locationId/:year/bulk', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    const { targets } = req.body;
    if (!Array.isArray(targets)) return res.status(400).json({ error: 'targets must be an array' });
    if (!assertLoc(req, res)) return;
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const t of targets) {
          await client.query(
            `INSERT INTO targets (location_id, year, month, revenue, car_count, parts_margin, labour_margin, labour_hours, efficiency, avg_ro_value, pph)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (location_id, year, month) DO UPDATE SET
               revenue=$4, car_count=$5, parts_margin=$6, labour_margin=$7, labour_hours=$8, efficiency=$9, avg_ro_value=$10, pph=$11, updated_at=NOW()`,
            [req.params.locationId, req.params.year, t.month, t.revenue, t.car_count, t.parts_margin || 55, t.labour_margin || 70, t.labour_hours, t.efficiency || 80, t.avg_ro_value, t.pph]
          );
        }
        await client.query('COMMIT');
        res.json({ message: 'Targets saved', count: targets.length });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // RECALCULATE-TO-YEARLY. When completed months come in under target, the
  // remaining months must make up the shortfall for the year to still land on
  // its original annual revenue target. Read-only preview: pulls actual revenue
  // for completed months (one ShopMonkey sweep, same sales definition as MTD),
  // spreads the shortfall EVENLY across the remaining months, and returns the
  // proposed per-month bumps. The client applies via the bulk save.
  router.post('/:locationId/:year/recalculate', authenticateToken, requireRole('owner', 'partner', 'manager'), async (req, res) => {
    if (!assertLoc(req, res)) return;
    const year = Number(req.params.year);
    try {
      const nowParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', year: 'numeric', month: 'numeric' }).formatToParts(new Date());
      const curYear = Number(nowParts.find((p) => p.type === 'year').value);
      const curMonth = Number(nowParts.find((p) => p.type === 'month').value);

      const { rows } = await pool.query('SELECT month, revenue FROM targets WHERE location_id=$1 AND year=$2', [req.params.locationId, year]);
      const targetRev = {};
      for (const r of rows) targetRev[Number(r.month)] = Number(r.revenue) || 0;
      const yearlyTarget = Object.values(targetRev).reduce((a, b) => a + b, 0);
      if (yearlyTarget <= 0) return res.json({ status: 'no_targets', message: 'Set your monthly revenue targets first, then recalculate.' });

      let completedMonths = [];
      let remainingMonths = [];
      if (year < curYear) { completedMonths = Array.from({ length: 12 }, (_, i) => i + 1); }
      else if (year === curYear) {
        for (let m = 1; m < curMonth; m++) completedMonths.push(m);
        for (let m = curMonth; m <= 12; m++) remainingMonths.push(m);
      }
      if (!remainingMonths.length) return res.json({ status: 'no_remaining', message: year < curYear ? `${year} is already complete — no remaining months to redistribute into.` : `Nothing to redistribute yet for ${year}.`, yearly_target: Math.round(yearlyTarget) });
      if (!completedMonths.length) return res.json({ status: 'no_completed', message: `No completed months yet in ${year} — nothing to catch up on.`, yearly_target: Math.round(yearlyTarget) });

      const { rows: lr } = await pool.query('SELECT shopmonkey_location_id FROM locations WHERE id=$1', [req.params.locationId]);
      const smLoc = lr[0] && lr[0].shopmonkey_location_id;
      if (!smLoc) return res.status(400).json({ error: 'This location is not connected to Shopmonkey, so there are no actuals to compare against.' });
      const apiKey = process.env.SHOPMONKEY_API_KEY;
      if (!apiKey) return res.status(400).json({ error: 'SHOPMONKEY_API_KEY not configured' });

      const lastCompleted = completedMonths[completedMonths.length - 1];
      const endYm = lastCompleted === 12 ? `${year + 1}-01` : `${year}-${String(lastCompleted + 1).padStart(2, '0')}`;
      const actuals = await actualRevenueByMonth(apiKey, smLoc, `${year}-01`, endYm);
      const actualFor = (m) => actuals[`${year}-${String(m).padStart(2, '0')}`] || 0;

      const completed = completedMonths.map((m) => ({
        month: m, target: Math.round(targetRev[m] || 0), actual: Math.round(actualFor(m)),
        delta: Math.round(actualFor(m) - (targetRev[m] || 0)),
      }));
      const shortfall = Math.round(completed.reduce((a, c) => a + (c.target - c.actual), 0));  // + = behind

      if (shortfall <= 0) {
        return res.json({
          status: 'ahead', yearly_target: Math.round(yearlyTarget), shortfall,
          completed, remaining_count: remainingMonths.length,
          message: shortfall === 0 ? 'Completed months are exactly on target — no catch-up needed.' : `Ahead of pace by $${Math.abs(shortfall).toLocaleString('en-CA')} — targets left as-is.`,
        });
      }
      const perMonthBump = shortfall / remainingMonths.length;
      const proposed = remainingMonths.map((m) => ({
        month: m, old_revenue: Math.round(targetRev[m] || 0),
        new_revenue: Math.max(0, Math.round((targetRev[m] || 0) + perMonthBump)),
      }));
      res.json({ status: 'behind', yearly_target: Math.round(yearlyTarget), shortfall, per_month_bump: Math.round(perMonthBump), completed, proposed, remaining_count: remainingMonths.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
