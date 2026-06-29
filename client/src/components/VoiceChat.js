import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

// Browser-native voice chief of staff: free Web Speech APIs do the speech<->text,
// the /cos/chat endpoint does the reasoning + actions (brief, clear alerts,
// schedule, set preferences). Degrades gracefully: if the browser has no
// SpeechRecognition (non-Chrome), it still speaks replies and you type back.

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const CAN_SPEAK = typeof window !== 'undefined' && 'speechSynthesis' in window;

export default function VoiceChat() {
  const { api } = useAuth();
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState('');
  const [transcript, setTranscript] = useState([]);
  const [typed, setTyped] = useState('');
  const convoRef = useRef([]);
  const activeRef = useRef(false);
  const recogRef = useRef(null);

  const addLine = (who, text) => setTranscript(t => [...t, { who, text }]);

  const speak = (text) => new Promise(resolve => {
    if (!CAN_SPEAK || !text) { resolve(); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-CA'; u.rate = 1.03;
    u.onend = resolve; u.onerror = resolve;
    setStatus('Speaking…');
    window.speechSynthesis.speak(u);
  });

  const listen = () => {
    if (!SR || !activeRef.current) { setStatus(activeRef.current ? '' : ''); return; }
    try {
      const r = new SR();
      r.lang = 'en-CA'; r.interimResults = false; r.maxAlternatives = 1;
      recogRef.current = r;
      setStatus('Listening…');
      r.onresult = (e) => { handleText(e.results[0][0].transcript); };
      r.onerror = () => { setStatus(''); };
      r.start();
    } catch (e) { setStatus(''); }
  };

  const handleText = async (text) => {
    if (!text || !text.trim()) return;
    addLine('you', text);
    const convo = [...convoRef.current, { role: 'user', content: text }];
    convoRef.current = convo;
    setStatus('Thinking…');
    try {
      const resp = await api('/cos/chat', { method: 'POST', body: JSON.stringify({ messages: convo }) });
      convoRef.current = resp.messages || convo;
      addLine('cos', resp.reply || '');
      await speak(resp.reply || '');
    } catch (e) { addLine('cos', `Sorry — ${e.message}`); }
    setStatus('');
    if (activeRef.current && SR) listen();
  };

  const start = async () => {
    setActive(true); activeRef.current = true; setTranscript([]); convoRef.current = [];
    setStatus('Thinking…');
    try {
      const resp = await api('/cos/chat', { method: 'POST', body: JSON.stringify({ briefing: true }) });
      convoRef.current = resp.messages || [];
      addLine('cos', resp.reply || '');
      await speak(resp.reply || '');
    } catch (e) { addLine('cos', `Sorry — ${e.message}`); }
    setStatus('');
    if (activeRef.current && SR) listen();
  };

  const stop = () => {
    setActive(false); activeRef.current = false; setStatus('');
    try { if (recogRef.current) recogRef.current.abort(); } catch (e) {}
    if (CAN_SPEAK) window.speechSynthesis.cancel();
  };

  useEffect(() => () => {
    activeRef.current = false;
    if (CAN_SPEAK) window.speechSynthesis.cancel();
    try { if (recogRef.current) recogRef.current.abort(); } catch (e) {}
  }, []);

  const submitTyped = () => { const t = typed.trim(); if (!t) return; setTyped(''); handleText(t); };

  return (
    <div className="card" style={{ marginBottom: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>🎙 Talk to your chief of staff</div>
        {!active ? (
          <button onClick={start}
            style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius)', padding: '7px 14px', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}>
            Start voice briefing
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text3)' }}>{status || 'Ready'}</span>
            <button onClick={stop}
              style={{ background: 'none', color: 'var(--danger)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '6px 12px', fontSize: '12px', cursor: 'pointer' }}>
              Stop
            </button>
          </div>
        )}
      </div>

      {!SR && (
        <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '6px' }}>
          This browser can't capture speech — it'll read replies aloud and you type back. For full hands-free voice, open this in Chrome.
        </div>
      )}

      {transcript.length > 0 && (
        <div style={{ marginTop: '12px', maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {transcript.map((l, i) => (
            <div key={i} style={{ alignSelf: l.who === 'you' ? 'flex-end' : 'flex-start', maxWidth: '85%', background: l.who === 'you' ? 'var(--bg3)' : 'rgba(240,84,35,0.08)', borderRadius: 'var(--radius)', padding: '8px 11px' }}>
              <div style={{ fontSize: '9px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>{l.who === 'you' ? 'You' : 'Chief of staff'}</div>
              <div style={{ fontSize: '13px', color: 'var(--text)' }}>{l.text}</div>
            </div>
          ))}
        </div>
      )}

      {active && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
          <input
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitTyped(); }}
            placeholder={SR ? 'or type instead of talking…' : 'type your reply…'}
            style={{ flex: 1, background: 'var(--bg3)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 10px', fontSize: '13px', color: 'var(--text)' }}
          />
          <button onClick={submitTyped} disabled={!typed.trim()}
            style={{ background: 'var(--bg3)', color: 'var(--text)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 14px', fontSize: '13px', cursor: typed.trim() ? 'pointer' : 'default', opacity: typed.trim() ? 1 : 0.5 }}>
            Send
          </button>
        </div>
      )}

      {!active && (
        <div style={{ fontSize: '11px', color: 'var(--text3)', marginTop: '8px' }}>
          It briefs you aloud, then you talk back — “clear the alerts”, “schedule a marketing digest at 10pm”, “what's waiting for approval”. Email + calendar live in the Claude app voice; this handles the dashboard.
        </div>
      )}
    </div>
  );
}
