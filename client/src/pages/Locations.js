import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const EMPTY = { name: '', address: '', city: '', province: 'BC', shopmonkey_location_id: '', qbo_slug: '', slack_channel: '', num_technicians: 5, labour_rate: 170, stale_threshold_days: 5, parts_margin_target: 55, efficiency_target: 80, pph_target: 254, display_pin: '', weekly_hours: 40, display_show_leaderboard: true, open_days: 'mon,tue,wed,thu,fri', active: true, fb_page_id: '', ig_user_id: '', gbp_location_name: '', night_start: 21, night_end: 6 };

export default function Locations() {
  const { api } = useAuth();
  const [locations, setLocations] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api('/locations').then(setLocations).catch(() => {}); }, []);

  const openNew = () => { setForm(EMPTY); setEditing('new'); setError(''); };
  const openEdit = loc => { setForm({ ...loc }); setEditing(loc.id); setError(''); };

  const save = async () => {
    setSaving(true); setError('');
    try {
      if (editing === 'new') {
        const loc = await api('/locations', { method: 'POST', body: JSON.stringify(form) });
        setLocations(prev => [...prev, loc]);
      } else {
        const loc = await api(`/locations/${editing}`, { method: 'PUT', body: JSON.stringify(form) });
        setLocations(prev => prev.map(l => l.id === editing ? loc : l));
      }
      setEditing(null);
    } catch (err) { setError(err.message); }
    setSaving(false);
  };

  const field = (key, label, type = 'text', extra = {}) => (
    <div className="form-group" key={key}>
      <label className="form-label">{label}</label>
      <input type={type} value={form[key] ?? ''} onChange={e => setForm(f => ({ ...f, [key]: type === 'number' ? parseFloat(e.target.value) : e.target.value }))} {...extra} />
    </div>
  );

  if (editing !== null) {
    return (
      <div>
        <div className="page-header">
          <div className="page-title-text">{editing === 'new' ? 'Add location' : 'Edit location'}</div>
          <button onClick={() => setEditing(null)}>Cancel</button>
        </div>
        <div className="card">
          <div className="form-section">
            <div className="form-section-title">Basic info</div>
            <div className="form-row">{field('name','Location name')} {field('city','City')}</div>
            <div className="form-row">
              {field('address','Address')}
              <div className="form-group">
                <label className="form-label">Province</label>
                {/* Dropdown, not free text — the stat-holiday calendar, time-off
                    day counting, and payroll all key off this exact code. */}
                <select value={String(form.province || 'AB').toUpperCase()} onChange={e => setForm(f => ({ ...f, province: e.target.value }))}>
                  {[['AB','Alberta'],['BC','British Columbia'],['SK','Saskatchewan'],['MB','Manitoba'],['ON','Ontario'],['QC','Québec'],['NB','New Brunswick'],['NS','Nova Scotia'],['PE','Prince Edward Island'],['NL','Newfoundland and Labrador'],['YT','Yukon'],['NT','Northwest Territories'],['NU','Nunavut']].map(([c, n]) => (
                    <option key={c} value={c}>{n} ({c})</option>
                  ))}
                </select>
                <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '4px' }}>Sets which stat-holiday calendar applies to this shop.</div>
              </div>
            </div>
          </div>
          <div className="form-section">
            <div className="form-section-title">Integrations</div>
            <div className="form-row">{field('shopmonkey_location_id','Shopmonkey location ID')} {field('qbo_slug','QBO connector slug (e.g. red-deer)')}</div>
            {field('slack_channel','Slack channel (e.g. #kelowna-alerts)')}
          </div>
          <div className="form-section">
            <div className="form-section-title">Configuration</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Technicians (auto-derived)</label>
                <input type="text" value={`${form.num_technicians ?? '—'} · synced from Shopmonkey`} disabled readOnly />
                <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '4px' }}>Pulled live from the Shopmonkey roster (see the Technicians page) — no longer set by hand.</div>
              </div>
              {field('labour_rate','Labour rate ($/hr)','number',{min:1})}
            </div>
            <div className="form-row">{field('stale_threshold_days','Stale vehicle threshold (days)','number',{min:1})} {field('pph_target','PPH target ($/hr)','number',{min:1})}</div>
            <div className="form-row">{field('parts_margin_target','Parts margin target (%)','number',{min:0,max:100})} {field('efficiency_target','Efficiency target (%)','number',{min:0,max:100})}</div>
            <div className="form-group" style={{ marginTop: '10px' }}>
              <label className="form-label">Days open</label>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                {[['mon','Mon'],['tue','Tue'],['wed','Wed'],['thu','Thu'],['fri','Fri'],['sat','Sat'],['sun','Sun']].map(([k, lab]) => {
                  const set = new Set(String(form.open_days || 'mon,tue,wed,thu,fri').split(',').map(s => s.trim()).filter(Boolean));
                  const on = set.has(k);
                  return (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={on} onChange={() => {
                        const next = new Set(set);
                        if (on) next.delete(k); else next.add(k);
                        if (!next.size) return;   // a shop open zero days breaks day counting
                        setForm(f => ({ ...f, open_days: ['mon','tue','wed','thu','fri','sat','sun'].filter(d => next.has(d)).join(',') }));
                      }} />{lab}
                    </label>
                  );
                })}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '4px' }}>
                Holiday "days used" and the bonus schedule only count these days — closed days and stat holidays never cost anyone a day off.
              </div>
            </div>
          </div>
          <div className="form-section">
            <div className="form-section-title">Shop-floor display</div>
            <div className="form-row">
              {field('display_pin','Display PIN (techs enter this on the TV)','text',{maxLength:12})}
              {field('weekly_hours','On-clock hours / tech per week','number',{min:1,max:80})}
              {field('fb_page_id','Facebook Page ID (social publishing)','text',{placeholder:'e.g. 1234567890'})}
              {field('ig_user_id','Instagram Business account ID','text',{placeholder:'e.g. 178414...'})}
              {field('gbp_location_name','Google Business Profile location (accounts/…/locations/…)','text',{placeholder:'accounts/123/locations/456'})}
            </div>
            <div className="form-group" style={{ marginTop: '10px' }}>
              <label className="form-label">Other locations' revenue on this board</label>
              <select value={form.display_show_leaderboard === false ? 'hide' : 'show'}
                onChange={e => setForm(f => ({ ...f, display_show_leaderboard: e.target.value === 'show' }))}>
                <option value="show">Show — group standings (all locations' revenue)</option>
                <option value="hide">Hide — this shop's numbers only</option>
              </select>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '4px' }}>
                Hide keeps other locations' figures off this TV entirely — they never leave the server.
              </div>
            </div>
            <div className="form-group" style={{ marginTop: '10px' }}>
              <label className="form-label">Night screen (board rests instead of showing numbers)</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {['night_start', 'night_end'].map((k, i) => (
                  <React.Fragment key={k}>
                    {i === 1 && <span style={{ color: 'var(--text3)', fontSize: '12px' }}>until</span>}
                    <select value={form[k] ?? (k === 'night_start' ? 21 : 6)}
                      onChange={e => setForm(f => ({ ...f, [k]: Number(e.target.value) }))}>
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>
                          {h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`}
                        </option>
                      ))}
                    </select>
                  </React.Fragment>
                ))}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '4px' }}>
                On the TV's own clock. Set both to the same hour to turn the night screen off entirely.
              </div>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>
              Efficiency = hours sold ÷ available hours (weekly hours minus this province's stat holidays).
            </div>
            {editing !== 'new' && (
              <div style={{ fontSize: '12px', color: 'var(--text2)', marginTop: '10px' }}>
                Display URL: <span style={{ color: 'var(--accent)' }}>{window.location.origin}/display/{editing}</span>
                <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>Open this on the shop TV and enter the PIN. It auto-refreshes every 2 hours.</div>
              </div>
            )}
          </div>
          {error && <div style={{ fontSize: '12px', color: 'var(--danger)', marginBottom: '12px' }}>{error}</div>}
          <div className="btn-row">
            <button onClick={() => setEditing(null)}>Cancel</button>
            <button className="primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save location'}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <span />
        <button className="primary" onClick={openNew}>+ Add location</button>
      </div>

      {locations.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text3)' }}>
          No locations yet. Add your first location to get started.
        </div>
      )}

      {locations.map(loc => (
        <div key={loc.id} className="card" style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: '500', color: 'var(--text)' }}>{loc.name}</div>
              <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '2px' }}>{loc.city}, {loc.province} · {loc.active ? 'Active' : 'Inactive'}</div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => openEdit(loc)}>Edit</button>
            </div>
          </div>
          <div className="stat-grid">
            {[
              ['Shopmonkey ID', loc.shopmonkey_location_id || 'Not set'],
              ['QBO slug', loc.qbo_slug || 'Not set'],
              ['Slack channel', loc.slack_channel || 'Not set'],
              ['Technicians (live)', loc.num_technicians],
              ['Labour rate', `$${loc.labour_rate}/hr`],
              ['Stale threshold', `${loc.stale_threshold_days} days`],
              ['Parts margin target', `${loc.parts_margin_target}%`],
              ['Efficiency target', `${loc.efficiency_target}%`],
              ['PPH target', `$${loc.pph_target}/hr`],
              ['Display PIN', loc.display_pin ? 'Set ✓' : 'Not set'],
              ['Board standings', loc.display_show_leaderboard === false ? 'This shop only' : 'Group shown'],
              ['On-clock hrs/tech', `${loc.weekly_hours || 40}h/wk`],
              ['Days open', String(loc.open_days || 'mon,tue,wed,thu,fri').split(',').map(d => d.trim().slice(0, 1).toUpperCase() + d.trim().slice(1, 3)).join(' ')],
            ].map(([l, v]) => (
              <div key={l}>
                <div style={{ fontSize: '10px', color: 'var(--text3)', marginBottom: '2px' }}>{l}</div>
                <div style={{ fontSize: '12px', color: 'var(--text)' }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
