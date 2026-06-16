#!/usr/bin/env bash
set -euo pipefail

# Run from the root of your local mj-lemon-ops-dashboard repo (has client/ and server/).
if [ ! -d client/src/pages ] || [ ! -d server/routes ]; then
  echo "ERROR: run this from the repo root (need client/ and server/)." >&2
  exit 1
fi
mkdir -p server/routes client/src/pages client/src/components

# ---------------------------------------------------------------------------
cat > server/routes/technicians.js <<'MJEOF'
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
          const r = await fetch('https://api.shopmonkey.cloud/v3/technician?limit=100', {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
          });
          if (!r.ok) {
            rosterError = `Shopmonkey API error ${r.status}`;
          } else {
            const td = await r.json();
            const list = (td && td.data && td.data.data) ? td.data.data : (td.data || []);
            roster = list
              .filter(t => t.archived !== true)
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
MJEOF

# ---------------------------------------------------------------------------
cat > server/index.js <<'MJEOF'
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json());

const authRoutes = require('./routes/auth');
const locationsRoutes = require('./routes/locations');
const targetsRoutes = require('./routes/targets');
const usersRoutes = require('./routes/users');
const metricsRoutes = require('./routes/metrics');
const techEfficiencyRoutes = require('./routes/techEfficiency');
const techniciansRoutes = require('./routes/technicians');
const shopmonkeySyncRoutes = require('./routes/shopmonkeySync');

app.use('/api/auth', authRoutes(pool));
app.use('/api/locations', locationsRoutes(pool));
app.use('/api/targets', targetsRoutes(pool));
app.use('/api/users', usersRoutes(pool));
app.use('/api/metrics', metricsRoutes(pool));
app.use('/api/tech-efficiency', techEfficiencyRoutes(pool));
app.use('/api/technicians', techniciansRoutes(pool));
app.use('/api/sync', shopmonkeySyncRoutes(pool));

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build/index.html'));
  });
}

pool.connect()
  .then(() => console.log('Database connected'))
  .catch(err => console.log('Database connection error:', err.message));

app.listen(PORT, () => console.log(`MJ Lemon Ops Dashboard running on port ${PORT}`));

module.exports = { pool };
MJEOF

# ---------------------------------------------------------------------------
cat > server/routes/locations.js <<'MJEOF'
const express = require('express');
const { authenticateToken, requireOwner } = require('../middleware/auth');

