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
  slack_channel VARCHAR(100),
  num_technicians INTEGER DEFAULT 5,
  labour_rate DECIMAL(10,2) DEFAULT 170.00,
  stale_threshold_days INTEGER DEFAULT 5,
  parts_margin_target DECIMAL(5,2) DEFAULT 55.00,
  efficiency_target DECIMAL(5,2) DEFAULT 80.00,
  pph_target DECIMAL(10,2) DEFAULT 254.00,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'partner', 'manager')),
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
