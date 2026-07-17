// Schema + helpers for the shop-floor Time Clock (fixed-wage attendance).
// Techs punch in/out (and breaks) on a shared kiosk; owner/manager correct
// mistakes. Monthly paid hours feed the bonus efficiency denominator, replacing
// the 40h/week formula whenever real punches exist for a person that month.

let _init;
function ensureTimeClockTables(pool) {
  if (_init) return _init;
  _init = (async () => {
    // Per-person 4–6 digit kiosk PIN (on the existing bonus crew roster).
    await pool.query('ALTER TABLE bonus_person ADD COLUMN IF NOT EXISTS clock_pin VARCHAR(8)');
    await pool.query(`CREATE TABLE IF NOT EXISTS time_clock_entry (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL,
      person_id UUID NOT NULL,
      clock_in TIMESTAMPTZ NOT NULL,
      clock_out TIMESTAMPTZ,                 -- NULL = still on shift
      break_seconds INTEGER NOT NULL DEFAULT 0,
      break_started_at TIMESTAMPTZ,          -- non-NULL = currently on break
      note TEXT,
      source VARCHAR(12) DEFAULT 'kiosk',    -- kiosk | manual
      created_by VARCHAR(200),
      corrected_by VARCHAR(200),
      corrected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tce_loc_person_in ON time_clock_entry (location_id, person_id, clock_in)');
    // At most one open (un-clocked-out) entry per person — guards double-punch.
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_tce_one_open ON time_clock_entry (person_id) WHERE clock_out IS NULL');
  })();
  return _init;
}

// Paid hours per person for a month = Σ (clock_out − clock_in − unpaid breaks),
// completed entries only, keyed by the month of clock_in in the shop's tz.
// Returns { [person_id]: hours(2dp) }. Only people WITH punches appear.
async function paidHoursByMonth(pool, locationId, month) {
  const { rows } = await pool.query(
    `SELECT person_id,
            ROUND(SUM(EXTRACT(EPOCH FROM (clock_out - clock_in)) - break_seconds) / 3600.0, 2) AS hours
       FROM time_clock_entry
      WHERE location_id = $1
        AND clock_out IS NOT NULL
        AND to_char(clock_in AT TIME ZONE 'America/Edmonton', 'YYYY-MM') = $2
      GROUP BY person_id`,
    [locationId, month]);
  const out = {};
  for (const r of rows) out[r.person_id] = Math.max(0, Number(r.hours) || 0);
  return out;
}

module.exports = { ensureTimeClockTables, paidHoursByMonth };
