import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import PerLocationPage from '../components/PerLocationPage';
import { money } from '../utils/format';
import { Skeleton, askInput, askConfirm, showToast } from '../components/Feedback';

// Parts reconciliation. Two tabs:
//  • Margin / exposure — ShopMonkey parts billed vs cost (v1a)
//  • Vendor invoices — scanned supplier invoices matched to their RO + reconciled (v1b)
const REASON_LABEL = { warranty: 'Warranty', rebilled: 'Re-billed', vendor_query: 'Vendor query', ignore: 'Ignore' };
const CLASS = {
  leak: { label: 'LEAK', color: 'var(--danger)', bg: 'rgba(255,77,77,0.12)' },
  under_billed: { label: 'UNDER-BILLED', color: 'var(--warning)', bg: 'rgba(255,184,0,0.12)' },
  bundled: { label: 'BUNDLED', color: 'var(--text2)', bg: 'var(--bg3)' },
};
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '—';
const th = { padding: '8px 12px', fontWeight: 500 };
const td = { padding: '8px 12px' };

export default function PartsRecon() {
  return <PerLocationPage>{(locId) => <PartsTabs locId={locId} />}</PerLocationPage>;
}

function PartsTabs({ locId }) {
  const [view, setView] = useState('margin');
  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {[['margin', 'Margin / exposure'], ['invoices', 'Vendor invoices']].map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} className={view === k ? 'primary' : ''} style={{ fontSize: '13px', padding: '7px 16px' }}>{l}</button>
        ))}
      </div>
      {view === 'margin' ? <MarginView locId={locId} /> : <InvoicesView locId={locId} />}
    </div>
  );
}

// ── Margin / exposure (v1a) ──────────────────────────────────────────────
function MarginView({ locId }) {
  const { api } = useAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');

  const load = useCallback((fresh) => {
    setBusy(true);
    api(`/parts/${locId}/margin${fresh ? '?fresh=1' : ''}`)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [api, locId]);
  useEffect(() => { load(); }, [load]);

  const review = async (r) => {
    const pick = await askInput({ title: `Reviewed — ${r.part_name}`, body: 'Why is this OK / how was it handled?\n1 = Warranty\n2 = Re-billed\n3 = Vendor query\n4 = Ignore', label: 'Number (1–4)' });
    const reason = { 1: 'warranty', 2: 'rebilled', 3: 'vendor_query', 4: 'ignore' }[String(pick || '').trim()];
    if (!reason) return;
    try {
      await api(`/parts/${locId}/review`, { method: 'PUT', body: JSON.stringify({ order_id: r.order_id, part_id: r.part_id, part_number: r.part_number, part_name: r.part_name, reason }) });
      showToast(`Reviewed — ${REASON_LABEL[reason]}`);
      load();
    } catch (e) { showToast(e.message, 'error'); }
  };
  const undo = async (r) => {
    try { await api(`/parts/${locId}/review`, { method: 'PUT', body: JSON.stringify({ order_id: r.order_id, part_id: r.part_id, undo: true }) }); showToast('Back on the worklist'); load(); }
    catch (e) { showToast(e.message, 'error'); }
  };

  if (err && !data) return <div className="card" style={{ color: 'var(--danger)' }}>{err}</div>;
  if (!data) return <Skeleton rows={6} height={18} />;
  if (data.connected === false) return <div className="card" style={{ color: 'var(--text3)', textAlign: 'center', padding: '32px' }}>{data.message}</div>;

  const s = data.summary;
  const isReviewed = filter === 'reviewed';
  const items = isReviewed ? (data.reviewed || []) : (filter === 'all' ? data.items : data.items.filter((i) => i.class === filter));
  const Tile = ({ label, val, color }) => (
    <div className="metric-card"><div className="metric-label">{label}</div><div className="metric-value" style={color ? { color } : {}}>{val}</div></div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '12px', color: 'var(--text3)' }}>
          Parts paid vs billed · this month · {data.orders_scanned} invoiced order{data.orders_scanned === 1 ? '' : 's'} scanned
          {data.capped ? ` (capped ${data.orders_scanned}/${data.orders_total})` : ''}
          {data.service_fetch_failed ? ` · ${data.service_fetch_failed} skipped` : ''}
        </div>
        <button onClick={() => load(true)} disabled={busy} style={{ fontSize: '12px', padding: '6px 14px' }}>{busy ? 'Scanning…' : 'Refresh'}</button>
      </div>

      <div className="stat-grid" style={{ marginBottom: '16px' }}>
        <Tile label="Leak exposure" val={money(s.leak_exposure)} color={s.leak_exposure > 0 ? 'var(--danger)' : undefined} />
        <Tile label="Under-billed" val={money(s.underbilled_exposure)} color={s.underbilled_exposure > 0 ? 'var(--warning)' : undefined} />
        <Tile label="Leaks / under-billed" val={`${s.leak_count} / ${s.underbilled_count}`} />
        <Tile label="Parts checked" val={s.parts} />
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
        {[['all', `All flagged (${data.items.length})`], ['leak', `Leaks (${s.leak_count})`], ['under_billed', `Under-billed (${s.underbilled_count})`], ['bundled', `Bundled (${s.bundled_count})`], ['reviewed', `Reviewed (${data.reviewed_count || 0})`]].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} className={filter === k ? 'primary' : ''} style={{ fontSize: '12px', padding: '5px 12px' }}>{l}</button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="card" style={{ color: 'var(--text3)', textAlign: 'center', padding: '24px' }}>Nothing in this bucket this month. 🎉</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ background: 'var(--bg3)', color: 'var(--text3)', textAlign: 'left' }}>
                  <th style={th}>RO</th><th style={th}>Inv</th><th style={th}>Part</th><th style={th}>Service</th>
                  <th style={{ ...th, textAlign: 'right' }}>Qty</th><th style={{ ...th, textAlign: 'right' }}>Cost</th>
                  <th style={{ ...th, textAlign: 'right' }}>Billed</th><th style={{ ...th, textAlign: 'right' }}>Margin</th>
                  <th style={th}>Flag</th><th style={{ ...th, textAlign: 'right' }}>Exposure</th><th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => {
                  const c = CLASS[r.class] || CLASS.bundled;
                  return (
                    <tr key={i} style={{ borderTop: '0.5px solid var(--border)' }}>
                      <td style={td}>{r.order_number}</td>
                      <td style={{ ...td, color: 'var(--text3)' }}>{fmtDate(r.invoiced_date)}</td>
                      <td style={td}><div style={{ fontWeight: 600 }}>{r.part_name}</div>{r.part_number && <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{r.part_number}</div>}</td>
                      <td style={{ ...td, color: 'var(--text2)' }}>{r.service || '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{r.qty}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{money(r.cost)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{money(r.retail)}</td>
                      <td style={{ ...td, textAlign: 'right', color: r.margin_pct == null ? 'var(--text3)' : r.margin_pct < 0 ? 'var(--danger)' : 'var(--text2)' }}>{r.margin_pct == null ? '—' : `${r.margin_pct}%`}</td>
                      <td style={td}><span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '10px', color: c.color, background: c.bg, whiteSpace: 'nowrap' }}>{c.label}</span></td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: r.exposure > 0 ? c.color : 'var(--text3)' }}>{r.exposure > 0 ? money(r.exposure) : '—'}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {isReviewed ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '11px', color: 'var(--text3)' }}>{REASON_LABEL[r.reason] || r.reason}</span>
                            <button onClick={() => undo(r)} style={{ fontSize: '11px', padding: '3px 9px' }}>Undo</button>
                          </span>
                        ) : (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                            {r.sm_url && <a href={r.sm_url} target="_blank" rel="noreferrer" style={{ fontSize: '11px', color: 'var(--accent)', textDecoration: 'none' }}>Open ↗</a>}
                            <button onClick={() => review(r)} style={{ fontSize: '11px', padding: '3px 9px' }}>✓ Reviewed</button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '10px' }}>
        <b>Leak</b> = paid for, $0 billed, not on a flat-rate job. <b>Under-billed</b> = billed below cost. <b>Bundled</b> = $0 part inside a lump-sum/flat-rate service (normal — shown for review). {data.cached ? 'Cached' : 'Fresh'} as of {new Date(data.generated_at).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}.
      </div>
    </div>
  );
}

