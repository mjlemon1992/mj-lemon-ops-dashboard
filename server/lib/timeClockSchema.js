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
    // The roster serves two systems: everyone active is on the TIME CLOCK, but
    // only in_bonus people participate in the profit-share (probation hires and
    // owner-techs can clock without joining the program).
    await pool.query('ALTER TABLE bonus_person ADD COLUMN IF NOT EXISTS in_bonus BOOLEAN DEFAULT true');
    // Personalization: each tech picks a name colour and a profile photo from
    // the kiosk (iPad camera) — shown on the kiosk, Technicians page, and the
    // shop-floor board. Photos stored small (client resizes before upload).
    await pool.query('ALTER TABLE bonus_person ADD COLUMN IF NOT EXISTS color VARCHAR(20)');
    await pool.query('ALTER TABLE bonus_person ADD COLUMN IF NOT EXISTS photo BYTEA');
    await pool.query('ALTER TABLE bonus_person ADD COLUMN IF NOT EXISTS photo_mime VARCHAR(40)');
    // Timesheet alteration requests: a tech flags a punch (or a missing one)
    // from the kiosk; owner/manager fixes the entry and resolves the request.
    await pool.query(`CREATE TABLE IF NOT EXISTS time_edit_request (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL,
      person_id UUID NOT NULL,
      entry_id UUID,                          -- NULL = "a punch is missing"
      note TEXT NOT NULL,
      status VARCHAR(10) NOT NULL DEFAULT 'pending',   -- pending | resolved | dismissed
      requested_at TIMESTAMPTZ DEFAULT now(),
      resolved_by VARCHAR(200),
      resolved_at TIMESTAMPTZ
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ter_loc_status ON time_edit_request (location_id, status)');
    // Individual break segments [{start, end}] — break_seconds stays the
    // canonical figure for pay math; this records WHEN each break happened.
    await pool.query("ALTER TABLE time_clock_entry ADD COLUMN IF NOT EXISTS breaks JSONB DEFAULT '[]'");
    // A change request can carry the tech's PROPOSED corrected times, which the
    // admin can apply in one tap.
    await pool.query('ALTER TABLE time_edit_request ADD COLUMN IF NOT EXISTS proposed_clock_in TIMESTAMPTZ');
    await pool.query('ALTER TABLE time_edit_request ADD COLUMN IF NOT EXISTS proposed_clock_out TIMESTAMPTZ');
    await pool.query('ALTER TABLE time_edit_request ADD COLUMN IF NOT EXISTS proposed_break_minutes INTEGER');
    // Paid or unpaid time off: the tech chooses on the kiosk (owner can flip it
    // on the request card). Paid days pay the contractual daily hours in the
    // period totals; NULL = not chosen yet.
    await pool.query('ALTER TABLE time_off_request ADD COLUMN IF NOT EXISTS paid BOOLEAN');
    // Annual holiday allowance in working days (stat holidays excluded — they
    // never count against it). NULL = no allowance set, no warnings.
    await pool.query('ALTER TABLE bonus_person ADD COLUMN IF NOT EXISTS vacation_days_per_year INTEGER');
    // Holiday allowance is now tracked in HOURS (matches QuickBooks PTO). The
    // days column is retained for back-compat; one-time backfill at 8h/day.
    await pool.query('ALTER TABLE bonus_person ADD COLUMN IF NOT EXISTS vacation_hours_per_year NUMERIC');
    await pool.query('UPDATE bonus_person SET vacation_hours_per_year = vacation_days_per_year * 8 WHERE vacation_hours_per_year IS NULL AND vacation_days_per_year IS NOT NULL');
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
    // Holiday / time-off requests: tech asks from the kiosk, owner/manager
    // decides. Approved requests optionally mirror to the Shopmonkey calendar
    // (sm_appointment_id) and holiday-adjust the bonus schedule denominator.
    await pool.query(`CREATE TABLE IF NOT EXISTS time_off_request (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL,
      person_id UUID NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      type VARCHAR(12) NOT NULL DEFAULT 'vacation',   -- vacation | sick | unpaid | other
      note TEXT,
      status VARCHAR(10) NOT NULL DEFAULT 'pending',  -- pending | approved | denied | cancelled
      working_days INTEGER,                            -- Mon–Fri minus stat holidays, sized at request time
      sm_appointment_id TEXT,
      requested_at TIMESTAMPTZ DEFAULT now(),
      decided_by VARCHAR(200),
      decided_at TIMESTAMPTZ
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tor_loc_dates ON time_off_request (location_id, start_date, end_date)');
    // Group closures ("shop shut Dec 24–28"): one row with person_id NULL that
    // applies to the whole crew — never charged to personal day-off totals.
    await pool.query('ALTER TABLE time_off_request ALTER COLUMN person_id DROP NOT NULL');
    // Biweekly payroll: periods are 14 days from this anchor (a period START date).
    await pool.query('ALTER TABLE locations ADD COLUMN IF NOT EXISTS pay_period_anchor DATE');
    // Which stat holidays have already been mirrored to the Shopmonkey calendar
    // (per location) — makes the push idempotent.
    await pool.query(`CREATE TABLE IF NOT EXISTS holiday_sm_push (
      location_id UUID NOT NULL,
      holiday_date DATE NOT NULL,
      sm_appointment_id TEXT,
      pushed_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (location_id, holiday_date)
    )`);
    // Which weekdays the shop is open ('mon,tue,...'). Drives how holiday days
    // are counted (days used) and the bonus schedule denominator.
    await pool.query("ALTER TABLE locations ADD COLUMN IF NOT EXISTS open_days VARCHAR(40) DEFAULT 'mon,tue,wed,thu,fri'");
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

// Same idea over an arbitrary local-date range (payroll periods): [from..to] inclusive.
async function paidHoursByRange(pool, locationId, from, to) {
  const { rows } = await pool.query(
    `SELECT person_id,
            ROUND(SUM(EXTRACT(EPOCH FROM (clock_out - clock_in)) - break_seconds) / 3600.0, 2) AS hours
       FROM time_clock_entry
      WHERE location_id = $1
        AND clock_out IS NOT NULL
        AND (clock_in AT TIME ZONE 'America/Edmonton')::date BETWEEN $2::date AND $3::date
      GROUP BY person_id`,
    [locationId, from, to]);
  const out = {};
  for (const r of rows) out[r.person_id] = Math.max(0, Number(r.hours) || 0);
  return out;
}

// Approved time-off days overlapping a month ('YYYY-MM'), counted on the
// shop's OPEN days only (isodow list, default Mon–Fri), clipped to the month.
// Returns { byPerson: {person_id: days}, closure: days } — closure rows
// (person_id NULL) apply to the whole crew.
async function approvedOffDaysByMonth(pool, locationId, month, isodow = [1, 2, 3, 4, 5]) {
  const { rows } = await pool.query(
    `SELECT person_id,
            SUM((SELECT COUNT(*) FROM generate_series(GREATEST(start_date, ($2||'-01')::date),
                                                       LEAST(end_date, (($2||'-01')::date + interval '1 month' - interval '1 day')::date),
                                                       '1 day') d
                  WHERE EXTRACT(ISODOW FROM d) = ANY($3::int[]))) AS days
       FROM time_off_request
      WHERE location_id = $1 AND status = 'approved'
        AND start_date <= (($2||'-01')::date + interval '1 month' - interval '1 day')::date
        AND end_date >= ($2||'-01')::date
      GROUP BY person_id`,
    [locationId, month, isodow]);
  const out = { byPerson: {}, closure: 0 };
  for (const r of rows) {
    if (r.person_id == null) out.closure += Number(r.days) || 0;
    else out.byPerson[r.person_id] = Number(r.days) || 0;
  }
  return out;
}

// Same open-day counting over an arbitrary [from..to] range — payroll shows
// days off inside each biweekly pay period. Same { byPerson, closure } shape.
async function approvedOffDaysByRange(pool, locationId, from, to, isodow = [1, 2, 3, 4, 5]) {
  const { rows } = await pool.query(
    `SELECT person_id,
            SUM((SELECT COUNT(*) FROM generate_series(GREATEST(start_date, $2::date),
                                                       LEAST(end_date, $3::date), '1 day') d
                  WHERE EXTRACT(ISODOW FROM d) = ANY($4::int[]))) AS days
       FROM time_off_request
      WHERE location_id = $1 AND status = 'approved'
        AND start_date <= $3::date AND end_date >= $2::date
      GROUP BY person_id`,
    [locationId, from, to, isodow]);
  const out = { byPerson: {}, closure: 0 };
  for (const r of rows) {
    if (r.person_id == null) out.closure += Number(r.days) || 0;
    else out.byPerson[r.person_id] = Number(r.days) || 0;
  }
  return out;
}

// JS weekday Set (0=Sun..6) → Postgres ISODOW list (1=Mon..7=Sun).
const toIsodow = (openSet) => [...openSet].map((d) => (d === 0 ? 7 : d));

module.exports = { ensureTimeClockTables, paidHoursByMonth, paidHoursByRange, approvedOffDaysByMonth, approvedOffDaysByRange, toIsodow };
