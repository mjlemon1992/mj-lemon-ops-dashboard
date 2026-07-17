import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';

// Profit-Share Bonus tab (spec: lemonops-bonus-fuelcard-spec-FULL.md §3).
// Owner/partner only; per-location. Month lifecycle: no run → draft → approved
// (locked) → superseded. All guardrails are server-side — this UI just renders
// the errors it gets back (missing inputs, net-profit sanity confirm, locks).

const money = (n) => '$' + Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-CA');
const pctTxt = (f) => (f == null ? '—' : Math.round(Number(f) * 100) + '%');
const monthLabel = (m) => m ? new Date(m + '-15T12:00:00Z').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' }) : '';

function EffBar({ eff, floor }) {
  if (eff == null) return <span style={{ color: 'var(--text3)', fontSize: '12px' }}>n/a — flat share</span>;
  const e = Math.min(Number(eff) * 100, 120), f = Math.min(Number(floor || 0.9) * 100, 120);
  const below = Number(eff) < Number(floor);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', width: '38px' }}>{Math.round(Number(eff) * 100)}%</span>
      <div style={{ position: 'relative', width: '110px', height: '10px', background: 'var(--bg3)', borderRadius: '4px' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(e / 1.2, 100)}%`, background: below ? 'var(--warning)' : 'var(--accent)', borderRadius: '4px' }} />
        <div style={{ position: 'absolute', top: '-3px', bottom: '-3px', width: '2px', background: 'var(--text2)', left: `${Math.min(f / 1.2, 100)}%` }} />
      </div>
      {below && <span className="badge warning" style={{ fontSize: '10px' }}>⚠ below floor</span>}
    </div>
  );
}

export default function Bonus() {
  const { isAll, selectedId, scopeLocations, select } = useLocations();
  if (isAll) {
    return (
      <div>
        <h1 style={{ marginBottom: '6px' }}>Profit-Share Bonus</h1>
        <div style={{ color: 'var(--text3)', marginBottom: '16px' }}>The bonus program is per-location — pick a shop:</div>
        {(scopeLocations || []).map((l) => (
          <button key={l.id} onClick={() => select(l.id)} style={{ display: 'block', marginBottom: '8px', padding: '10px 18px' }}>{l.name}</button>
        ))}
      </div>
    );
  }
  if (!selectedId) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Select a location.</div>;
  return <BonusView locId={selectedId} />;
}

function BonusView({ locId }) {
  const { api, token, user } = useAuth();
  const [data, setData] = useState(null);
  const [month, setMonth] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // calculate form state
  const [netProfit, setNetProfit] = useState('');
  const [needsConfirm, setNeedsConfirm] = useState(null);
  const [missing, setMissing] = useState(null);
  const [effEdits, setEffEdits] = useState({});
  const [targetEdit, setTargetEdit] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullNote, setPullNote] = useState(null);
  const [refreshed, setRefreshed] = useState(false);

  const load = useCallback((m) => {
    api(`/bonus/${locId}/overview${m ? `?month=${m}` : ''}`)
      .then((d) => { setData(d); setMonth(d.month); setErr(null); setNeedsConfirm(null); setMissing(null); })
      .catch((e) => setErr(e.message));
  }, [api, locId]);
  useEffect(() => { load(null); }, [load]);

  // ↻ Refresh: throw away every unsaved local edit (typed hours, net profit,
  // warnings) and re-pull the clean state from the server.
  const resetLocal = useCallback(() => {
    setEffEdits({}); setNetProfit(''); setNeedsConfirm(null); setMissing(null); setPullNote(null); setErr(null);
    load(month);
    setRefreshed(true);
    setTimeout(() => setRefreshed(false), 2000);
  }, [load, month]);

  if (err && !data) return <div className="card" style={{ color: 'var(--danger)' }}>{err}</div>;
  if (!data) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading…</div>;

  const { run, lines, formula, versions, people, efficiency, targets, pace, history, stretch_needed } = data;
  const locked = run && run.status === 'approved';
  const isOwner = user?.role === 'owner';
  // The shop operator can IMPORT hours (Shopmonkey pull + clocked entry) for
  // their location; only the owner enters net profit / calculates / approves.
  const canImport = ['owner', 'partner', 'manager'].includes(user?.role);
  const targetRow = (targets || []).find((t) => t.month === month);
  // Bonus participants only — clock-only crew never appear in the calc inputs.
  const techs = (people || []).filter((p) => p.active && p.role === 'tech' && p.in_bonus !== false);
  const overrides = (lines || []).filter((l) => Number(l.paid) !== Number(l.calculated));
  const totalCalc = (lines || []).reduce((s, l) => s + Number(l.calculated), 0);
  const totalPaid = (lines || []).reduce((s, l) => s + Number(l.paid), 0);

  // months selectable: any run month + the last 14 calendar months (excl. current)
  const monthOptions = (() => {
    const set = new Set((history || []).map((h) => h.month));
    const now = new Date();
    for (let i = 1; i <= 14; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 15);
      set.add(d.toISOString().slice(0, 7));
    }
    return [...set].sort().reverse();
  })();

  const doCalculate = async (extra = {}, supersedeRunId = null) => {
    setBusy(true); setErr(null);
    try {
      // Flush any on-screen hours (pulled or typed) to the server first, so the
      // calc sees them — otherwise a Pull-then-Calculate reports "missing".
      await persistEfficiency();
      const body = { month, net_profit: Number(netProfit), ...extra };
      const path = supersedeRunId ? `/bonus/run/${supersedeRunId}/supersede` : `/bonus/${locId}/calculate`;
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNetProfit(''); setNeedsConfirm(null); setMissing(null);
      load(month);
    } catch (e) {
      const msg = e.message || 'Failed';
      if (/looks like gross profit|Confirm to proceed/i.test(msg)) setNeedsConfirm(msg);
      else if (/Missing efficiency/i.test(msg)) { try { setMissing(JSON.parse('null')); } catch {} setMissing(msg); }
      else setErr(msg);
    }
    setBusy(false);
  };

  // Auto-fill BOTH sides: billed hours from Shopmonkey, and clocked hours from
  // the 40h/week-minus-holidays schedule formula (same as the Technicians page).
  // The operator overrides clocked for anyone part-time or on leave; when
  // Connecteam is wired in, clocked will come from real punch data instead.
  const pullBilled = async () => {
    setPulling(true); setErr(null); setPullNote(null);
    try {
      const d = await api(`/bonus/${locId}/billed-hours/${month}`);
      setEffEdits((s) => {
        const next = { ...s };
        for (const m of d.matched) next[m.person_id] = { ...next[m.person_id], billed_hours: m.billed_hours, clocked_hours: m.clocked_hours };
        return next;
      });
      const src = d.source && d.source.kind === 'snapshot'
        ? `the ${d.source.date} tech snapshot` : `${(d.source && d.source.orders_scanned) || '?'} orders`;
      const holidayAdj = (d.matched || []).some((m) => m.holiday_days_off > 0) ? ', minus approved time off' : '';
      const clockNote = d.used_clock
        ? ` · clocked hours from real time-clock punches where techs clocked in, else the monthly schedule${holidayAdj}`
        : (d.scheduled_hours ? ` · clocked set to the ${d.scheduled_hours}h monthly schedule (40h/wk less stat holidays${holidayAdj}) — adjust anyone part-time or on leave` : '');
      const note = `Filled ${d.matched.length} tech${d.matched.length === 1 ? '' : 's'} from ${src}` + clockNote +
        (d.unmatched.length ? ` · unmatched: ${d.unmatched.map((u) => `${u.tech_name} (${u.billed_hours}h)`).join(', ')}` : '');
      setPullNote(note);
    } catch (e) { setErr(e.message); }
    setPulling(false);
  };

  // Persist whatever hours are on screen (pulled or typed) to the server.
  // Returns the number of complete rows saved. No reload — callers decide.
  const persistEfficiency = async () => {
    const entries = techs
      .map((t) => ({ person_id: t.id, ...((efficiency || {})[t.id] || {}), ...(effEdits[t.id] || {}) }))
      .filter((e) => e.billed_hours != null && e.clocked_hours != null && e.billed_hours !== '' && e.clocked_hours !== '')
      .map((e) => ({ person_id: e.person_id, billed_hours: Number(e.billed_hours), clocked_hours: Number(e.clocked_hours) }));
    if (entries.length) await api(`/bonus/${locId}/efficiency/${month}`, { method: 'PUT', body: JSON.stringify({ entries }) });
    return entries.length;
  };

  const saveEfficiency = async () => {
    setBusy(true); setErr(null);
    try {
      const n = await persistEfficiency();
      if (!n) { setErr('Enter billed + clocked hours first'); setBusy(false); return; }
      setEffEdits({}); load(month);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const overrideLine = async (l) => {
    const v = window.prompt(`Paid amount for ${l.person_name} (calculated ${money(l.calculated)}):`, l.paid);
    if (v == null) return;
    const paid = Number(v);
    if (!(paid >= 0)) { setErr('Enter a valid amount'); return; }
    let reason = '';
    if (paid !== Number(l.calculated)) {
      reason = window.prompt('Override reason (required — goes in the payroll export):', l.override_reason || '') || '';
      if (!reason.trim()) { setErr('Override reason is required'); return; }
    }
    try { await api(`/bonus/run/${run.id}/line/${l.id}`, { method: 'PUT', body: JSON.stringify({ paid, override_reason: reason }) }); load(month); }
    catch (e) { setErr(e.message); }
  };

  const approve = async () => {
    const summary = lines.map((l) => `${l.person_name}: ${money(l.paid)}`).join('\n');
    if (!window.confirm(`Approve & lock ${monthLabel(month)}?\n\nTotal ${money(totalPaid)} posts to the fuel card:\n${summary}\n\nThis cannot be edited afterward (only superseded).`)) return;
    setBusy(true); setErr(null);
    try { await api(`/bonus/run/${run.id}/approve`, { method: 'POST' }); load(month); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const dl = async (fmt) => {
    try {
      const res = await fetch(`/api/bonus/run/${run.id}/export?format=${fmt}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bonus-${month}.${fmt}`;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { setErr(e.message); }
  };

  const setTarget = async () => {
    const t = Number(targetEdit);
    if (!(t > 0)) { setErr('Enter a target amount'); return; }
    try { await api(`/bonus/${locId}/target/${month}`, { method: 'PUT', body: JSON.stringify({ target: t }) }); setTargetEdit(''); load(month); }
    catch (e) { setErr(e.message); }
  };

  const fmtVersion = versions.find((v) => run && v.id === run.formula_version_id) || formula;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '4px' }}>
        <h1>Profit-Share Bonus — {monthLabel(month)}</h1>
        {run && (locked
          ? <span className="badge success">🔒 Approved{run.superseded_by ? ' · superseded' : ''}</span>
          : <span className="badge warning">⏳ Draft — awaiting approval</span>)}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <select value={month || ''} onChange={(e) => load(e.target.value)} style={{ width: 'auto' }}>
            {monthOptions.map((m) => {
              const h = (history || []).find((x) => x.month === m && !x.superseded_by);
              return <option key={m} value={m}>{monthLabel(m)}{h ? (h.status === 'approved' ? ' 🔒' : ' ⏳') : ''}</option>;
            })}
          </select>
          <button onClick={resetLocal} title="Discard unsaved edits and reload" style={refreshed ? { color: 'var(--success)' } : undefined}>{refreshed ? '✓ Refreshed' : '↻ Refresh'}</button>
          {user?.role === 'owner' && <button onClick={() => setShowSettings((s) => !s)}>⚙ Formula settings</button>}
          {run && !locked && user?.role === 'owner' && (
            <button onClick={async () => {
              if (!window.confirm(`Discard this ${monthLabel(month)} draft? The month goes back to the start — fix the hours, then calculate again. Nothing has been paid or posted.`)) return;
              try { await api(`/bonus/run/${run.id}`, { method: 'DELETE' }); resetLocal(); } catch (e) { setErr(e.message); }
            }} style={{ color: 'var(--danger)' }}>🗑 Discard draft</button>
          )}
          {run && !locked && user?.role === 'owner' && <button className="primary" onClick={approve} disabled={busy}>✓ Approve & Lock</button>}
          {locked && !run.superseded_by && user?.role === 'owner' && (
            <button onClick={() => { setNetProfit(String(run.net_profit)); if (window.confirm('Supersede this locked run? A corrected draft will be created; on approval the fuel ledger receives only the difference.')) doCalculate({ confirm_net: true }, run.id); }}>↺ Supersede</button>
          )}
        </div>
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text3)', marginBottom: '16px' }}>
        {run
          ? `Calculated ${new Date(run.calculated_at).toLocaleDateString('en-CA')} by ${run.calculated_by || '—'} · revenue ${run.revenue_source}${run.approved_at ? ` · approved ${new Date(run.approved_at).toLocaleDateString('en-CA')} by ${run.approved_by}` : ''} · formula v${fmtVersion?.version_no}${fmtVersion?.efficiency_enabled ? ` (efficiency, floor ${pctTxt(fmtVersion.group_floor)})` : ' (flat)'} · ${overrides.length} override${overrides.length === 1 ? '' : 's'}`
          : `No run for this month yet · formula v${formula?.version_no ?? '—'} in effect`}
      </div>

      {err && <div className="alert-strip" style={{ marginBottom: '12px' }}><span style={{ color: 'var(--danger)' }}>{err}</span></div>}

      {showSettings && <SettingsPanel api={api} locId={locId} formula={formula} versions={versions} people={people} onClose={() => setShowSettings(false)} onSaved={() => { setShowSettings(false); load(month); }} onCrewChanged={() => load(month)} />}

      {run ? (
        <>
          <div className="stat-grid" style={{ marginBottom: '18px' }}>
            <div className="metric-card">
              <div className="metric-label">Prior-month revenue · {run.revenue_source}</div>
              <div className="metric-value">{money0(run.revenue)}</div>
              <div className={`metric-sub ${run.tier !== 'none' ? 'good' : 'warn'}`}>
                {run.tier !== 'none' ? '✓ Target met' : '✗ Target missed'} — {Math.round((run.revenue / run.target) * 1000) / 10}% of {money0(run.target)}
              </div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Net profit · {locked ? 'locked' : 'confirm'}</div>
              <div className="metric-value">{money0(run.net_profit)}</div>
              <div className="metric-sub">{locked ? 'From month-end close' : 'Recalculate below to change'}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Bonus rate</div>
              <div className="metric-value">{run.tier === 'none' ? '—' : (Number(run.rate) * 100).toFixed(2) + '%'}</div>
              <div className="metric-sub">{run.tier === 'stretch' ? 'Stretch rate hit 🎉' : run.tier === 'base' ? `Stretch (${(Number(fmtVersion?.stretch_rate || 0.0075) * 100).toFixed(2)}%) needed ${money0(stretch_needed)}` : 'Target missed — no bonus this month'}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Total payout</div>
              <div className="metric-value">{money(totalPaid)}</div>
              <div className="metric-sub">{lines.length} people{locked ? ' · ↑ posted to fuel card' : ' · posts to fuel card on approval'}</div>
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: '16px' }}>
            <div style={{ padding: '13px 18px', borderBottom: '0.5px solid var(--border)', display: 'flex', gap: '12px', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>Distribution{fmtVersion?.efficiency_enabled ? ' — efficiency multiplier' : ' — flat shares'}</span>
              <span style={{ fontSize: '12px', color: 'var(--text3)' }}>Each tech against their own floor — never against each other. Billed ÷ clocked, comebacks counted against.</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead><tr style={{ color: 'var(--text3)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {['Person', 'Efficiency', 'Multiplier', 'Calculated', 'Paid', 'Reason'].map((h) => <th key={h} style={{ textAlign: h === 'Person' || h === 'Efficiency' || h === 'Reason' ? 'left' : 'right', padding: '10px 14px', borderBottom: '0.5px solid var(--border)' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td style={{ padding: '11px 14px', borderBottom: '0.5px solid var(--border)' }}>
                        <div style={{ fontWeight: 600 }}>{l.person_name}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{l.role_at_calc === 'advisor' ? 'Service Advisor' : 'Technician'}</div>
                      </td>
                      <td style={{ padding: '11px 14px', borderBottom: '0.5px solid var(--border)' }}><EffBar eff={l.efficiency} floor={l.floor_used} /></td>
                      <td style={{ padding: '11px 14px', borderBottom: '0.5px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{l.multiplier == null ? '—' : Number(l.multiplier).toFixed(2)}</td>
                      <td style={{ padding: '11px 14px', borderBottom: '0.5px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(l.calculated)}</td>
                      <td style={{ padding: '11px 14px', borderBottom: '0.5px solid var(--border)', textAlign: 'right' }}>
                        <span onClick={() => !locked && user?.role === 'owner' && overrideLine(l)}
                          style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, cursor: locked ? 'default' : 'pointer',
                            padding: '3px 8px', borderRadius: '6px',
                            border: locked ? 'none' : '1px dashed var(--border)',
                            background: Number(l.paid) !== Number(l.calculated) ? 'rgba(255,184,0,0.12)' : 'transparent' }}>
                          {money(l.paid)}{!locked && ' ✎'}
                        </span>
                      </td>
                      <td style={{ padding: '11px 14px', borderBottom: '0.5px solid var(--border)', fontSize: '12px', color: 'var(--text2)', fontStyle: l.override_reason ? 'italic' : 'normal' }}>{l.override_reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr style={{ fontWeight: 700, background: 'var(--bg3)' }}>
                  <td style={{ padding: '11px 14px' }}>Total</td><td /><td />
                  <td style={{ padding: '11px 14px', textAlign: 'right' }}>{money(totalCalc)}</td>
                  <td style={{ padding: '11px 14px', textAlign: 'right' }}>{money(totalPaid)}</td>
                  <td style={{ padding: '11px 14px', fontSize: '12px', fontWeight: 400, color: 'var(--text3)' }}>
                    {overrides.length ? `${overrides.length} override · variance ${totalPaid >= totalCalc ? '+' : ''}${money(totalPaid - totalCalc)}` : 'no overrides'}
                  </td>
                </tr></tfoot>
              </table>
            </div>
          </div>

          {!locked && user?.role === 'owner' && (
            <div className="card" style={{ marginBottom: '16px' }}>
              <div style={{ fontWeight: 600, marginBottom: '4px' }}>Fix inputs & recalculate</div>
              <div style={{ fontSize: '12px', color: 'var(--text3)', marginBottom: '10px' }}>
                Wrong hours or net profit? Correct them here, save, and recalculate — the draft rebuilds from scratch (overrides are discarded).
              </div>
              <EfficiencyEditor techs={techs} month={month} efficiency={efficiency} effEdits={effEdits} setEffEdits={setEffEdits} onSave={saveEfficiency} busy={busy}
                onPullBilled={pullBilled} pulling={pulling} pullNote={pullNote} />
              <CalcForm netProfit={netProfit} setNetProfit={setNetProfit} needsConfirm={needsConfirm} missing={missing}
                busy={busy} onSubmit={(extra) => doCalculate(extra)} buttonLabel="↺ Recalculate (discards overrides)" />
            </div>
          )}
        </>
      ) : (
        user?.role === 'owner' && (
          <div className="card" style={{ marginBottom: '16px' }}>
            <div style={{ fontWeight: 600, marginBottom: '4px' }}>Calculate {monthLabel(month)}</div>
            <div style={{ fontSize: '12px', color: 'var(--text3)', marginBottom: '12px' }}>
              {targetRow ? `Target ${money0(targetRow.target)} · revenue pulls automatically from Shopmonkey · you confirm net profit from month-end close.` : 'No sales target set for this month yet.'}
            </div>
            {!targetRow && (
              <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                <input type="number" placeholder="Sales target for the month" value={targetEdit} onChange={(e) => setTargetEdit(e.target.value)} style={{ width: '220px' }} />
                <button onClick={setTarget}>Set target</button>
              </div>
            )}
            {targetRow && (
              <>
                <EfficiencyEditor techs={techs} month={month} efficiency={efficiency} effEdits={effEdits} setEffEdits={setEffEdits} onSave={saveEfficiency} busy={busy}
                  onPullBilled={pullBilled} pulling={pulling} pullNote={pullNote} />
                <CalcForm netProfit={netProfit} setNetProfit={setNetProfit} needsConfirm={needsConfirm} missing={missing}
                  busy={busy} onSubmit={(extra) => doCalculate(extra)} buttonLabel={`Calculate ${monthLabel(month)}`} />
              </>
            )}
          </div>
        )
      )}

      {canImport && !isOwner && !locked && (
        <div className="card" style={{ marginBottom: '16px' }}>
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>Import hours for {monthLabel(month)}</div>
          <div style={{ fontSize: '12px', color: 'var(--text3)', marginBottom: '10px' }}>
            Pull the hours from Shopmonkey — billed hours plus the monthly schedule (40h/wk less stat holidays) as clocked. Adjust clocked for anyone part-time or on leave, then save. This readies the data for the owner to run the bonus — you're not setting anyone's pay here.
          </div>
          <EfficiencyEditor techs={techs} month={month} efficiency={efficiency} effEdits={effEdits} setEffEdits={setEffEdits} onSave={saveEfficiency} busy={busy}
            onPullBilled={pullBilled} pulling={pulling} pullNote={pullNote} />
        </div>
      )}

      {pace && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', marginBottom: '14px', background: 'var(--bg2)' }}>
          <span style={{ fontSize: '13px' }}>📈 <b>{monthLabel(pace.month)} pace:</b> {money0(pace.mtd)} MTD</span>
          <div style={{ position: 'relative', flex: 1, maxWidth: '360px', minWidth: '160px', height: '9px', background: 'var(--bg3)', borderRadius: '4px' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min((pace.mtd / (pace.target * 1.15)) * 100, 100)}%`, background: 'var(--accent)', borderRadius: '4px' }} />
            <div style={{ position: 'absolute', top: '-3px', bottom: '-3px', width: '2px', background: 'var(--text2)', left: `${Math.min((pace.target / (pace.target * 1.15)) * 100, 100)}%` }} />
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text2)' }}>
            projecting ≈{pace.projection ? money0(pace.projection) : '—'} vs {money0(pace.target)} target —{' '}
            <b style={{ color: pace.projection >= pace.target ? 'var(--success)' : 'var(--warning)' }}>
              {pace.projection >= pace.target ? 'bonus in reach' : 'behind pace'}
            </b>{pace.stretch_needed ? ` · stretch needs ${money0(pace.stretch_needed)}` : ''}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text3)' }}>pace, not promise</span>
        </div>
      )}

      {run && (
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => dl('xlsx')}>⬇ Export XLSX</button>
          <button onClick={() => dl('csv')}>⬇ Export CSV</button>
        </div>
      )}
    </div>
  );
}

