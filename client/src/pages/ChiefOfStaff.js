import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import VoiceChat from '../components/VoiceChat';

// Chief of Staff tab: the brief the scheduled agent wrote, a command box where
// Jamie tells it what to do in plain English (Claude turns it into scheduled
// automations + preferences), the live automations list, and the self-learning
// panel (reinforce / retire). Command + steer = the feedback half of the loop.

const CAT_LABEL = { priority: 'priority', focus: 'focus', ignore: 'ignore', tone: 'tone', timing: 'timing', format: 'format', source: 'source' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Section({ icon, title, items }) {
  if (!items || !items.length) return null;
  return (
    <div className="card" style={{ marginBottom: '12px' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '10px' }}>
        <span style={{ marginRight: '6px' }}>{icon}</span>{title}
      </div>
      {items.map((it, i) => {
        const obj = typeof it === 'object' && it !== null;
        const head = obj ? (it.title || it.label || '') : String(it);
        const detail = obj ? (it.detail || it.note || '') : '';
        return (
          <div key={i} style={{ display: 'flex', gap: '10px', padding: '7px 0', borderBottom: i < items.length - 1 ? '0.5px solid var(--border)' : 'none' }}>
            <div style={{ color: 'var(--text3)', fontSize: '12px', lineHeight: '18px' }}>{obj && it.time ? it.time : '•'}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '13px', color: 'var(--text)', fontWeight: detail ? 500 : 400 }}>{head}</div>
              {detail && <div style={{ fontSize: '12px', color: 'var(--text2)', marginTop: '2px' }}>{detail}</div>}
              {obj && it.source && <span style={{ fontSize: '10px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{it.source}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ChiefOfStaff() {
  const { api, user } = useAuth();
  const [brief, setBrief] = useState(undefined);
  const [learnings, setLearnings] = useState([]);
  const [autos, setAutos] = useState([]);
  const [cmd, setCmd] = useState('');
  const [cmdReply, setCmdReply] = useState('');
  const [cmdBusy, setCmdBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const loadLearnings = useCallback(() => { api('/cos/learnings').then(setLearnings).catch(() => setLearnings([])); }, [api]);
  const loadAutos = useCallback(() => { api('/cos/automations').then(setAutos).catch(() => setAutos([])); }, [api]);

  useEffect(() => {
    api('/cos/brief/latest').then(setBrief).catch(() => setBrief(null));
    loadLearnings(); loadAutos();
  }, [api, loadLearnings, loadAutos]);

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
    } catch (e) {
      setCmdReply(`Couldn't do that: ${e.message}`);
    }
    setCmdBusy(false);
  };

  const toggleAuto = async (id) => {
    setBusyId(id);
    try { await api(`/cos/automations/${id}/toggle`, { method: 'POST' }); } catch (e) {}
    setBusyId(null); loadAutos();
  };

  const p = (brief && brief.payload) || {};
  const briefDate = brief && (brief.brief_date || brief.created_at);
  const scheduleText = (a) => `${a.frequency === 'weekly' ? `${a.weekday != null ? DOW[a.weekday] + 's' : 'weekly'}` : 'daily'} at ${a.time_local} MT`;

  return (
    <div style={{ maxWidth: 880 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>
          Your chief of staff{user?.name ? `, ${user.name.split(' ')[0]}` : ''} · watches mail, calendar, ops &amp; marketing
        </div>
        {briefDate && <div style={{ fontSize: '11px', color: 'var(--text3)' }}>last brief: {new Date(briefDate).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}</div>}
      </div>

      {/* VOICE — talk to it out loud */}
      <VoiceChat />

      {/* COMMAND BOX — talk to it, it sets things up */}
      <div className="card" style={{ marginBottom: '20px', borderLeft: '3px solid var(--accent)' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>Tell your chief of staff what to do</div>
        <textarea
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendCommand(); }}
          placeholder={'e.g. "Send me a marketing digest at 10pm every day" · "Build 2 marketing posts each week for approval" · "Always surface lawyer and bank emails first"'}
          rows={2}
          style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px', fontSize: '13px', color: 'var(--text)', resize: 'vertical', fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' }}>
          <button onClick={sendCommand} disabled={!cmd.trim() || cmdBusy}
            style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius)', padding: '7px 14px', fontSize: '13px', fontWeight: 500, cursor: cmd.trim() ? 'pointer' : 'default', opacity: cmd.trim() ? 1 : 0.5 }}>
            {cmdBusy ? 'Setting up…' : 'Send'}
          </button>
          <span style={{ fontSize: '11px', color: 'var(--text3)' }}>⌘↵ to send · it schedules + remembers; nothing posts without your approval</span>
        </div>
        {cmdReply && <div style={{ fontSize: '13px', color: 'var(--success)', marginTop: '10px', background: 'var(--bg3)', borderRadius: 'var(--radius)', padding: '8px 10px' }}>{cmdReply}</div>}
      </div>

      {/* AUTOMATIONS */}
      {autos.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '10px' }}>Automations</div>
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

      {/* THE BRIEF */}
      {brief === undefined ? (
        <div style={{ color: 'var(--text3)', padding: '20px' }}>Loading&hellip;</div>
      ) : brief === null ? (
        <div className="card" style={{ padding: '24px', marginBottom: '24px' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>No brief yet</div>
          <div style={{ fontSize: '13px', color: 'var(--text2)', lineHeight: 1.5 }}>
            Your chief of staff writes a brief each morning once the scheduled run is on — your action-needed email, calendar, shop alerts, and marketing approvals in one read, with the few things only you can do. You can already set things up with the command box above; it'll use them on the first run.
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: '24px' }}>
          {p.headline && (
            <div className="card" style={{ marginBottom: '12px', borderLeft: '3px solid var(--accent)' }}>
              <div style={{ fontSize: '11px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>The one thing today</div>
              <div style={{ fontSize: '15px', color: 'var(--text)', fontWeight: 500 }}>{p.headline}</div>
            </div>
          )}
          <Section icon="🔴" title="Only you can do this" items={p.priorities} />
          <Section icon="⚡" title="Needs your action" items={p.action_items} />
          <Section icon="📅" title="Today" items={p.calendar} />
          <Section icon="🔧" title="Operations" items={p.ops} />
          <Section icon="◆" title="Marketing" items={p.marketing} />
          <Section icon="👀" title="Watching" items={p.watch} />
          {!p.priorities && !p.action_items && !p.calendar && !p.ops && !p.marketing && brief.markdown && (
            <div className="card" style={{ whiteSpace: 'pre-wrap', fontSize: '13px', color: 'var(--text)', lineHeight: 1.5 }}>{brief.markdown}</div>
          )}
        </div>
      )}

      {/* SELF-LEARNING PANEL */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>What I've learned about you</div>
        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>👍 keep · 👎 drop</div>
      </div>
      {learnings.length === 0 ? (
        <div className="card" style={{ fontSize: '13px', color: 'var(--text2)' }}>
          Nothing learned yet. It tunes to you as you use the command box and as it watches what you act on vs ignore.
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
