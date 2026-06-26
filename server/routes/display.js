const express = require('express');
const { workingPaceFrac, efficiencyPct } = require('../lib/workdays');

// Public, PIN-gated shop-floor display data. NO JWT — meant to run unattended on
// a TV in the bay. Each location has a short display_pin; the board passes it as
// ?pin= and only that location's numbers come back. Read-only.
module.exports = (pool) => {
  const router = express.Router();

  let _init = false;
  const ensureColumns = async () => {
    if (_init) return;
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS display_pin VARCHAR(12)');
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS weekly_hours DECIMAL(6,2) DEFAULT 40');
    _init = true;
  };

  const num = (v) => (v == null ? null : Number(v));

  router.get('/:locationId', async (req, res) => {
    try {
      await ensureColumns();
      const locRes = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locRes.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locRes.rows[0];

      const pin = (req.query.pin || '').toString();
      if (!loc.display_pin) return res.status(403).json({ error: 'Display not set up for this location yet. Set a display PIN under Locations.' });
      if (pin !== loc.display_pin) return res.status(401).json({ error: 'Incorrect PIN' });

      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const province = loc.province || 'ab';
      const locWeekly = Number(loc.weekly_hours) || 40;

      // Latest metrics snapshot (revenue MTD + freshness).
      const mRes = await pool.query(
        'SELECT revenue_mtd, parts_margin, created_at FROM metrics_cache WHERE location_id = $1 ORDER BY created_at DESC LIMIT 1',
        [req.params.locationId]
      );
      const m = mRes.rows[0] || {};
      const revenue = num(m.revenue_mtd) || 0;

      // Monthly revenue target.
      const tRes = await pool.query(
        'SELECT revenue FROM targets WHERE location_id = $1 AND year = $2 AND month = $3',
        [req.params.locationId, year, month]
      );
      const target = tRes.rows[0] && tRes.rows[0].revenue != null ? Number(tRes.rows[0].revenue) : null;
      const frac = workingPaceFrac(province, now);
      const pacePct = (target && target > 0 && frac && frac > 0) ? Math.round((revenue / (target * frac)) * 100) : null;
      const gap = target != null ? Math.round((target - revenue) * 100) / 100 : null;
      const pctToTarget = (target && target > 0) ? Math.round((revenue / target) * 100) : null;

      // Latest MTD tech snapshot.
      try { await pool.query("ALTER TABLE tech_efficiency ADD COLUMN IF NOT EXISTS period_type VARCHAR(8)"); } catch (e) {}
      const snapRes = await pool.query(
        "SELECT MAX(snapshot_date) AS d FROM tech_efficiency WHERE location_id = $1 AND period_type = 'mtd' AND snapshot_date <= CURRENT_DATE",
        [req.params.locationId]
      );
      const snapDate = snapRes.rows[0] && snapRes.rows[0].d ? snapRes.rows[0].d : null;

      // Per-tech weekly-hour overrides + hidden list.
      let whByTech = {};
      try {
        const whRes = await pool.query('SELECT tech_id, hours_per_week FROM tech_weekly_hours WHERE location_id = $1', [req.params.locationId]);
        for (const r of whRes.rows) whByTech[r.tech_id] = r.hours_per_week;
      } catch (e) {}
      let hidden = new Set();
      try {
        const hr = await pool.query('SELECT tech_id FROM hidden_techs WHERE location_id = $1', [req.params.locationId]);
        for (const r of hr.rows) hidden.add(r.tech_id);
      } catch (e) {}

      let techs = [];
      if (snapDate) {
        const teRes = await pool.query(
          "SELECT tech_id, tech_name, hours_sold, hours_billed FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2 AND period_type = 'mtd'",
          [req.params.locationId, snapDate]
        );
        techs = teRes.rows
          .filter(r => !hidden.has(r.tech_id))
          .map(r => {
            const hpw = whByTech[r.tech_id] != null ? Number(whByTech[r.tech_id]) : locWeekly;
            const sold = num(r.hours_sold);
            return {
              tech_id: r.tech_id,
              tech_name: r.tech_name,
              hours_sold: sold,
              hours_billed: num(r.hours_billed),
              hours_per_week: hpw,
              efficiency: efficiencyPct(sold, province, hpw, now)
            };
          })
          .sort((a, b) => (b.efficiency || 0) - (a.efficiency || 0));
      }

      const totalSold = techs.reduce((s, t) => s + (t.hours_sold || 0), 0);
      const totalBilled = techs.reduce((s, t) => s + (t.hours_billed || 0), 0);

      res.set('Cache-Control', 'no-store');
      res.json({
        location: { id: loc.id, name: loc.name, city: loc.city, province, weekly_hours: locWeekly },
        revenue,
        target,
        gap,
        pace_pct: pacePct,
        pct_to_target: pctToTarget,
        parts_margin: num(m.parts_margin),
        techs,
        totals: {
          hours_sold: Math.round(totalSold * 10) / 10,
          hours_billed: Math.round(totalBilled * 10) / 10
        },
        efficiency_target: Number(loc.efficiency_target) || 80,
        metrics_updated_at: m.created_at || null,
        tech_snapshot_date: snapDate,
        server_time: now.toISOString()
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
