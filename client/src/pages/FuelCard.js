import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocations } from '../context/LocationContext';

// Group Fuel Card tab (spec §4). One physical card per location; the ledger
// tracks each person's share. Bonus credits land automatically on Approve &
// Lock (Bonus tab). Extras are ledger rows (top-ups) — never edits to
// computed values. Variance = actual card balance − Σledger.

const money = (n) => '$' + Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function FuelCard() {
  const { isAll, selectedId, scopeLocations, select } = useLocations();
  // Per-location page: follow the global selector. "All" auto-selects the
  // first shop so there's never a dead-end picker page.
  useEffect(() => {
    if (isAll && (scopeLocations || []).length) select(scopeLocations[0].id);
  }, [isAll, scopeLocations, select]);
  if (isAll || !selectedId) return null;
  return <FuelView locId={selectedId} />;
}

function FuelView({ locId }) {
  const { api, token, user } = useAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [assigning, setAssigning] = useState(null);   // ledger row id with picker open

  const load = useCallback(() => {
    api(`/fuel/${locId}/summary`).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message));
  }, [api, locId]);
  useEffect(() => { load(); }, [load]);

  if (err && !data) return <div className="card" style={{ color: 'var(--danger)' }}>{err}</div>;
  if (!data) return <div style={{ color: 'var(--text3)', padding: '40px' }}>Loading…</div>;

  const { tiles, people, ledger } = data;
  const owner = user?.role === 'owner';
  // Managers run the shop floor: they log purchases/top-ups and assign them.
  // Reconciling against the card statement stays an owner job.
  const canLog = ['owner', 'partner', 'manager'].includes(user?.role);
  const activePeople = people.filter((p) => p.active);
  const reconciled = tiles.variance != null && Math.abs(tiles.variance) < 0.005;

  const logPurchase = async () => {
    const amount = Number(window.prompt('Purchase amount ($):'));
    if (!(amount > 0)) return;
    const names = activePeople.map((p, i) => `${i + 1}=${p.name}`).join('  ');
    const pick = window.prompt(`Who? (blank = unassigned)\n${names}`, '');
    const person = pick ? activePeople[Number(pick) - 1] : null;
    const memo = window.prompt('Station / memo (e.g. Petro-Canada, Gasoline Alley):', '') || '';
    try { await api(`/fuel/${locId}/ledger`, { method: 'POST', body: JSON.stringify({ type: 'purchase', amount, person_id: person ? person.id : null, memo }) }); load(); }
    catch (e) { setErr(e.message); }
  };

  const topUp = async () => {
    const names = activePeople.map((p, i) => `${i + 1}=${p.name}`).join('  ');
    const pick = window.prompt(`Top-up for whom?\n${names}`, '');
    const person = pick ? activePeople[Number(pick) - 1] : null;
    if (!person) return;
    const amount = Number(window.prompt(`Top-up amount for ${person.name} ($):`));
    if (!(amount > 0)) return;
    const memo = window.prompt('Reason / memo:', '') || '';
    try { await api(`/fuel/${locId}/ledger`, { method: 'POST', body: JSON.stringify({ type: 'topup', amount, person_id: person.id, memo }) }); load(); }
    catch (e) { setErr(e.message); }
  };

  const reconcile = async () => {
    const bal = window.prompt('Actual card balance from the provider portal/statement ($):');
    if (bal == null || bal === '') return;
    try { await api(`/fuel/${locId}/reconcile`, { method: 'POST', body: JSON.stringify({ actual_balance: Number(bal) }) }); load(); }
    catch (e) { setErr(e.message); }
  };

  const assign = async (rowId, personId) => {
    try { await api(`/fuel/ledger/${rowId}/assign`, { method: 'PUT', body: JSON.stringify({ person_id: personId }) }); setAssigning(null); load(); }
    catch (e) { setErr(e.message); }
  };

  const dl = async (fmt) => {
    try {
      const res = await fetch(`/api/fuel/${locId}/export?format=${fmt}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `fuel-card.${fmt}`;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '4px' }}>
        {tiles.variance == null
          ? <span className="badge neutral">no reconciliation yet</span>
          : reconciled
            ? <span className="badge success">✓ Reconciled</span>
            : <span className="badge warning">⚠ Variance {money(tiles.variance)}{tiles.unassigned_count ? ` — ${tiles.unassigned_count} purchase${tiles.unassigned_count > 1 ? 's' : ''} need assigning` : ''}</span>}
        {canLog && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={logPurchase}>＋ Log purchase</button>
            <button onClick={topUp}>＋ Top-up</button>
            {owner && <button className="primary" onClick={reconcile}>⇄ Reconcile card</button>}
          </div>
        )}
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text3)', marginBottom: '16px' }}>
        Bonuses land here automatically when a month is approved on the Bonus tab · one card, tracked per person
        {tiles.statement_date ? ` · last reconciled ${String(tiles.statement_date).slice(0, 10)}` : ''}
      </div>

      {err && <div className="alert-strip" style={{ marginBottom: '12px' }}><span style={{ color: 'var(--danger)' }}>{err}</span></div>}

      <div className="stat-grid" style={{ marginBottom: '18px' }}>
        <div className="metric-card">
          <div className="metric-label">Card balance (actual)</div>
          <div className="metric-value">{tiles.card_balance == null ? '—' : money(tiles.card_balance)}</div>
          <div className={`metric-sub ${reconciled ? 'good' : tiles.variance == null ? '' : 'warn'}`}>
            {tiles.variance == null ? 'reconcile to set' : reconciled ? 'matches the ledger ✓' : `${money(Math.abs(tiles.variance))} ${tiles.variance < 0 ? 'below' : 'above'} ledger${tiles.unassigned_count ? ` — ${tiles.unassigned_count} unassigned (${money(tiles.unassigned_total)})` : ''}`}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Bonus credited · YTD</div>
          <div className="metric-value">{money(tiles.credited_ytd)}</div>
          <div className="metric-sub">bonus payouts + top-ups</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Used · YTD</div>
          <div className="metric-value">{money(tiles.used_ytd)}</div>
          <div className="metric-sub">{tiles.credited_ytd > 0 ? `${Math.round((tiles.used_ytd / tiles.credited_ytd) * 100)}% of credited` : 'assigned purchases'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Remaining (owed)</div>
          <div className="metric-value">{money(tiles.remaining_owed)}</div>
          <div className="metric-sub">sum of everyone's unspent share</div>
        </div>
      </div>

      <div className="two-col">
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '13px 18px', borderBottom: '0.5px solid var(--border)' }}>
            <span style={{ fontWeight: 600 }}>Per-person balances</span>
            <span style={{ fontSize: '12px', color: 'var(--text3)', marginLeft: '10px' }}>credited − used = remaining</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead><tr style={{ color: 'var(--text3)', fontSize: '11px', textTransform: 'uppercase' }}>
                <th style={{ textAlign: 'left', padding: '9px 14px', borderBottom: '0.5px solid var(--border)' }}>Person</th>
                <th style={{ textAlign: 'left', padding: '9px 14px', borderBottom: '0.5px solid var(--border)' }}>Used of credited</th>
                <th style={{ textAlign: 'right', padding: '9px 14px', borderBottom: '0.5px solid var(--border)' }}>Credited</th>
                <th style={{ textAlign: 'right', padding: '9px 14px', borderBottom: '0.5px solid var(--border)' }}>Used</th>
                <th style={{ textAlign: 'right', padding: '9px 14px', borderBottom: '0.5px solid var(--border)' }}>Remaining</th>
              </tr></thead>
              <tbody>
                {people.map((p) => {
                  const pctUsed = p.credited > 0 ? Math.min(Math.round((p.used / p.credited) * 100), 100) : 0;
                  return (
                    <tr key={p.person_id} style={{ opacity: p.active ? 1 : 0.5 }}>
                      <td style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border)' }}>
                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>{p.role === 'advisor' ? 'Service Advisor' : 'Technician'}</div>
                      </td>
                      <td style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div style={{ position: 'relative', width: '110px', height: '10px', background: 'var(--bg3)', borderRadius: '4px' }}>
                            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pctUsed}%`, background: 'var(--accent)', borderRadius: '4px' }} />
                          </div>
                          <span style={{ fontSize: '11px', color: 'var(--text3)', width: '32px' }}>{pctUsed}%</span>
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(p.credited)}</td>
                      <td style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(p.used)}</td>
                      <td style={{ padding: '10px 14px', borderBottom: '0.5px solid var(--border)', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money(p.remaining)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr style={{ fontWeight: 700, background: 'var(--bg3)' }}>
                <td style={{ padding: '10px 14px' }}>Total</td><td />
                <td style={{ padding: '10px 14px', textAlign: 'right' }}>{money(tiles.credited_ytd)}</td>
                <td style={{ padding: '10px 14px', textAlign: 'right' }}>{money(tiles.used_ytd)}</td>
                <td style={{ padding: '10px 14px', textAlign: 'right' }}>{money(tiles.remaining_owed)}</td>
              </tr></tfoot>
            </table>
          </div>
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '13px 18px', borderBottom: '0.5px solid var(--border)' }}>
            <span style={{ fontWeight: 600 }}>Recent card activity</span>
          </div>
          <div style={{ maxHeight: '440px', overflowY: 'auto' }}>
            {ledger.length === 0 && <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>No activity yet — approve a bonus month or log a purchase.</div>}
            {ledger.map((l) => {
              const unassigned = !l.person_id && l.type === 'purchase';
              return (
                <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', borderBottom: '0.5px solid var(--border)', background: unassigned ? 'rgba(255,184,0,0.06)' : 'transparent' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>
                      {unassigned ? '⚠ Unassigned' : (l.person_name || (l.type === 'bonus_credit' ? 'Bonus' : '—'))}
                      <span style={{ fontWeight: 400, color: 'var(--text3)', marginLeft: '6px', fontSize: '11px' }}>{l.type.replace('_', ' ')}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {String(l.occurred_on).slice(0, 10)}{l.memo ? ` · ${l.memo}` : ''}
                    </div>
                  </div>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: Number(l.amount) < 0 ? 'var(--text)' : 'var(--success)' }}>
                    {Number(l.amount) < 0 ? '−' : '+'}{money(Math.abs(l.amount))}
                  </span>
                  {unassigned && canLog && (
                    assigning === l.id ? (
                      <select autoFocus onBlur={() => setAssigning(null)} onChange={(e) => e.target.value && assign(l.id, e.target.value)} defaultValue="">
                        <option value="">assign to…</option>
                        {activePeople.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    ) : (
                      <button onClick={() => setAssigning(l.id)} style={{ fontSize: '11px', padding: '4px 10px' }}>Assign ▾</button>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', marginTop: '14px', alignItems: 'center' }}>
        <button onClick={() => dl('xlsx')}>⬇ Export XLSX</button>
        <button onClick={() => dl('csv')}>⬇ Export CSV</button>
        <span style={{ fontSize: '11px', color: 'var(--text3)', marginLeft: 'auto' }}>
          Unassigned purchases hit the card balance but nobody's share — that's exactly what the variance surfaces.
        </span>
      </div>
    </div>
  );
}
