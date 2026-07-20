-- MJ Lemon Ops Dashboard Database Schema
-- Run this against your PostgreSQL database to set up tables

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS locations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  address VARCHAR(255),
  city VARCHAR(100),
  province VARCHAR(50),
  shopmonkey_location_id VARCHAR(255),
  qbo_company_id VARCHAR(255),
  google_place_id VARCHAR(255),
  google_drive_folder_id VARCHAR(255),
  slack_channel VARCHAR(100),
  num_technicians INTEGER DEFAULT 5,
  labour_rate DECIMAL(10,2) DEFAULT 170.00,
  stale_threshold_days INTEGER DEFAULT 5,
  parts_margin_target DECIMAL(5,2) DEFAULT 55.00,
  efficiency_target DECIMAL(5,2) DEFAULT 80.00,
  pph_target DECIMAL(10,2) DEFAULT 254.00,
  display_pin VARCHAR(12),
  weekly_hours DECIMAL(6,2) DEFAULT 40,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'partner', 'manager', 'advisor')),
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  password_hash VARCHAR(255) NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS targets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  revenue DECIMAL(12,2),
  car_count INTEGER,
  parts_margin DECIMAL(5,2) DEFAULT 55.00,
  labour_margin DECIMAL(5,2) DEFAULT 70.00,
  labour_hours DECIMAL(10,2),
  efficiency DECIMAL(5,2) DEFAULT 80.00,
  avg_ro_value DECIMAL(10,2),
  pph DECIMAL(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(location_id, year, month)
);

CREATE TABLE IF NOT EXISTS metrics_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  revenue_mtd DECIMAL(12,2),
  car_count_mtd INTEGER,
  parts_margin DECIMAL(5,2),
  labour_margin DECIMAL(5,2),
  avg_ro_value DECIMAL(10,2),
  labour_hours_sold DECIMAL(10,2),
  effective_labour_rate DECIMAL(10,2),
  efficiency_avg DECIMAL(5,2),
  pph DECIMAL(10,2),
  total_profit DECIMAL(12,2),
  alerts JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tech_efficiency (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  tech_id VARCHAR(255),
  tech_name VARCHAR(255) NOT NULL,
  hours_available DECIMAL(10,2),
  hours_worked DECIMAL(10,2),
  hours_sold DECIMAL(10,2),
  efficiency DECIMAL(5,2),
  labour_revenue DECIMAL(12,2),
  parts_gp DECIMAL(12,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Comebacks / $0 invoices: warranty re-dos, goodwill work, internal tickets.
-- These are invoiced but carry no charge, so they're excluded from revenue
-- metrics. Tracked separately because they represent (a) a quality signal
-- (comeback rate) and (b) cost leakage (unbilled labour hours x wage).
CREATE TABLE IF NOT EXISTS comebacks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  order_number VARCHAR(100),
  order_id VARCHAR(255),
  invoiced_date TIMESTAMPTZ,
  customer_name VARCHAR(255),
  vehicle_name VARCHAR(255),
  tech_id VARCHAR(255),
  tech_name VARCHAR(255),
  labour_hours DECIMAL(10,2) DEFAULT 0,
  unbilled_wage_cost DECIMAL(12,2) DEFAULT 0,
  complaint TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comebacks_location_date ON comebacks(location_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_tech_efficiency_location_date ON tech_efficiency(location_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_cache_location_date ON metrics_cache(location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_targets_location_year ON targets(location_id, year);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Committed WIP cache: authorized orders not yet invoiced (potential revenue on the floor).
-- Stored as a JSONB snapshot like the metrics cache; refreshed on the same schedule.
CREATE TABLE IF NOT EXISTS committed_wip_cache (
    location_id UUID PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

-- Marketing: call-tracking ingestion (monthly Marchex/Telmetrics PDF -> Claude -> here).
-- One row per (channel, tracking number) per period; channel totals are summed in queries.
-- Idempotent on the UNIQUE key so re-ingesting a month overwrites cleanly. qualified_calls is
-- a count the extractor derives from the Call Detail pages (null if the PDF has none) — we store
-- the count, not the individual rows, so output stays small regardless of call volume.
CREATE TABLE IF NOT EXISTS call_summary (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
  location_name VARCHAR(255),
  provider VARCHAR(50) NOT NULL DEFAULT 'marchex',
  format VARCHAR(50) NOT NULL DEFAULT 'telmetrics',
  period_start DATE NOT NULL,
  period_end DATE,
  channel VARCHAR(30) NOT NULL,
  tracking_number VARCHAR(40) NOT NULL,
  total_calls INTEGER DEFAULT 0,
  answered_calls INTEGER DEFAULT 0,
  missed_calls INTEGER DEFAULT 0,
  unique_callers INTEGER DEFAULT 0,
  avg_duration_seconds INTEGER DEFAULT 0,
  qualified_calls INTEGER,
  ingested_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (location_id, provider, period_start, channel, tracking_number)
);

CREATE INDEX IF NOT EXISTS idx_call_summary_loc_period ON call_summary(location_id, period_start DESC);

-- Marketing: capture -> AI caption -> approval queue. A bay photo (+ note) with
-- Claude-written platform captions; owner approves/edits/skips. Posting to FB/IG/GBP
-- is deferred (Meta/GBP access), so 'approved' currently means ready-to-post. Images
-- are stored in-DB for v1 (migrate to R2 when posting lands); un-actioned drafts are
-- purged after MARKETING_PURGE_DAYS (default 60).
CREATE TABLE IF NOT EXISTS marketing_post (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
  location_name VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'draft',   -- draft | approved | skipped
  note TEXT,
  image_data BYTEA,
  image_mime VARCHAR(60),
  caption_ig TEXT, caption_fb TEXT, caption_gbp TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  actioned_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_marketing_post_loc_status ON marketing_post(location_id, status, created_at DESC);

-- Marketing: "This week's shots" cache — AI shoot list derived from open Shopmonkey ROs.
CREATE TABLE IF NOT EXISTS marketing_shots_cache (
  location_id UUID PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Marketing: live Google review scorecard (read-only). Current rating/count/recent reviews
-- cached from Google Places; a monthly {total,rating} snapshot drives the "+N this month" delta.
CREATE TABLE IF NOT EXISTS marketing_reviews_cache (
  location_id UUID PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketing_reviews_snapshot (
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  total INTEGER,
  rating DECIMAL(2,1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, year, month)
);