module.exports = (pool) => {
  const router = express.Router();

  router.get('/', authenticateToken, async (req, res) => {
    try {
      let query = 'SELECT * FROM locations ORDER BY name';
      let params = [];
      if (req.user.role === 'manager') {
        query = 'SELECT * FROM locations WHERE id = $1';
        params = [req.user.location_id];
      }
      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id', authenticateToken, async (req, res) => {
    try {
      if (req.user.role === 'manager' && req.user.location_id !== req.params.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const result = await pool.query('SELECT * FROM locations WHERE id = $1', [req.params.id]);
      if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', authenticateToken, requireOwner, async (req, res) => {
    const { name, address, city, province, shopmonkey_location_id, qbo_company_id, slack_channel, num_technicians, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target } = req.body;
    if (!name) return res.status(400).json({ error: 'Location name required' });
    try {
      const result = await pool.query(
        `INSERT INTO locations (name, address, city, province, shopmonkey_location_id, qbo_company_id, slack_channel, num_technicians, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true) RETURNING *`,
        [name, address, city, province, shopmonkey_location_id, qbo_company_id, slack_channel, num_technicians || 5, labour_rate || 170, stale_threshold_days || 5, parts_margin_target || 55, efficiency_target || 80, pph_target || 254]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // num_technicians is intentionally NOT updated here — it is auto-derived from
  // the live Shopmonkey roster (see routes/technicians.js) and must not be
  // clobbered by an edit-location save.
  router.put('/:id', authenticateToken, requireOwner, async (req, res) => {
    const { name, address, city, province, shopmonkey_location_id, qbo_company_id, slack_channel, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target, active } = req.body;
    try {
      const result = await pool.query(
        `UPDATE locations SET name=$1, address=$2, city=$3, province=$4, shopmonkey_location_id=$5, qbo_company_id=$6, slack_channel=$7, labour_rate=$8, stale_threshold_days=$9, parts_margin_target=$10, efficiency_target=$11, pph_target=$12, active=$13, updated_at=NOW()
         WHERE id=$14 RETURNING *`,
        [name, address, city, province, shopmonkey_location_id, qbo_company_id, slack_channel, labour_rate, stale_threshold_days, parts_margin_target, efficiency_target, pph_target, active, req.params.id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
MJEOF

# ---------------------------------------------------------------------------
cat > client/src/App.js <<'MJEOF'
import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Layout from './components/Layout';
import Home from './pages/Home';
import Performance from './pages/Performance';
import Technicians from './pages/Technicians';
import Alerts from './pages/Alerts';
import Reports from './pages/Reports';
import Comebacks from './pages/Comebacks';
import Locations from './pages/Locations';
import Targets from './pages/Targets';
import Users from './pages/Users';

function ProtectedRoute({ children, ownerOnly, ownerOrPartner }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#666' }}>Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (ownerOnly && user.role !== 'owner') return <Navigate to="/" replace />;
  if (ownerOrPartner && !['owner', 'partner'].includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route index element={<Home />} />
            <Route path="performance" element={<Performance />} />
            <Route path="technicians" element={<Technicians />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="reports" element={<ProtectedRoute ownerOrPartner><Reports /></ProtectedRoute>} />
            <Route path="comebacks" element={<Comebacks />} />
            <Route path="locations" element={<ProtectedRoute ownerOnly><Locations /></ProtectedRoute>} />
            <Route path="targets" element={<ProtectedRoute ownerOrPartner><Targets /></ProtectedRoute>} />
            <Route path="users" element={<ProtectedRoute ownerOnly><Users /></ProtectedRoute>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
MJEOF

# ---------------------------------------------------------------------------
cat > client/src/components/Layout.js <<'MJEOF'
import React, { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV = [
  { path: '/', label: 'Home', icon: '⌂', section: 'Overview' },
  { path: '/performance', label: 'Performance', icon: '◈', section: null },
  { path: '/technicians', label: 'Technicians', icon: '⚒', section: null },
  { path: '/alerts', label: 'Alerts', icon: '◉', section: null },
  { path: '/reports', label: 'Reports', icon: '▤', section: 'Reports', roles: ['owner', 'partner'] },
  { path: '/comebacks', label: 'Comebacks', icon: '↩', section: null, roles: ['owner', 'partner', 'manager'] },
  { path: '/locations', label: 'Locations', icon: '◎', section: 'Settings', roles: ['owner'] },
  { path: '/targets', label: 'Targets', icon: '◎', section: null, roles: ['owner', 'partner'] },
  { path: '/users', label: 'Users', icon: '◈', section: null, roles: ['owner'] },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [alertCount] = useState(5);

  const visibleNav = NAV.filter(n => !n.roles || n.roles.includes(user?.role));

  const initials = user?.name ? user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() : 'U';

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* Sidebar */}
      <div style={{ width: 220, flexShrink: 0, background: 'var(--bg2)', borderRight: '0.5px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 16px 14px', borderBottom: '0.5px solid var(--border)' }}>
          <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>MJ Lemon Ops</div>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>Multi-location dashboard</div>
        </div>

        <div style={{ margin: '12px', padding: '8px 10px', background: 'var(--bg3)', borderRadius: 'var(--radius)', fontSize: '12px' }}>
          <div style={{ fontWeight: '500', color: 'var(--text)' }}>All locations</div>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '1px', textTransform: 'capitalize' }}>{user?.role} view</div>
        </div>

        <nav style={{ padding: '4px 8px', flex: 1, overflowY: 'auto' }}>
          {visibleNav.map((item, i) => {
            const active = location.pathname === item.path;
            const prevItem = visibleNav[i - 1];
            const showSection = item.section && (!prevItem || prevItem.section !== item.section);
            return (
              <React.Fragment key={item.path}>
                {showSection && (
                  <div style={{ fontSize: '10px', fontWeight: '500', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '12px 8px 4px' }}>
                    {item.section}
                  </div>
                )}
                <div
                  onClick={() => navigate(item.path)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '7px 8px', borderRadius: 'var(--radius)',
                    cursor: 'pointer', fontSize: '13px',
                    color: active ? 'var(--text)' : 'var(--text2)',
                    background: active ? 'var(--bg3)' : 'transparent',
                    fontWeight: active ? '500' : '400',
                    marginBottom: '1px'
                  }}
                >
                  <span style={{ fontSize: '14px' }}>{item.icon}</span>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  {item.path === '/alerts' && alertCount > 0 && (
                    <span style={{ background: 'rgba(255,77,77,0.15)', color: 'var(--danger)', fontSize: '10px', padding: '1px 6px', borderRadius: '10px' }}>{alertCount}</span>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </nav>

        <div style={{ padding: '12px', borderTop: '0.5px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(77,184,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '500', color: 'var(--info)', flexShrink: 0 }}>{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '12px', fontWeight: '500', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', textTransform: 'capitalize' }}>{user?.role}</div>
            </div>
            <button onClick={logout} style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: '16px', padding: '4px', cursor: 'pointer' }} title="Sign out">⏻</button>
          </div>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ background: 'var(--bg2)', borderBottom: '0.5px solid var(--border)', padding: '0 24px', height: '52px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ fontSize: '15px', fontWeight: '500', color: 'var(--text)' }}>
            {visibleNav.find(n => n.path === location.pathname)?.label || 'Dashboard'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {alertCount > 0 && (
              <div className="badge danger" style={{ cursor: 'pointer' }} onClick={() => navigate('/alerts')}>
                ⚠ {alertCount} active alerts
              </div>
            )}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
MJEOF

# ---------------------------------------------------------------------------
cat > client/src/pages/Performance.js <<'MJEOF'
import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const num = v => (typeof v === 'number' ? v : parseFloat(v)) || 0;
const money0 = n => '$' + Math.round(num(n)).toLocaleString('en-CA');
const hrs = n => (Math.round(num(n) * 10) / 10).toLocaleString('en-CA') + ' hrs';
const hrsNum = n => (Math.round(num(n) * 10) / 10).toLocaleString('en-CA');

export default function Performance() {
  const { user, api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [locId, setLocId] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [target, setTarget] = useState(null);
  const [techData, setTechData] = useState(null);
  const [loading, setLoading] = useState(true);

  const year = new Date().getFullYear();
  const month = new Date().getMonth() + 1;

  useEffect(() => {
    api('/locations').then(locs => {
      setLocations(locs);
      const active = locs.filter(l => l.active);
      const first = active[0] || locs[0];
      if (first) setLocId(first.id);
      else setLoading(false);
    }).catch(() => setLoading(false));
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!locId) return;
    setLoading(true);
    Promise.all([
      api(`/metrics/${locId}/summary`).catch(() => null),
      api(`/technicians/${locId}`).catch(() => null),
      api(`/targets/${locId}/${year}`).catch(() => []),
    ]).then(([m, t, tg]) => {
      setMetrics(m);
      setTechData(t);
      setTarget(Array.isArray(tg) ? (tg.find(r => r.month === month) || null) : null);
      setLoading(false);
    });
  }, [locId]); // eslint-disable-line

  const loc = locations.find(l => l.id === locId);
  const showFinancials = user?.role !== 'manager';

  if (loading) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading…</div>;

  const hasMetrics = !!metrics && num(metrics.revenue_mtd) > 0;
  const revenue = num(metrics?.revenue_mtd);
  const profit = num(metrics?.total_profit);
  const profitMargin = revenue > 0 ? (profit / revenue) * 100 : 0;
  const partsMargin = num(metrics?.parts_margin);
  const labourMargin = num(metrics?.labour_margin);
  const carCount = num(metrics?.car_count_mtd);
  const avgRO = num(metrics?.avg_ro_value);
  const labourHoursSold = num(metrics?.labour_hours_sold);
  const pph = num(metrics?.pph);
  const efficiency = metrics?.efficiency_avg == null ? null : num(metrics.efficiency_avg);
  const labourRate = num(loc?.labour_rate) || 170;
  const labourRevenue = labourHoursSold * labourRate;
  const partsOtherRevenue = revenue - labourRevenue;

  const pphTarget = num(loc?.pph_target) || 254;
  const effTarget = num(loc?.efficiency_target) || 80;
  const pmTarget = num(loc?.parts_margin_target) || 55;

  const techs = (techData && techData.technicians) || [];
  const techCount = techData?.count ?? (loc ? loc.num_technicians : 0);
  const hasHours = !!(techData && techData.has_hours);
  const totalSold = techs.reduce((s, t) => s + num(t.hours_sold), 0);
  const totalLabRev = techs.reduce((s, t) => s + num(t.labour_revenue), 0);

  const metricsVsTarget = [
    ['Car count', hasMetrics ? (String(carCount) + (target && target.car_count ? ` / ${target.car_count}` : '')) : '—', target && target.car_count ? `${Math.round(carCount / num(target.car_count) * 100)}%` : 'this month', target && target.car_count ? carCount >= num(target.car_count) : true],
    ['Parts margin', partsMargin > 0 ? `${partsMargin.toFixed(1)}%` : '—', `vs ${pmTarget}%`, partsMargin >= pmTarget],
    ['Labour margin', labourMargin > 0 ? `${labourMargin.toFixed(1)}%` : '—', target && target.labour_margin ? `vs ${num(target.labour_margin)}%` : 'vs 70%', labourMargin >= num((target && target.labour_margin) || 70)],
    ['Avg RO value', avgRO > 0 ? money0(avgRO) : '—', target && target.avg_ro_value ? `vs ${money0(num(target.avg_ro_value))}` : 'per car', target && target.avg_ro_value ? avgRO >= num(target.avg_ro_value) : true],
    ['Labour hours sold', labourHoursSold > 0 ? hrsNum(labourHoursSold) : '—', target && target.labour_hours ? `vs ${Math.round(num(target.labour_hours))}` : 'this month', target && target.labour_hours ? labourHoursSold >= num(target.labour_hours) : true],
    ['Efficiency', efficiency != null && efficiency > 0 ? `${Math.round(efficiency)}%` : '—', efficiency != null && efficiency > 0 ? `vs ${effTarget}%` : 'pending QBO Time', efficiency != null ? efficiency >= effTarget : true],
  ];

  const profitRows = [
    ['Total profit', hasMetrics ? money0(profit) : '—', `${profitMargin.toFixed(1)}% margin`],
    ['Labour revenue', hasMetrics ? money0(labourRevenue) : '—', 'hours sold × rate'],
    ['Parts & other revenue', hasMetrics ? money0(partsOtherRevenue) : '—', 'revenue − labour'],
    ['Labour hours sold', labourHoursSold > 0 ? hrsNum(labourHoursSold) : '—', 'billed this month'],
    ['Profit per hour', pph > 0 ? `$${Math.round(pph)}` : '—', 'hours sold basis'],
  ];

  return (
    <div>
      {/* location + period */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        {locations.length > 1 ? (
          <select value={locId || ''} onChange={e => setLocId(e.target.value)} style={{ width: 'auto' }}>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>{loc?.name || 'Location'}</div>
        )}
        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>This month · {hasMetrics ? 'live from Shopmonkey' : 'awaiting sync'}</div>
      </div>

      {/* PPH / efficiency banner */}
      <div style={{ background: 'var(--bg3)', borderRadius: 'var(--radius)', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>Profit per hour</div>
          <div style={{ fontSize: '30px', fontWeight: '500', color: 'var(--text)' }}>{pph > 0 ? `$${Math.round(pph)}` : '—'}<span style={{ fontSize: '13px', color: 'var(--text3)', fontWeight: '400' }}>/hr</span></div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>vs ${pphTarget} target</div>
          {pph > 0 ? (
            <>
              <div style={{ fontSize: '14px', color: pph >= pphTarget ? 'var(--success)' : 'var(--warning)', fontWeight: '500' }}>{pph >= pphTarget ? '+' : '-'}${Math.abs(Math.round(pphTarget - pph))}/hr</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{Math.round(pph / pphTarget * 100)}% of target</div>
            </>
          ) : <div style={{ fontSize: '12px', color: 'var(--text3)' }}>awaiting sync</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>Group efficiency</div>
          <div style={{ fontSize: '30px', fontWeight: '500', color: 'var(--text)' }}>{efficiency != null && efficiency > 0 ? `${Math.round(efficiency)}%` : '—'}</div>
          <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{efficiency != null && efficiency > 0 ? (efficiency >= effTarget ? `above ${effTarget}% target ✓` : `below ${effTarget}% target`) : 'pending QBO Time'}</div>
        </div>
      </div>

      {/* headline cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px', marginBottom: '16px' }}>
        <div className="metric-card">
          <div className="metric-label">Revenue MTD</div>
          <div className="metric-value">{hasMetrics ? money0(revenue) : '—'}</div>
          <div className="metric-sub">{target && target.revenue ? `vs $${Math.round(num(target.revenue) / 1000)}k target` : (hasMetrics ? 'live from Shopmonkey' : 'awaiting sync')}</div>
        </div>
        {showFinancials && (
          <div className="metric-card">
            <div className="metric-label">Total profit</div>
            <div className="metric-value">{hasMetrics ? money0(profit) : '—'}</div>
            <div className={`metric-sub ${profitMargin > 0 ? 'good' : ''}`}>{hasMetrics ? `${profitMargin.toFixed(1)}% margin` : 'awaiting sync'}</div>
          </div>
        )}
        <div className="metric-card">
          <div className="metric-label">Parts margin</div>
          <div className="metric-value">{partsMargin > 0 ? `${partsMargin.toFixed(1)}%` : '—'}</div>
          <div className={`metric-sub ${partsMargin >= pmTarget ? 'good' : 'warn'}`}>{partsMargin > 0 ? (partsMargin >= pmTarget ? `above ${pmTarget}% target ✓` : `vs ${pmTarget}% target ⚠`) : 'awaiting sync'}</div>
        </div>
      </div>

      {/* metrics vs target + profit & labour */}
      <div style={{ display: 'grid', gridTemplateColumns: showFinancials ? '1fr 1fr' : '1fr', gap: '12px', marginBottom: '16px' }}>
        <div className="card">
          <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '12px' }}>Metrics vs target</div>
          {metricsVsTarget.map(([l, a, t, ok]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text2)' }}>{l}</div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>{a}</div>
                <div style={{ fontSize: '11px', color: ok ? 'var(--success)' : 'var(--warning)' }}>{t}</div>
              </div>
            </div>
          ))}
        </div>
        {showFinancials && (
          <div className="card">
            <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)', marginBottom: '12px' }}>Profit &amp; labour</div>
            {profitRows.map(([l, a, t]) => (
              <div key={l} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: '12px', color: 'var(--text2)' }}>{l}</div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>{a}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{t}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* technician table */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
          <div style={{ fontSize: '13px', fontWeight: '500', color: 'var(--text)' }}>Technicians ({techCount})</div>
          <div style={{ fontSize: '11px', color: 'var(--text3)' }}>live roster from Shopmonkey</div>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '12px' }}>
          Hours sold is live from Shopmonkey. Worked hours, efficiency and profit/hour need clocked time (QBO Time) — connecting at close.
        </div>
        {techs.length === 0 ? (
          <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)', fontSize: '12px' }}>
            {techData && techData.roster_error ? `Roster unavailable: ${techData.roster_error}` : 'No technicians returned from Shopmonkey yet.'}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Technician</th>
                  <th>Hours sold</th>
                  {showFinancials && <th>Labour revenue</th>}
                  <th>Worked</th>
                  <th>Efficiency</th>
                </tr>
              </thead>
              <tbody>
                {techs.map(t => (
                  <tr key={t.tech_id || t.tech_name}>
                    <td className="strong">{t.tech_name}</td>
                    <td>{t.hours_sold != null ? hrs(t.hours_sold) : <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                    {showFinancials && <td>{t.labour_revenue != null ? money0(t.labour_revenue) : <span style={{ color: 'var(--text3)' }}>—</span>}</td>}
                    <td style={{ color: 'var(--text3)' }}>awaiting payroll</td>
                    <td style={{ color: 'var(--text3)' }}>awaiting payroll</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '0.5px solid var(--border2)' }}>
                  <td className="strong">Group total</td>
                  <td className="strong">{hasHours ? hrs(totalSold) : '—'}</td>
                  {showFinancials && <td className="strong">{hasHours ? money0(totalLabRev) : '—'}</td>}
                  <td style={{ color: 'var(--text3)' }}>—</td>
                  <td style={{ color: 'var(--text3)' }}>—</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {!hasHours && techs.length > 0 && (
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '10px' }}>
            Roster is live. Hours-sold figures populate after the next tech sync (same schedule as metrics).
          </div>
        )}
      </div>
    </div>
  );
}
MJEOF

# ---------------------------------------------------------------------------
cat > client/src/pages/Technicians.js <<'MJEOF'
import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const num = v => (typeof v === 'number' ? v : parseFloat(v)) || 0;
const money0 = n => '$' + Math.round(num(n)).toLocaleString('en-CA');
const hrsNum = n => (Math.round(num(n) * 10) / 10).toLocaleString('en-CA');

export default function Technicians() {
  const { user, api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [locId, setLocId] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const showFinancials = user?.role !== 'manager';

  useEffect(() => {
    api('/locations').then(locs => {
      const active = locs.filter(l => l.active);
      setLocations(active.length ? active : locs);
      const first = active[0] || locs[0];
      if (first) setLocId(first.id);
      else setLoading(false);
    }).catch(() => { setError('Could not load locations'); setLoading(false); });
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!locId) return;
    setLoading(true); setError(null);
    api(`/technicians/${locId}`).then(d => { setData(d); setLoading(false); })
      .catch(err => { setError(err.message || 'Could not load technicians'); setLoading(false); });
  }, [locId]); // eslint-disable-line

  const techs = (data && data.technicians) || [];
  const count = data?.count ?? 0;
  const hasHours = !!(data && data.has_hours);
  const totalSold = techs.reduce((s, t) => s + num(t.hours_sold), 0);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
        <div>
          <h1 style={{ fontSize: '18px', fontWeight: '600', color: 'var(--text)', margin: 0 }}>Technicians</h1>
          <div style={{ fontSize: '12px', color: 'var(--text3)', marginTop: '3px' }}>
            Live roster pulled from Shopmonkey. Add or remove techs in Shopmonkey and this follows on the next sync — no manual list to maintain.
          </div>
        </div>
        {locations.length > 1 && (
          <select value={locId || ''} onChange={e => setLocId(e.target.value)} style={{ fontSize: '12px' }}>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>

      {error && <div className="card" style={{ padding: '14px', color: 'var(--danger)', margin: '12px 0' }}>{error}</div>}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)' }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', margin: '14px 0 18px' }}>
            <div className="card" style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Technicians</div>
              <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--text)', marginTop: '4px' }}>{count}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>{data?.roster_source === 'shopmonkey_live' ? 'live count' : 'last known'}</div>
            </div>
            {showFinancials && (
              <div className="card" style={{ padding: '14px 16px' }}>
                <div style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Hours sold MTD</div>
                <div style={{ fontSize: '24px', fontWeight: '600', color: 'var(--text)', marginTop: '4px' }}>{hasHours ? hrsNum(totalSold) : '—'}</div>
                <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>{hasHours ? 'billed across roster' : 'pending tech sync'}</div>
              </div>
            )}
          </div>

          {data?.roster_error && (
            <div className="card" style={{ padding: '12px 14px', color: 'var(--warning)', fontSize: '12px', marginBottom: '12px' }}>
              Live roster unavailable ({data.roster_error}); showing last known count.
            </div>
          )}

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: 'var(--bg3)', color: 'var(--text3)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px', fontWeight: '500' }}>Technician</th>
                  <th style={{ padding: '8px 12px', fontWeight: '500', textAlign: 'right' }}>Hours sold (MTD)</th>
                  {showFinancials && <th style={{ padding: '8px 12px', fontWeight: '500', textAlign: 'right' }}>Labour revenue (MTD)</th>}
                  <th style={{ padding: '8px 12px', fontWeight: '500', textAlign: 'right' }}>Efficiency</th>
                </tr>
              </thead>
              <tbody>
                {techs.length === 0 ? (
                  <tr><td colSpan={showFinancials ? 4 : 3} style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)' }}>No technicians returned from Shopmonkey.</td></tr>
                ) : techs.map(t => (
                  <tr key={t.tech_id || t.tech_name} style={{ borderTop: '0.5px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', color: 'var(--text)' }} className="strong">{t.tech_name}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: t.hours_sold != null ? 'var(--text)' : 'var(--text3)' }}>{t.hours_sold != null ? hrsNum(t.hours_sold) : '—'}</td>
                    {showFinancials && <td style={{ padding: '8px 12px', textAlign: 'right', color: t.labour_revenue != null ? 'var(--text)' : 'var(--text3)' }}>{t.labour_revenue != null ? money0(t.labour_revenue) : '—'}</td>}
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text3)' }}>awaiting payroll</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '10px' }}>
            Efficiency and profit/hour need clocked hours from payroll (QBO Time), which connects at close. Until then, hours sold is the live signal from Shopmonkey. Warranty/$0 comeback tickets often have no tech assigned, so they won't attribute here.
          </div>
        </>
      )}
    </div>
  );
}
MJEOF

# ---------------------------------------------------------------------------
cat > client/src/pages/Locations.js <<'MJEOF'
import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const EMPTY = { name: '', address: '', city: '', province: 'BC', shopmonkey_location_id: '', qbo_company_id: '', slack_channel: '', num_technicians: 5, labour_rate: 170, stale_threshold_days: 5, parts_margin_target: 55, efficiency_target: 80, pph_target: 254, active: true };

export default function Locations() {
  const { api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api('/locations').then(setLocations).catch(() => {}); }, []);

  const openNew = () => { setForm(EMPTY); setEditing('new'); setError(''); };
  const openEdit = loc => { setForm({ ...loc }); setEditing(loc.id); setError(''); };

  const save = async () => {
    setSaving(true); setError('');
    try {
      if (editing === 'new') {
        const loc = await api('/locations', { method: 'POST', body: JSON.stringify(form) });
        setLocations(prev => [...prev, loc]);
      } else {
        const loc = await api(`/locations/${editing}`, { method: 'PUT', body: JSON.stringify(form) });
        setLocations(prev => prev.map(l => l.id === editing ? loc : l));
      }
      setEditing(null);
    } catch (err) { setError(err.message); }
    setSaving(false);
  };

  const field = (key, label, type = 'text', extra = {}) => (
    <div className="form-group" key={key}>
      <label className="form-label">{label}</label>
      <input type={type} value={form[key] ?? ''} onChange={e => setForm(f => ({ ...f, [key]: type === 'number' ? parseFloat(e.target.value) : e.target.value }))} {...extra} />
    </div>
  );

  if (editing !== null) {
    return (
      <div>
        <div className="page-header">
          <div className="page-title-text">{editing === 'new' ? 'Add location' : 'Edit location'}</div>
          <button onClick={() => setEditing(null)}>Cancel</button>
        </div>
        <div className="card">
          <div className="form-section">
            <div className="form-section-title">Basic info</div>
            <div className="form-row">{field('name','Location name')} {field('city','City')}</div>
            <div className="form-row">{field('address','Address')} {field('province','Province')}</div>
          </div>
          <div className="form-section">
            <div className="form-section-title">Integrations</div>
            <div className="form-row">{field('shopmonkey_location_id','Shopmonkey location ID')} {field('qbo_company_id','QBO company ID')}</div>
            {field('slack_channel','Slack channel (e.g. #kelowna-alerts)')}
          </div>
          <div className="form-section">
            <div className="form-section-title">Configuration</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Technicians (auto-derived)</label>
                <input type="text" value={`${form.num_technicians ?? '—'} · synced from Shopmonkey`} disabled readOnly />
                <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '4px' }}>Pulled live from the Shopmonkey roster (see the Technicians page) — no longer set by hand.</div>
              </div>
              {field('labour_rate','Labour rate ($/hr)','number',{min:1})}
            </div>
            <div className="form-row">{field('stale_threshold_days','Stale vehicle threshold (days)','number',{min:1})} {field('pph_target','PPH target ($/hr)','number',{min:1})}</div>
            <div className="form-row">{field('parts_margin_target','Parts margin target (%)','number',{min:0,max:100})} {field('efficiency_target','Efficiency target (%)','number',{min:0,max:100})}</div>
          </div>
          {error && <div style={{ fontSize: '12px', color: 'var(--danger)', marginBottom: '12px' }}>{error}</div>}
          <div className="btn-row">
            <button onClick={() => setEditing(null)}>Cancel</button>
            <button className="primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save location'}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-title-text">Locations</div>
        <button className="primary" onClick={openNew}>+ Add location</button>
      </div>

      {locations.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)' }}>
          No locations yet. Add your first location to get started.
        </div>
      )}

      {locations.map(loc => (
        <div key={loc.id} className="card" style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text)' }}>{loc.name}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>{loc.city}, {loc.province} · {loc.active ? 'Active' : 'Inactive'}</div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => openEdit(loc)}>Edit</button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px' }}>
            {[
              ['Shopmonkey ID', loc.shopmonkey_location_id || 'Not set'],
              ['QBO Company', loc.qbo_company_id || 'Connect after closing'],
              ['Slack channel', loc.slack_channel || 'Not set'],
              ['Technicians (live)', loc.num_technicians],
              ['Labour rate', `$${loc.labour_rate}/hr`],
              ['Stale threshold', `${loc.stale_threshold_days} days`],
              ['Parts margin target', `${loc.parts_margin_target}%`],
              ['Efficiency target', `${loc.efficiency_target}%`],
              ['PPH target', `$${loc.pph_target}/hr`],
            ].map(([l, v]) => (
              <div key={l}>
                <div style={{ fontSize: '10px', color: 'var(--text3)', marginBottom: '2px' }}>{l}</div>
                <div style={{ fontSize: '12px', color: 'var(--text)' }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
MJEOF

# ---------------------------------------------------------------------------
git add -A
git commit -m "Technicians: live Shopmonkey roster + real-data Performance page + auto-derived tech count" || echo "(nothing to commit)"
git push origin main || { echo "push rejected — pulling latest then retrying"; git pull --rebase origin main && git push origin main; }
echo "Done. Railway will rebuild and deploy in ~2-3 min."wc -l deploy.sh
