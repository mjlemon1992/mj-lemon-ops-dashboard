import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { showToast, askConfirm } from '../components/Feedback';

const EMPTY = { name: '', email: '', role: 'manager', location_id: '', password: '', active: true };

export default function Users() {
  const { user: me, api } = useAuth();
  const [users, setUsers] = useState([]);
  const [locations, setLocations] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([api('/users'), api('/locations')]).then(([u, l]) => { setUsers(u); setLocations(l); }).catch(() => {});
  }, []);

  const openNew = () => { setForm(EMPTY); setEditing('new'); setError(''); };
  const openEdit = u => { setForm({ ...u, password: '' }); setEditing(u.id); setError(''); };

  const save = async () => {
    setSaving(true); setError('');
    try {
      if (editing === 'new') {
        const u = await api('/users', { method: 'POST', body: JSON.stringify(form) });
        setUsers(prev => [...prev, u]);
      } else {
        const u = await api(`/users/${editing}`, { method: 'PUT', body: JSON.stringify(form) });
        setUsers(prev => prev.map(x => x.id === editing ? u : x));
      }
      setEditing(null);
    } catch (err) { setError(err.message); }
    setSaving(false);
  };

  const roleBadgeClass = r => r === 'owner' ? 'info' : r === 'partner' ? 'success' : 'neutral';

  // Hard delete (server blocks self-delete and the last active owner).
  const remove = async (u) => {
    if (!await askConfirm({ title: `Delete ${u.name}`, body: `${u.email} loses access immediately. This can't be undone.`, confirmLabel: 'Delete user', danger: true })) return;
    try {
      await api(`/users/${u.id}`, { method: 'DELETE' });
      setUsers(prev => prev.filter(x => x.id !== u.id));
      showToast(`${u.name} deleted`);
    } catch (err) { setError(err.message); showToast(err.message, 'error'); }
  };

  const initials = name => name ? name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() : '?';

  if (editing !== null) {
    return (
      <div>
        <div className="page-header">
          <div className="page-title-text">{editing === 'new' ? 'Invite user' : 'Edit user'}</div>
          <button onClick={() => setEditing(null)}>Cancel</button>
        </div>
        <div className="card">
          <div className="form-row">
            <div className="form-group"><label className="form-label">Full name</label><input value={form.name} onChange={e => setForm(f=>({...f,name:e.target.value}))} /></div>
            <div className="form-group"><label className="form-label">Email</label><input type="email" value={form.email} onChange={e => setForm(f=>({...f,email:e.target.value}))} /></div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Role</label>
              <select value={form.role} onChange={e => setForm(f=>({...f,role:e.target.value}))}>
                <option value="owner">Owner — full admin (locations, users, everything)</option>
                <option value="partner">Partner — all locations, no admin settings</option>
                <option value="manager">Shop operator — their location only: reports, finance, marketing, notices, targets</option>
                <option value="advisor">Service advisor — their location's re-order board only, no money pages</option>
              </select>
            </div>
            {['manager', 'advisor'].includes(form.role) && (
              <div className="form-group">
                <label className="form-label">Location</label>
                <select value={form.location_id} onChange={e => setForm(f=>({...f,location_id:e.target.value}))}>
                  <option value="">Select location</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            )}
          </div>
          {editing === 'new' && (
            <div className="form-group"><label className="form-label">Temporary password</label><input type="password" value={form.password} onChange={e => setForm(f=>({...f,password:e.target.value}))} placeholder="They can change this after first login" /></div>
          )}
          {editing !== 'new' && (
            <div className="form-group">
              <label className="form-label">Status</label>
              <select value={form.active ? 'active' : 'inactive'} onChange={e => setForm(f=>({...f,active:e.target.value==='active'}))}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          )}
          {error && <div style={{ fontSize: 'var(--fz-label)', color: 'var(--danger)', marginBottom: '12px' }}>{error}</div>}
          <div className="btn-row">
            <button onClick={() => setEditing(null)}>Cancel</button>
            <button className="primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : editing === 'new' ? 'Create user' : 'Save changes'}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <span />
        <button className="primary" onClick={openNew}>+ Invite user</button>
      </div>
      <div className="card">
        {users.length === 0 && (
          <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text3)' }}>No users yet</div>
        )}
        {users.map(u => {
          const loc = locations.find(l => l.id === u.location_id);
          return (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0', borderBottom: '0.5px solid var(--border)' }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'rgba(77,184,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--fz-label)', fontWeight: '500', color: 'var(--info)', flexShrink: 0 }}>{initials(u.name)}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 'var(--fz-body)', fontWeight: '500', color: u.active ? 'var(--text)' : 'var(--text3)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {u.name}
                  {!u.active && <span className="badge neutral">Inactive</span>}
                </div>
                <div style={{ fontSize: 'var(--fz-label)', color: 'var(--text3)' }}>{u.email}{loc ? ` · ${loc.name}` : ''}</div>
              </div>
              <span className={`badge ${roleBadgeClass(u.role)}`} style={{ textTransform: 'capitalize' }}>{u.role}</span>
              {u.id !== me?.id && <button onClick={() => openEdit(u)} style={{ fontSize: 'var(--fz-label)', padding: '4px 10px' }}>Edit</button>}
              {u.id !== me?.id && <button onClick={() => remove(u)} style={{ fontSize: 'var(--fz-label)', padding: '4px 10px', color: 'var(--danger)' }}>Delete</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