function CalcForm({ netProfit, setNetProfit, needsConfirm, missing, busy, onSubmit, buttonLabel }) {
  const [treatMissing, setTreatMissing] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="number" step="0.01" placeholder="Net profit (from month-end close)" value={netProfit}
          onChange={(e) => setNetProfit(e.target.value)} style={{ width: '260px' }} />
        <button className="primary" disabled={busy || !netProfit}
          onClick={() => onSubmit({ confirm_net: !!needsConfirm, missing_as_full: treatMissing })}>
          {busy ? 'Calculating…' : needsConfirm ? '⚠ Confirm net profit & calculate' : buttonLabel}
        </button>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '6px' }}>
        Net profit is AFTER all expenses (June example: $67,188 on $199,129 ≈ 34%). Dashboard margin numbers are gross — don't use them here.
      </div>
      {needsConfirm && <div style={{ fontSize: '12px', color: 'var(--warning)', marginTop: '8px' }}>{needsConfirm}</div>}
      {missing && (
        <div style={{ fontSize: '12px', color: 'var(--warning)', marginTop: '8px' }}>
          {String(missing)} — fill the efficiency inputs above, or{' '}
          <label style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={treatMissing} onChange={(e) => setTreatMissing(e.target.checked)} /> treat missing as full share (×1.0)
          </label>
        </div>
      )}
    </div>
  );
}

