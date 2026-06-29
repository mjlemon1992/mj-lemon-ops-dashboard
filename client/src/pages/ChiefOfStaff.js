import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// Automations: the dashboard's always-on jobs (run 24/7 on Railway even when the
// Claude app is closed) — e.g. a 10pm marketing digest. Create them in plain
// English; the standing preferences below tune what they produce. The full chief
// of staff (Atlas) lives in the Claude app — this page is just the scheduler.

const CAT_LABEL = { priority: 'priority', focus: 'focus', ignore: 'ignore', tone: 'tone', timing: 'timing', format: 'format', source: 'source' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function ChiefOfStaff() {
  const { api } = useAuth();
  const [learnings, setLearnings] = useState([]);
  const [autos, setAutos] = useState([]);
  const [cmd, setCmd] = useState('');
  const [cmdReply, setCmdReply] = useState('');
  const [cmdBusy, setCmdBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const loadLearnings = useCallback(() => { api('/cos/learnings').then(setLearnings).catch(() => setLearnings([])); }, [api]);
  const loadAutos = useCallback(() => { api('/cos/automations').then(setAutos).catch(() => setAutos([])); }, [api]);

  useEffect(() => { loadLearnings(); loadAutos(); }, [loadLearnings, loadAutos]);

  const vote = async (id, dir) => {
    setBusyId(id);
    try { await api(`/cos/learnings/${id}/vote`, { method: 'POST', body: JSON.stringify({ dir }) }); } catch (e) {}
    setBusyId(null); loadLearnings();
  };

  const sendCommand = async () => {
    const text = cmd.trim();
    if (!text) return;
    setCmdBusy(true); setCmdReply('');
    try {
      const r = await api('/cos/command', { method: 'POST', body: JSON.stringify({ text }) });
      setCmdReply(r.reply || 'Done.');
      setCmd('');
      loadAutos(); loadLearnings();
    } catch (e) { setCmdReply(`Couldn't do that: ${e.message}`); }
    setCmdBusy(false);
  };

  const toggleAuto = async (id) => {
    setBusyId(id);
    try { await api(`/cos/automations/${id}/toggle`, { method: 'POST' }); } catch (e) {}
    setBusyId(null); loadAutos();
  };

  const scheduleText = (a) => `${a.frequency === 'weekly' ? (a.weekday != null ? DOW[a.weekday] + 's' : 'weekly') : 'daily'} at ${a.time_local} MT`;

  return (
    <div style={{ maxWidth: 880 }}>
      <div style={{ fontSize: '11px', color: 'var(--text3)', marginBottom: '16px', lineHeight: 1.5 }}>
        Always-on jobs the dashboard runs for you — even when Claude is closed. The full chief of staff lives in your Claude app (Atlas); this page is just the scheduler.
      </div>

      {/* CREATE AN AUTOMATION */}
      <div className="card" style={{ marginBottom: '20px', borderLeft: '3px solid var(--accent)' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>Schedule an automation</div>
        <textarea
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendCommand(); }}
          placeholder={'e.g. "Send me a marketing digest at 10pm every day" · "Draft 2 marketing posts each week for approval"'}
          rows={2}
          style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px', fontSize: '13px', color: 'var(--text)', resize: 'vertical', fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' }}>
          <button onClick={sendCommand} disabled={!cmd.trim() || cmdBusy}
            style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius)', padding: '7px 14px', fontSize: '13px', fontWeight: 500, cursor: cmd.trim() ? 'pointer' : 'default', opacity: cmd.trim() ? 1 : 0.5 }}>
            {cmdBusy ? 'Setting up…' : 'Create'}
          </button>
          <span style={{ fontSize: '11px', color: 'var(--text3)' }}>⌘↵ to send · nothing posts or sends without your approval</span>
        </div>
        {cmdReply && <div style={{ fontSize: '13px', color: 'var(--success)', marginTop: '10px', background: 'var(--bg3)', borderRadius: 'var(--radius)', padding: '8px 10px' }}>{cmdReply}</div>}
      </div>

      {/* ACTIVE AUTOMATIONS */}
      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '10px' }}>Active automations</div>
      {autos.length === 0 ? (
        <div className="card" style={{ fontSize: '13px', color: 'var(--text2)', marginBottom: '24px' }}>
          None yet — schedule one above.
        </div>
      ) : (
        <div style={{ marginBottom: '24px' }}>
          {autos.map(a => (
            <div key={a.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px', opacity: a.enabled ? 1 : 0.5 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '13px', color: 'var(--text)' }}>{a.title}</div>
                <div style={{ fontSize: '10px', color: 'var(--text3)', marginTop: '3px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {a.action_type.replace(/_/g, ' ')} · {scheduleText(a)}{a.params && a.params.count ? ` · ${a.params.count}x` : ''}
                </div>
              </div>
              <button onClick={() => toggleAuto(a.id)} disabled={busyId === a.id}
                style={{ background: 'none', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '4px 10px', cursor: 'pointer', fontSize: '12px', color: a.enabled ? 'var(--success)' : 'var(--text3)' }}>
                {a.enabled ? 'On' : 'Off'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* PREFERENCES (the standing rules these jobs apply) */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>Preferences these jobs apply</div>
        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>👍 keep · 👎 drop</div>
      </div>
      {learnings.length === 0 ? (
        <div className="card" style={{ fontSize: '13px', color: 'var(--text2)' }}>
          No preferences yet. Add one above, e.g. “always lead the digest with parts margin”.
        </div>
      ) : (
        <div>
          {learnings.map(l => (
            <div key={l.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px', opacity: busyId === l.id ? 0.5 : 1 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '13px', color: 'var(--text)' }}>{l.insight}</div>
                <div style={{ fontSize: '10px', color: 'var(--text3)', marginTop: '3px', display: 'flex', gap: '8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  <span>{CAT_LABEL[l.category] || l.category}</span>
                  <span>conf {l.confidence}/10</span>
                  <span>{l.source}</span>
                </div>
              </div>
              <button onClick={() => vote(l.id, 'up')} disabled={busyId === l.id} title="Reinforce"
                style={{ background: 'none', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '4px 8px', cursor: 'pointer', fontSize: '13px' }}>👍</button>
              <button onClick={() => vote(l.id, 'down')} disabled={busyId === l.id} title="Drop this"
                style={{ background: 'none', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '4px 8px', cursor: 'pointer', fontSize: '13px' }}>👎</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