// ── Vendor invoices (v1b) ────────────────────────────────────────────────
const RECON = {
  underlogged: { t: 'POSSIBLE UNBILLED', c: 'var(--danger)' },
  variance: { t: 'VARIANCE', c: 'var(--warning)' },
  ok: { t: 'OK', c: 'var(--success)' },
  pending: { t: 'PENDING', c: 'var(--text3)' },
};
const MATCH_COLOR = { matched: 'var(--success)', confirmed: 'var(--success)', ambiguous: 'var(--warning)', unmatched: 'var(--danger)', pending: 'var(--text3)' };

function InvoicesView({ locId }) {
  const { api } = useAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api(`/parts/${locId}/invoices`).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message));
  }, [api, locId]);
  useEffect(() => { load(); }, [load]);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
      const out = await api(`/parts/${locId}/invoice-intake`, { method: 'POST', body: JSON.stringify({ file: b64, media_type: file.type || 'image/jpeg' }) });
      showToast(`Read: ${out.extracted?.vendor || '?'} · RO ${out.matched_order_number || out.extracted?.ro_ref || '—'} · ${out.recon_status}`);
      load();
    } catch (e) { showToast(e.message, 'error'); }
    setBusy(false);
  };
  const pickMatch = async (inv) => {
    // Re-scan first — refreshes candidates after a transient scan miss and
    // auto-matches when it's unambiguous.
    let cands = inv.match_candidates || [];
    try {
      const rm = await api(`/parts/invoice/${inv.id}/rematch`, { method: 'PUT', body: JSON.stringify({}) });
      cands = rm.candidates || [];
      if (rm.match_status === 'matched') { showToast(`Matched RO ${rm.matched_order_number} — ${rm.recon_status}`); load(); return; }
    } catch (e) { showToast(e.message, 'error'); return; }
    if (!cands.length) { showToast('No candidate ROs for that reference — check the number on the invoice', 'error'); load(); return; }
    const body = cands.map((c, i) => `${i + 1} = RO ${c.order_number} (${c.day_gap} days from the invoice)`).join('\n');
    const pick = await askInput({ title: `Which RO is this ${inv.vendor || 'invoice'}?`, body, label: 'Number' });
    const c = cands[Number(pick) - 1];
    if (!c) return;
    try { const out = await api(`/parts/invoice/${inv.id}/confirm-match`, { method: 'PUT', body: JSON.stringify({ order_id: c.order_id, order_number: c.order_number }) }); showToast(`Matched RO ${c.order_number} — ${out.recon_status}`); load(); }
    catch (e) { showToast(e.message, 'error'); }
  };
  const del = async (inv) => {
    if (!await askConfirm({ title: 'Remove invoice', body: `Remove ${inv.vendor || 'invoice'} ${inv.invoice_number || ''}?`, danger: true, confirmLabel: 'Remove' })) return;
    try { await api(`/parts/invoice/${inv.id}`, { method: 'DELETE' }); load(); } catch (e) { showToast(e.message, 'error'); }
  };
  const [scanning, setScanning] = useState(false);
  const scanNow = async () => {
    setScanning(true);
    try {
      const out = await api(`/parts/${locId}/scan-inbox`, { method: 'POST', body: JSON.stringify({}) });
      showToast(out.processed ? `Filed ${out.processed} scanned invoice${out.processed === 1 ? '' : 's'} from email` : 'No new scanned invoices in the inbox');
      load();
    } catch (e) { showToast(e.message, 'error'); }
    setScanning(false);
  };

  if (err && !data) return <div className="card" style={{ color: 'var(--danger)' }}>{err}</div>;
  if (!data) return <Skeleton rows={5} height={18} />;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ fontSize: '12px', color: 'var(--text3)', flex: '1 1 260px' }}>Supplier invoices matched to their RO by the number written on them. Photos flow in from the scan pipeline; you can also add one here.</div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button onClick={scanNow} disabled={scanning} title="Pull scanned invoices sent to the OPS inbox"
            style={{ fontSize: '12px', padding: '7px 14px', borderRadius: '8px' }}>
            {scanning ? 'Checking…' : '📥 Scan inbox'}
          </button>
          <label className="primary" style={{ fontSize: '12px', padding: '7px 14px', cursor: busy ? 'default' : 'pointer', borderRadius: '8px' }}>
            {busy ? 'Reading…' : '＋ Upload invoice'}
            <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }} disabled={busy} onChange={(e) => upload(e.target.files[0])} />
          </label>
        </div>
      </div>

      {(!data.invoices || !data.invoices.length) && (
        <div className="card" style={{ color: 'var(--text3)', textAlign: 'center', padding: '28px' }}>No invoices yet. Forward or upload a supplier invoice to start reconciling.</div>
      )}

      {(data.invoices || []).map((inv) => {
        const rs = RECON[inv.recon_status] || RECON.pending;
        return (
          <div key={inv.id} className="card" style={{ marginBottom: '8px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{inv.vendor || 'Unknown vendor'} {inv.invoice_number && <span style={{ fontSize: '11px', color: 'var(--text3)', fontWeight: 400 }}>#{inv.invoice_number}</span>}</div>
              <div style={{ fontSize: '12px', color: 'var(--text3)' }}>{inv.invoice_date || '—'} · paid {money(inv.subtotal != null ? inv.subtotal : inv.total)} · ref {inv.ro_ref || '—'}</div>
            </div>
            <div style={{ fontSize: '12px', minWidth: '120px' }}>
              {inv.matched_order_number
                ? <span style={{ color: MATCH_COLOR[inv.match_status] }}>RO {inv.matched_order_number}{inv.sm_url && <> · <a href={inv.sm_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Open ↗</a></>}</span>
                : <span style={{ color: MATCH_COLOR[inv.match_status] || 'var(--text3)' }}>{inv.match_status}</span>}
            </div>
            <div style={{ fontSize: '11px', fontWeight: 700, color: rs.c, minWidth: '130px', textAlign: 'right' }}>{rs.t}</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={() => pickMatch(inv)} style={{ fontSize: '11px', padding: '4px 10px' }}>{inv.matched_order_number ? 'Re-match' : 'Match RO'}</button>
              <button onClick={() => del(inv)} title="Remove" style={{ fontSize: '11px', padding: '4px 8px', color: 'var(--text3)' }}>✕</button>
            </div>
            {inv.recon_note && <div style={{ flexBasis: '100%', fontSize: '11px', color: 'var(--text3)' }}>{inv.recon_note}</div>}
          </div>
        );
      })}

      <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '10px' }}>
        <b>Possible unbilled</b> = you paid the vendor more than the parts cost captured on the matched RO — worth a look. <b>Variance</b> = RO cost exceeds this invoice (multiple invoices / matrix). Ambiguous matches: tap <b>Match RO</b> to confirm.
      </div>
    </div>
  );
}