function EfficiencyEditor({ techs, month, efficiency, effEdits, setEffEdits, onSave, busy, onPullBilled, pulling, pullNote }) {
  const val = (t, k) => (effEdits[t.id] && effEdits[t.id][k] !== undefined) ? effEdits[t.id][k] : ((efficiency || {})[t.id] || {})[k] ?? '';
  const set = (t, k, v) => setEffEdits((s) => ({ ...s, [t.id]: { ...s[t.id], [k]: v } }));
  return (
    <div style={{ marginBottom: '14px', padding: '12px 14px', background: 'var(--bg3)', borderRadius: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600 }}>Efficiency inputs — {monthLabel(month)} <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(billed ÷ clocked; clocked = 40h/wk schedule until Connecteam is connected)</span></span>
        {onPullBilled && (
          <button type="button" onClick={onPullBilled} disabled={pulling} style={{ fontSize: '12px', padding: '5px 12px', marginLeft: 'auto' }}>
            {pulling ? 'Pulling… (~15s)' : '⚡ Pull hours from Shopmonkey'}
          </button>
        )}
      </div>
      {pullNote && <div style={{ fontSize: '11px', color: 'var(--success)', marginBottom: '8px' }}>{pullNote}.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '10px' }}>
        {techs.map((t) => (
          <div key={t.id} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span style={{ width: '76px', fontSize: '13px', fontWeight: 600 }}>{t.name}</span>
            <input type="number" step="0.1" placeholder="billed" value={val(t, 'billed_hours')} onChange={(e) => set(t, 'billed_hours', e.target.value)} style={{ width: '80px' }} />
            <span style={{ color: 'var(--text3)' }}>/</span>
            <input type="number" step="0.1" placeholder="clocked" value={val(t, 'clocked_hours')} onChange={(e) => set(t, 'clocked_hours', e.target.value)} style={{ width: '80px' }} />
          </div>
        ))}
      </div>
      <button onClick={onSave} disabled={busy} style={{ marginTop: '10px', fontSize: '12px', padding: '6px 14px' }}>Save hours</button>
    </div>
  );
}

