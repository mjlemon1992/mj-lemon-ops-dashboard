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
    // v1d — job-total roll-up + best-effort per-line cost findings.
    await pool.query('ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS job_paid_cents INTEGER');   // Σ all invoices matched to this RO
    await pool.query("ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS line_findings JSONB DEFAULT '[]'");
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vinv_order ON vendor_invoice (location_id, matched_order_id)');
    // Core charges are a deposit, not a part on the job — held separately so the
    // job roll-up can exclude them (they're tracked as their own claim).
    await pool.query('ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS core_cents INTEGER DEFAULT 0');
    // Scanned in the same stack but not a parts purchase (fuel, coffee, cleaning
    // supplies). Kept so a supplier statement still sees it as captured, but
    // parked out of the worklist.
    await pool.query('ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS not_parts BOOLEAN DEFAULT false');
    // Keep the original scan/PDF so the owner can eyeball it when confirming a match.
    await pool.query('ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS file_data BYTEA');
    await pool.query('ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS file_mime TEXT');
    // When the dashboard itself forwarded this document to Hubdoc (per split
    // document, replacing the blanket Gmail filter). NULL = not sent yet.
    await pool.query('ALTER TABLE vendor_invoice ADD COLUMN IF NOT EXISTS hubdoc_sent_at TIMESTAMPTZ');
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
    // Σ of the extracted lines — compared to the statement's printed total to
    // prove the read is trustworthy before anyone chases a "missing" list.
    await pool.query('ALTER TABLE vendor_statement ADD COLUMN IF NOT EXISTS lines_sum_cents INTEGER');
    await pool.query('ALTER TABLE vendor_statement ADD COLUMN IF NOT EXISTS hubdoc_sent_at TIMESTAMPTZ');

    // v1e — WARRANTY CREDIT WATCH. A warranty part is paid for now and should be
    // credited back on a later statement. Flagged by a WARRANTY stamp on the
    // scan, by "WARRANTY" in a forwarded email's subject, or marked by hand.
    // Stays open until a credit on a statement clears it.
    await pool.query(`CREATE TABLE IF NOT EXISTS warranty_claim (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      location_id UUID NOT NULL,
      invoice_id UUID,                    -- vendor_invoice it came from (null if hand-entered)
      vendor TEXT,
      invoice_number TEXT,
      invoice_date DATE,
      expected_cents INTEGER,             -- what we expect credited back
      lines JSONB DEFAULT '[]',           -- the specific invoice lines claimed (empty = whole invoice)
      status VARCHAR(12) NOT NULL DEFAULT 'awaiting',   -- awaiting|credited|closed
      source VARCHAR(12) DEFAULT 'manual',              -- stamp|subject|manual
      note TEXT,
      credited_cents INTEGER,
      credited_number TEXT,               -- the credit note number that cleared it
      credited_statement_id UUID,
      credited_at TIMESTAMPTZ,
      created_by VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_wclaim_loc ON warranty_claim (location_id, status, created_at DESC)');
    // Core charges ride the same lifecycle as warranty (paid now, credited back
    // when the old unit goes in) so they share this table, split by kind.
    await pool.query("ALTER TABLE warranty_claim ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'warranty'");
    await pool.query('ALTER TABLE warranty_claim ADD COLUMN IF NOT EXISTS part_number TEXT');
    // One invoice can carry BOTH a warranty claim and several distinct core
    // charges, so uniqueness is per invoice+kind+part+amount, not per invoice.
    await pool.query('DROP INDEX IF EXISTS idx_wclaim_invoice');
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wclaim_dedupe ON warranty_claim
      (invoice_id, kind, COALESCE(part_number,''), COALESCE(expected_cents,0)) WHERE invoice_id IS NOT NULL`);
    // Re-uploading the same statement refreshes it rather than duplicating.
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_vstmt_dedupe ON vendor_statement (location_id, COALESCE(vendor,''), COALESCE(statement_date, '1900-01-01'), COALESCE(total_cents,0))");
  })();
  return _init;
}
module.exports = { ensurePartsReconTables };
