import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const EMPTY = { name: '', address: '', city: '', province: 'BC', shopmonkey_location_id: '', qbo_company_id: '', slack_channel: '', num_technicians: 5, labour_rate: 170, stale_threshold_days: 5, parts_margin_target: 55, efficiency_target: 80, pph_target: 254, active: true };

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
            <div className="form-row">{field('address','Address')} {field('province','Province')}</div>
          </div>
          <div className="form-section">
            <div className="form-section-title">Integrations</div>
            <div className="form-row">{field('shopmonkey_location_id','Shopmonkey location ID')} {field('qbo_company_id','QBO company ID')}</div>
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
        <div className="page-title-text">Locations</div>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px' }}>
            {[
              ['Shopmonkey ID', loc.shopmonkey_location_id || 'Not set'],
              ['QBO Company', loc.qbo_company_id || 'Connect after closing'],
              ['Slack channel', loc.slack_channel || 'Not set'],
              ['Technicians (live)', loc.num_technicians],
              ['Labour rate', `$${loc.labour_rate}/hr`],
              ['Stale threshold', `${loc.stale_threshold_days} days`],
              ['Parts margin target', `${loc.parts_margin_target}%`],
              ['Efficiency target', `${loc.efficiency_target}%`],
              ['PPH target', `$${loc.pph_target}/hr`],
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
