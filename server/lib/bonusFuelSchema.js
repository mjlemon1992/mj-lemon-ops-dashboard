// Schema + seeds for the Bonus & Fuel Card module (spec §2). Shared by
// routes/bonus.js and routes/fuel.js so either can boot the tables first.
// Months are 'YYYY-MM' strings; money NUMERIC(10,2); rates/floors fractions.

const RED_DEER = '8174d72a-967b-48de-b37c-997b2d071693';

// Seeded 2026 Red Deer sales targets (spec §2).
const RD_TARGETS_2026 = {
  '2026-01': 146250, '2026-02': 146750, '2026-03': 175500, '2026-04': 180500,
  '2026-05': 190250, '2026-06': 190250, '2026-07': 185250, '2026-08': 195500,
  '2026-09': 185250, '2026-10': 185250, '2026-11': 126750, '2026-12': 126750,
};

let _init;
function ensureBonusFuelTables(pool) {
  if (_init) return _init;
  _init = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS bonus_person (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL,
      name VARCHAR(120) NOT NULL,
      role VARCHAR(10) NOT NULL CHECK (role IN ('tech','advisor')),
      active BOOLEAN NOT NULL DEFAULT true,
      efficiency_floor NUMERIC(5,4),           -- NULL = use formula group_floor
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sales_target (
      location_id UUID NOT NULL,
      month VARCHAR(7) NOT NULL,
      target NUMERIC(12,2) NOT NULL,
      PRIMARY KEY (location_id, month)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS formula_version (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL,
      version_no INTEGER NOT NULL,
      base_rate NUMERIC(7,6) NOT NULL,
      stretch_rate NUMERIC(7,6) NOT NULL,
      stretch_threshold NUMERIC(6,4) NOT NULL,
      efficiency_enabled BOOLEAN NOT NULL DEFAULT true,
      group_floor NUMERIC(5,4) NOT NULL,
      multiplier_hard_min NUMERIC(5,4) NOT NULL,
      effective_from_month VARCHAR(7) NOT NULL,
      created_by VARCHAR(120),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS bonus_run (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL,
      month VARCHAR(7) NOT NULL,
      formula_version_id UUID NOT NULL,
      revenue NUMERIC(12,2) NOT NULL,
      revenue_source VARCHAR(10) NOT NULL DEFAULT 'auto',   -- auto | manual
      revenue_override_reason TEXT,
      target NUMERIC(12,2) NOT NULL,
      net_profit NUMERIC(12,2) NOT NULL,
      rate NUMERIC(7,6) NOT NULL,
      tier VARCHAR(10) NOT NULL,                            -- none | base | stretch
      status VARCHAR(10) NOT NULL DEFAULT 'draft',          -- draft | approved
      supersedes UUID,                                      -- run this one replaces
      superseded_by UUID,                                   -- set on the OLD run
      calculated_by VARCHAR(120), calculated_at TIMESTAMPTZ DEFAULT NOW(),
      approved_by VARCHAR(120), approved_at TIMESTAMPTZ
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS bonus_line (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      bonus_run_id UUID NOT NULL REFERENCES bonus_run(id) ON DELETE CASCADE,
      person_id UUID NOT NULL,
      person_name VARCHAR(120) NOT NULL,
      role_at_calc VARCHAR(10) NOT NULL,
      efficiency NUMERIC(7,4),
      floor_used NUMERIC(5,4),
      multiplier NUMERIC(7,4),
      calculated NUMERIC(10,2) NOT NULL,
      paid NUMERIC(10,2) NOT NULL,
      override_reason TEXT, override_by VARCHAR(120), override_at TIMESTAMPTZ
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS efficiency_input (
      location_id UUID NOT NULL,
      person_id UUID NOT NULL,
      month VARCHAR(7) NOT NULL,
      billed_hours NUMERIC(8,2) NOT NULL,
      clocked_hours NUMERIC(8,2) NOT NULL,
      PRIMARY KEY (location_id, person_id, month)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS fuel_ledger (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL,
      person_id UUID,                                       -- NULL = unassigned
      type VARCHAR(16) NOT NULL,     -- bonus_credit | topup | purchase | adjustment | sweep
      amount NUMERIC(10,2) NOT NULL, -- credits positive, purchases negative
      occurred_on DATE NOT NULL,
      source VARCHAR(20) NOT NULL DEFAULT 'manual',         -- bonus_run | manual | statement_import
      bonus_run_id UUID,
      import_batch_id UUID,
      memo TEXT,
      created_by VARCHAR(120), created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS card_snapshot (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL,
      statement_date DATE NOT NULL,
      actual_balance NUMERIC(10,2) NOT NULL,
      created_by VARCHAR(120), created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS fuel_settings (
      location_id UUID PRIMARY KEY,
      sweep_enabled BOOLEAN NOT NULL DEFAULT false,         -- policy default OFF (spec §4)
      sweep_days INTEGER NOT NULL DEFAULT 90
    )`);

    // ── Red Deer seeds (idempotent: only when empty) ──
    const { rows: pc } = await pool.query('SELECT COUNT(*)::int AS n FROM bonus_person WHERE location_id = $1', [RED_DEER]);
    if (pc[0].n === 0) {
      for (const [name, role] of [['Hayden', 'tech'], ['Keith', 'tech'], ['Scott', 'tech'], ['Stephane', 'tech'], ['Stu', 'advisor']]) {
        await pool.query('INSERT INTO bonus_person (location_id, name, role) VALUES ($1,$2,$3)', [RED_DEER, name, role]);
      }
    }
    const { rows: tc } = await pool.query('SELECT COUNT(*)::int AS n FROM sales_target WHERE location_id = $1', [RED_DEER]);
    if (tc[0].n === 0) {
      for (const [month, target] of Object.entries(RD_TARGETS_2026)) {
        await pool.query('INSERT INTO sales_target (location_id, month, target) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [RED_DEER, month, target]);
      }
    }
    const { rows: fc } = await pool.query('SELECT COUNT(*)::int AS n FROM formula_version WHERE location_id = $1', [RED_DEER]);
    if (fc[0].n === 0) {
      // v1: original program (Nov 2025, flat shares). v2: efficiency multiplier (Jun 2026).
      await pool.query(
        `INSERT INTO formula_version (location_id, version_no, base_rate, stretch_rate, stretch_threshold, efficiency_enabled, group_floor, multiplier_hard_min, effective_from_month, created_by)
         VALUES ($1,1,0.005,0.0075,1.10,false,0.90,0.50,'2025-11','seed'),
                ($1,2,0.005,0.0075,1.10,true,0.90,0.50,'2026-06','seed')`, [RED_DEER]);
    }
  })();
  return _init;
}

module.exports = { ensureBonusFuelTables, RED_DEER };
