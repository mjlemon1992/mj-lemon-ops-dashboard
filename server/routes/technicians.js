const express = require('express');
const { authenticateToken } = require('../middleware/auth');

// GET /api/technicians/:locationId
// Live technician roster from Shopmonkey (/v3/technician), merged with the
// latest hours-sold snapshot from tech_efficiency. Also auto-derives the
// location's technician count from the live roster (replaces the manual field).
// Worked hours / efficiency stay null until QBO Time (clocked hours) connects.
module.exports = (pool) => {
  const router = express.Router();

  router.get('/:locationId', authenticateToken, async (req, res) => {
    const apiKey = process.env.SHOPMONKEY_API_KEY;
    try {
      if (req.user.role === 'manager' && req.user.location_id !== req.params.locationId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const locResult = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.locationId]);
      if (!locResult.rows.length) return res.status(404).json({ error: 'Location not found' });
      const loc = locResult.rows[0];

      // 1) Live roster from Shopmonkey (same response-shape handling as sync routes).
      let roster = [];
      let rosterError = null;
      if (!apiKey) {
        rosterError = 'SHOPMONKEY_API_KEY not configured';
      } else {
        try {
          const r = await fetch('https://api.shopmonkey.cloud/v3/user?limit=200', {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
          });
          if (!r.ok) {
            rosterError = `Shopmonkey API error ${r.status}`;
          } else {
            const td = await r.json();
            const list = (td && td.data && td.data.data) ? td.data.data : (td.data || []);
            roster = list
              .filter(t => t.assignedTechnician === true && t.active !== false)
              .map(t => ({
                tech_id: t.id,
                tech_name: t.name || [t.firstName, t.lastName].filter(Boolean).join(' ') || 'Unknown'
              }));
          }
        } catch (e) {
          rosterError = e.message;
        }
      }

      // 2) Latest hours-sold snapshot per tech from tech_efficiency.
      let hoursByTech = {};
      let snapshotDate = null;
      const teLatest = await pool.query(
        'SELECT MAX(snapshot_date) AS d FROM tech_efficiency WHERE location_id = $1',
        [req.params.locationId]
      );
      snapshotDate = teLatest.rows[0] && teLatest.rows[0].d ? teLatest.rows[0].d : null;
      if (snapshotDate) {
        const te = await pool.query(
          `SELECT tech_id, tech_name, hours_sold, hours_worked, efficiency, labour_revenue
           FROM tech_efficiency WHERE location_id = $1 AND snapshot_date = $2`,
          [req.params.locationId, snapshotDate]
        );
        for (const row of te.rows) {
          if (row.tech_id) hoursByTech[row.tech_id] = row;
        }
      }

      // 3) Merge roster + hours. Roster is the source of truth for who exists.
      const technicians = roster.map(t => {
        const h = hoursByTech[t.tech_id];
        return {
          tech_id: t.tech_id,
          tech_name: t.tech_name,
          hours_sold: h && h.hours_sold != null ? Number(h.hours_sold) : null,
          hours_worked: h && h.hours_worked != null ? Number(h.hours_worked) : null,
          efficiency: h && h.efficiency != null ? Number(h.efficiency) : null,
          labour_revenue: h && h.labour_revenue != null ? Number(h.labour_revenue) : null
        };
      });

      // 4) Auto-derive the location's technician count from the live roster.
      let derivedCount = technicians.length;
      if (!rosterError && derivedCount > 0) {
        await pool.query(
          'UPDATE locations SET num_technicians = $1, updated_at = NOW() WHERE id = $2',
          [derivedCount, req.params.locationId]
        );
      } else {
        derivedCount = loc.num_technicians;
      }

      res.json({
        technicians,
        count: technicians.length,
        derived_count: derivedCount,
        hours_snapshot_date: snapshotDate,
        has_hours: !!snapshotDate,
        roster_source: rosterError ? 'unavailable' : 'shopmonkey_live',
        roster_error: rosterError
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
