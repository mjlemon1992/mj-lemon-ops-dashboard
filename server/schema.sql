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

CREATE INDEX IF NOT EXISTS idx_metrics_cache_location_date ON metrics_cache(location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_targets_location_year ON targets(location_id, year);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
