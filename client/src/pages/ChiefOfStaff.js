import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

// Chief of Staff tab: shows the latest brief the scheduled CoS agent wrote, and
// lets the owner steer what it's learned (reinforce / retire) + teach it new
// things. Those steer + teach actions are the feedback half of the self-learning
// loop — the agent reads them on its next run and updates its memory.

const CAT_LABEL = {
  priority: 'priority', focus: 'focus', ignore: 'ignore',
  tone: 'tone', timing: 'timing', format: 'format', source: 'source',
};

// One brief section. `items` may be strings or {title, detail, source, link}.
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
  const [brief, setBrief] = useState(undefined); // undefined=loading, null=none
  const [learnings, setLearnings] = useState([]);
  const [teach, setTeach] = useState('');
  const [teachState, setTeachState] = useState(''); // '', 'saving', 'saved'
  const [busyId, setBusyId] = useState(null);

  const loadLearnings = useCallback(() => {
    api('/cos/learnings').then(setLearnings).catch(() => setLearnings([]));
  }, [api]);

  useEffect(() => {
    api('/cos/brief/latest').then(setBrief).catch(() => setBrief(null));
    loadLearnings();
  }, [api, loadLearnings]);

  const vote = async (id, dir) => {
    setBusyId(id);
    try { await api(`/cos/learnings/${id}/vote`, { method: 'POST', body: JSON.stringify({ dir }) }); }
    catch (e) { /* surfaced by reload */ }
    setBusyId(null);
    loadLearnings();
  };

  const submitTeach = async () => {
    const note = teach.trim();
    if (!note) return;
    setTeachState('saving');
    try {
      await api('/cos/feedback', { method: 'POST', body: JSON.stringify({ kind: 'teach', note, brief_id: (brief && brief.id) || null }) });
      setTeach(''); setTeachState('saved');
      setTimeout(() => setTeachState(''), 2500);
    } catch (e) { setTeachState(''); }
  };

  const p = (brief && brief.payload) || {};
  const briefDate = brief && (brief.brief_date || brief.created_at);

  return (
    <div style={{ maxWidth: 880 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ fontSize: '11px', color: 'var(--text3)' }}>
          Your chief of staff{user?.name ? `, ${user.name.split(' ')[0]}` : ''} · watches mail, calendar, ops &amp; marketing
        </div>
        {briefDate && <div style={{ fontSize: '11px', color: 'var(--text3)' }}>last brief: {new Date(briefDate).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}</div>}
      </div>

      {/* THE BRIEF */}
      {brief === undefined ? (
        <div style={{ color: 'var(--text3)', padding: '30px' }}>Loading&hellip;</div>
      ) : brief === null ? (
        <div className="card" style={{ padding: '24px', marginBottom: '24px' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>No brief yet</div>
          <div style={{ fontSize: '13px', color: 'var(--text2)', lineHeight: 1.5 }}>
            Your chief of staff writes a brief each morning once the scheduled run is switched on — pulling your action-needed email, calendar, shop alerts, and marketing approvals into one read, with the few things only you can do. Until then, you can already teach it below; it'll use what you tell it on its first run.
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
          {/* Fallback: render markdown if no structured sections were provided. */}
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
        <div className="card" style={{ fontSize: '13px', color: 'var(--text2)', marginBottom: '16px' }}>
          Nothing learned yet. It starts tuning to you as you teach it and as it watches what you act on vs ignore.
        </div>
      ) : (
        <div style={{ marginBottom: '16px' }}>
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

      {/* TEACH BOX */}
      <div className="card">
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>Teach your chief of staff</div>
        <textarea
          value={teach}
          onChange={e => setTeach(e.target.value)}
          placeholder="e.g. 'Always surface anything from the lawyer or bank first' · 'Stop showing me newsletters' · 'I check the brief around 6am'"
          rows={3}
          style={{ width: '100%', boxSizing: 'border-box', background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px', fontSize: '13px', color: 'var(--text)', resize: 'vertical', fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' }}>
          <button onClick={submitTeach} disabled={!teach.trim() || teachState === 'saving'}
            style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius)', padding: '7px 14px', fontSize: '13px', fontWeight: 500, cursor: teach.trim() ? 'pointer' : 'default', opacity: teach.trim() ? 1 : 0.5 }}>
            {teachState === 'saving' ? 'Saving…' : 'Teach'}
          </button>
          {teachState === 'saved' && <span style={{ fontSize: '12px', color: 'var(--success)' }}>Got it — it'll apply this on the next run.</span>}
        </div>
      </div>
    </div>
  );
}