function SettingsPanel({ api, locId, formula, versions, people, onClose, onSaved, onCrewChanged }) {
  const f = formula || {};
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('tech');
  const [crewBusy, setCrewBusy] = useState(false);
  const [form, setForm] = useState({
    base_rate: (Number(f.base_rate || 0.005) * 100).toFixed(2),
    stretch_rate: (Number(f.stretch_rate || 0.0075) * 100).toFixed(2),
    stretch_threshold: (Number(f.stretch_threshold || 1.1) * 100).toFixed(0),
    efficiency_enabled: f.efficiency_enabled !== false,
    group_floor: (Number(f.group_floor || 0.9) * 100).toFixed(0),
    multiplier_hard_min: (Number(f.multiplier_hard_min || 0.5) * 100).toFixed(0),
    effective_from_month: '',
  });
  const [floors, setFloors] = useState({});
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((s) => ({ ...s, [k]: v }));
  const nextVersion = (versions || []).length ? Math.max(...versions.map((v) => v.version_no)) + 1 : 1;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (!/^\d{4}-\d{2}$/.test(form.effective_from_month)) throw new Error('Pick the effective-from month (YYYY-MM)');
      await api(`/bonus/${locId}/formula`, { method: 'POST', body: JSON.stringify({
        base_rate: Number(form.base_rate) / 100,
        stretch_rate: Number(form.stretch_rate) / 100,
        stretch_threshold: Number(form.stretch_threshold) / 100,
        efficiency_enabled: !!form.efficiency_enabled,
        group_floor: Number(form.group_floor) / 100,
        multiplier_hard_min: Number(form.multiplier_hard_min) / 100,
        effective_from_month: form.effective_from_month,
      }) });
      for (const [pid, v] of Object.entries(floors)) {
        await api(`/bonus/people/${pid}`, { method: 'PUT', body: JSON.stringify({ efficiency_floor: v === '' ? null : Number(v) / 100 }) });
      }
      onSaved();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // Crew changes save immediately (they're roster facts, not formula terms) —
  // they don't create a formula version and past months are never affected.
  const addPerson = async () => {
    if (!newName.trim()) { setErr('Enter a name first'); return; }
    setCrewBusy(true); setErr(null);
    try {
      await api(`/bonus/${locId}/people`, { method: 'POST', body: JSON.stringify({ name: newName.trim(), role: newRole }) });
      setNewName('');
      onCrewChanged();
    } catch (e) { setErr(e.message); }
    setCrewBusy(false);
  };
  const setPersonActive = async (p, active) => {
    if (!active && !window.confirm(`Remove ${p.name} entirely (time clock too)? Locked months keep their history.`)) return;
    setCrewBusy(true); setErr(null);
    try { await api(`/bonus/people/${p.id}`, { method: 'PUT', body: JSON.stringify({ active }) }); onCrewChanged(); }
    catch (e) { setErr(e.message); }
    setCrewBusy(false);
  };
  // Clock-only ↔ bonus participant (probation ends, owner-tech opts out, …).
  const setPersonBonus = async (p, inBonus) => {
    setCrewBusy(true); setErr(null);
    try { await api(`/bonus/people/${p.id}`, { method: 'PUT', body: JSON.stringify({ in_bonus: inBonus }) }); onCrewChanged(); }
    catch (e) { setErr(e.message); }
    setCrewBusy(false);
  };

  return (
    <div className="card" style={{ marginBottom: '16px', border: '1px solid var(--accent)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
        <span style={{ fontWeight: 700 }}>⚙ Formula settings → will save as v{nextVersion}</span>
        <button onClick={onClose} style={{ border: 0, background: 'none', color: 'var(--text3)' }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '12px' }}>
        {[['base_rate', 'Base rate (%)'], ['stretch_rate', 'Stretch rate (%)'], ['stretch_threshold', 'Stretch threshold (% of target)'], ['group_floor', 'Group floor (%)'], ['multiplier_hard_min', 'Multiplier hard minimum (%)']].map(([k, label]) => (
          <div key={k}>
            <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>{label}</div>
            <input type="number" step="0.05" value={form[k]} onChange={(e) => set(k, e.target.value)} />
          </div>
        ))}
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>Efficiency multiplier</div>
          <select value={form.efficiency_enabled ? 'on' : 'off'} onChange={(e) => set('efficiency_enabled', e.target.value === 'on')}>
            <option value="on">On</option><option value="off">Off — flat shares</option>
          </select>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '4px' }}>Effective from month</div>
          <input type="month" value={form.effective_from_month} onChange={(e) => set('effective_from_month', e.target.value)} />
        </div>
      </div>
      <div style={{ fontSize: '12px', fontWeight: 600, margin: '6px 0' }}>Per-person floors <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(blank = group default; advisor exempt)</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px', marginBottom: '12px' }}>
        {(people || []).filter((p) => p.active && p.in_bonus !== false).map((p) => p.role === 'advisor'
          ? <div key={p.id} style={{ fontSize: '12px', color: 'var(--text3)', alignSelf: 'center' }}>{p.name}: exempt — flat share</div>
          : (
            <div key={p.id} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <span style={{ width: '76px', fontSize: '13px' }}>{p.name}</span>
              <input type="number" placeholder={`default`}
                value={floors[p.id] !== undefined ? floors[p.id] : (p.efficiency_floor != null ? (Number(p.efficiency_floor) * 100).toFixed(0) : '')}
                onChange={(e) => setFloors((s) => ({ ...s, [p.id]: e.target.value }))} style={{ width: '80px' }} />
              <span style={{ fontSize: '11px', color: 'var(--text3)' }}>%</span>
            </div>
          ))}
      </div>
      <div style={{ fontSize: '12px', fontWeight: 600, margin: '14px 0 6px' }}>Crew <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(saves instantly — bonus counts them from the next calculation onward)</span></div>
      <div style={{ marginBottom: '8px' }}>
        {(people || []).map((p) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0', opacity: p.active ? 1 : 0.55 }}>
            <span style={{ minWidth: '110px', fontSize: '13px' }}>{p.name}</span>
            <span className="badge" style={{ fontSize: '10px' }}>{p.role}</span>
            {p.active && p.in_bonus === false && <span style={{ fontSize: '11px', color: 'var(--warning)' }}>clock only — not in bonus</span>}
            {!p.active && <span style={{ fontSize: '11px', color: 'var(--text3)' }}>removed</span>}
            {p.active && (
              <button onClick={() => setPersonBonus(p, p.in_bonus === false)} disabled={crewBusy}
                style={{ marginLeft: 'auto', fontSize: '11px', padding: '3px 10px' }}>
                {p.in_bonus === false ? 'Include in bonus' : 'Exclude from bonus (clock only)'}
              </button>
            )}
            <button onClick={() => setPersonActive(p, !p.active)} disabled={crewBusy}
              style={{ marginLeft: p.active ? 0 : 'auto', fontSize: '11px', padding: '3px 10px' }}>
              {p.active ? 'Remove' : 'Add back'}
            </button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
        <input placeholder="New person's name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ width: '180px' }} />
        <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
          <option value="tech">Tech — efficiency multiplier</option>
          <option value="advisor">Advisor — flat share</option>
        </select>
        <button onClick={addPerson} disabled={crewBusy}>{crewBusy ? '…' : '+ Add to program'}</button>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '10px' }}>
        Formula changes apply from the effective month onward. Drafted and locked months are never affected. Every change is a new logged version.
      </div>
      {err && <div style={{ fontSize: '12px', color: 'var(--danger)', marginBottom: '8px' }}>{err}</div>}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : `Save as v${nextVersion}`}</button>
      </div>
    </div>
  );
}
