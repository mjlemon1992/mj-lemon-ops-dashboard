// Vendor-invoice ingestion for parts reconciliation (v1b). A scanned supplier
// invoice is AI-extracted, matched to its repair order (by the RO ref stamped
// on it — full number or last-4), and reconciled: what we paid the vendor vs
// what the RO captured. Read-only against ShopMonkey.
let _init;
function ensurePartsReconTables(pool) {
  if (_init) return _init;
  _init = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS vendor_invoice (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL,
      vendor TEXT,
      invoice_number TEXT,
      invoice_date DATE,
      total_cents INTEGER,
      subtotal_cents INTEGER,            -- pre-tax parts subtotal (fairer vs RO wholesale cost)
      ro_ref TEXT,                       -- as read off the invoice (full RO or last-4)
      matched_order_id TEXT,             -- ShopMonkey order id once matched/confirmed
      matched_order_number TEXT,
      match_status VARCHAR(12) NOT NULL DEFAULT 'pending',  -- pending|matched|ambiguous|unmatched|confirmed
      match_candidates JSONB DEFAULT '[]',
      ro_parts_cost_cents INTEGER,       -- Σ wholesale cost of parts on the matched RO (what we captured)
      recon_status VARCHAR(12),          -- ok|underlogged|variance|pending  (paid vs captured)
      recon_note TEXT,
      line_items JSONB DEFAULT '[]',
      source VARCHAR(16) DEFAULT 'upload',   -- upload|email|make
      raw_extract JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      decided_by VARCHAR(200),
      decided_at TIMESTAMPTZ
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vinv_loc_status ON vendor_invoice (location_id, match_status, created_at DESC)');
    // De-dupe re-sent scans: same vendor+number+total for a location = one row.
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_vinv_dedupe ON vendor_invoice (location_id, COALESCE(vendor,''), COALESCE(invoice_number,''), COALESCE(total_cents,0))");

    // v1c — month-end vendor STATEMENT reconciliation. A supplier's statement
    // lists every invoice they billed us; we match each line against the
    // vendor_invoice rows we captured and flag the ones we're MISSING (never
    // received/entered) — the invoices most likely to hide an unbilled part.
    await pool.query(`CREATE TABLE IF NOT EXISTS vendor_statement (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL,
      vendor TEXT,
      statement_date DATE,
      period_label TEXT,
      total_cents INTEGER,               -- statement grand total if shown
      line_count INTEGER,                -- invoices listed on the statement
      found_count INTEGER,               -- lines we have a captured invoice for
      missing_count INTEGER,             -- lines with NO captured invoice (chase list)
      mismatch_count INTEGER,            -- number matched but amount differs
      lines JSONB DEFAULT '[]',          -- [{invoice_number, invoice_date, amount_cents, status, matched_invoice_id, captured_cents}]
      raw_extract JSONB,
      source VARCHAR(16) DEFAULT 'upload',
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vstmt_loc ON vendor_statement (location_id, created_at DESC)');
    // Re-uploading the same statement refreshes it rather than duplicating.
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_vstmt_dedupe ON vendor_statement (location_id, COALESCE(vendor,''), COALESCE(statement_date, '1900-01-01'), COALESCE(total_cents,0))");
  })();
  return _init;
}
module.exports = { ensurePartsReconTables };
