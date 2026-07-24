import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import Icon from '../components/Icon';

const REFRESH_MS = 60 * 1000;          // DB-only server-side — cheap to poll, and the
                                       // live clock chips need to track the bay closely
const PERIOD_FLIP_MS = 15 * 1000;      // tech panel holds each of MTD / YTD this long
const NOTICE_FLIP_MS = 10 * 1000;      // text-banner rotation on the board page
const BOARD_MS = 40 * 1000;            // revenue/tech page holds this long...
const POSTER_MS = 15 * 1000;           // ...then each poster takes the full screen
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-CA');
const hrs = n => (n == null ? '—' : `${Math.round(Number(n) * 10) / 10}`);

const NOTICE_STYLE = {
  notice:      { icon: 'ℹ', color: 'var(--accent)',  label: 'NOTICE' },
  celebration: { icon: '🎉', color: 'var(--success)', label: 'SHOUT-OUT' },
  safety:      { icon: '⚠', color: 'var(--danger)',  label: 'SAFETY' },
  poster:      { icon: '', color: 'var(--accent)',    label: '' }
};

export default function Display() {
  const { locationId } = useParams();
  // Board theme comes from the URL (no Layout/toggle on this route):
  //   /display/<id>             → dark (default — right for a TV in the bay)
  //   /display/<id>?theme=light → light, for bright showroom walls
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('theme');
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
    return () => { if (t === 'light') document.documentElement.removeAttribute('data-theme'); };
  }, []);
  const pinKey = `display_pin_${locationId}`;
  const [pin, setPin] = useState(() => sessionStorage.getItem(pinKey) || '');
  const [entered, setEntered] = useState(() => !!sessionStorage.getItem(pinKey));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [period, setPeriod] = useState('mtd');   // flips mtd <-> ytd when ytd data exists
  const [fade, setFade] = useState(true);        // fade the tech panel through the flip
  const [noticeIdx, setNoticeIdx] = useState(0);
  const [posterIdx, setPosterIdx] = useState(0);
  const [showPoster, setShowPoster] = useState(false);
  const [stale, setStale] = useState(false);       // refresh failing — keep last numbers, say so
  const [shift, setShift] = useState(0);           // burn-in guard: tiny layout nudge
  const [nowTick, setNowTick] = useState(() => Date.now());  // clock for night mode
  // Per-board light/dark. The board renders outside Layout, so it stamps the
  // theme itself; its own localStorage key means the TV's choice never fights
  // the dashboard's theme on the same device.
  const themeKey = `display_theme_${locationId}`;
  const [boardTheme, setBoardTheme] = useState(() => localStorage.getItem(themeKey) || 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = boardTheme;
    localStorage.setItem(themeKey, boardTheme);
  }, [boardTheme, themeKey]);
  const [celebrate, setCelebrate] = useState(false);         // one-time target-hit takeover
  const [reviewBump, setReviewBump] = useState(false);       // "+1 review today" pulse
  const timer = useRef(null);

  const load = useCallback(async (thePin) => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/display/${locationId}?pin=${encodeURIComponent(thePin)}`, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) { setError('Incorrect PIN'); setEntered(false); sessionStorage.removeItem(pinKey); setLoading(false); return; }
      // Server errors and network blips both keep the last good numbers on the
      // wall — the board goes "stale", never blank.
      if (!res.ok) { setError(body.error || `Error ${res.status}`); setStale(true); setLoading(false); return; }
      sessionStorage.setItem(pinKey, thePin);
      setData(body); setEntered(true); setUpdatedAt(new Date()); setStale(false);
    } catch (e) {
      setError('Network error — retrying on next refresh');
      setStale(true);
    }
    setLoading(false);
  }, [locationId, pinKey]);

  // Minute clock (drives night mode + the stale "last updated" readout).
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Burn-in guard: nudge the whole layout by a couple of pixels every 5 minutes.
  // Imperceptible from across the bay, enough to keep a static TV honest.
  useEffect(() => {
    const t = setInterval(() => setShift(s => (s + 1) % 4), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  const SHIFTS = [[0, 0], [1, 1], [0, 2], [2, 0]];
  const nudge = { transform: `translate(${SHIFTS[shift][0]}px, ${SHIFTS[shift][1]}px)` };

  // After close: rest screen instead of numbers glowing at an empty shop all
  // night. Window is per-location (Locations → Shop-floor display), on the TV's
  // local clock; start === end disables it. Data keeps refreshing behind it.
  const hourNow = new Date(nowTick).getHours();
  const nightStart = Number.isInteger(Number(data?.location?.night_start)) ? Number(data.location.night_start) : 21;
  const nightEnd = Number.isInteger(Number(data?.location?.night_end)) ? Number(data.location.night_end) : 6;
  const night = nightStart !== nightEnd && (nightStart < nightEnd
    ? (hourNow >= nightStart && hourNow < nightEnd)          // same-day window (e.g. 1am–5am)
    : (hourNow >= nightStart || hourNow < nightEnd));        // wraps midnight (e.g. 9pm–6am)

  // One-time celebration the moment the month crosses target — full-screen for
  // 30s, then never again that month (per board, via localStorage).
  useEffect(() => {
    if (!data || data.pct_to_target == null || data.pct_to_target < 100) return;
    const ym = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }).slice(0, 7);
    const key = `ops_celebrated_${locationId}_${ym}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    setCelebrate(true);
    const t = setTimeout(() => setCelebrate(false), 30 * 1000);
    return () => clearTimeout(t);
  }, [data, locationId]);

  // "+1 ★★★★★ today" pulse: light up for the rest of the day when the
  // new-reviews-this-month count ticks up.
  useEffect(() => {
    if (!data || !data.reviews) return;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
    const key = `ops_rvd_${locationId}`;
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { prev = null; }
    const delta = Number(data.reviews.delta) || 0;
    if (prev && delta > Number(prev.delta || 0)) {
      localStorage.setItem(key, JSON.stringify({ delta, day: today }));
      setReviewBump(true);
    } else {
      if (!prev || Number(prev.delta || 0) !== delta) localStorage.setItem(key, JSON.stringify({ delta, day: prev && prev.day === today ? today : '' }));
      setReviewBump(!!(prev && prev.day === today && delta > 0));
    }
  }, [data, locationId]);

  // Initial load + auto-refresh while unlocked.
  useEffect(() => {
    if (!entered || !pin) return undefined;
    load(pin);
    timer.current = setInterval(() => load(pin), REFRESH_MS);
    return () => timer.current && clearInterval(timer.current);
  }, [entered, pin, load]);

  // Cycle the tech panel between this-month and year-to-date. Only flip when
  // there is YTD data to show; fade out, swap, fade back in.
  const hasYtd = !!(data && data.techs_ytd && data.techs_ytd.length);
  useEffect(() => {
    if (!hasYtd) { setPeriod('mtd'); return undefined; }
    const t = setInterval(() => {
      setFade(false);
      setTimeout(() => { setPeriod(p => (p === 'mtd' ? 'ytd' : 'mtd')); setFade(true); }, 400);
    }, PERIOD_FLIP_MS);
    return () => clearInterval(t);
  }, [hasYtd]);

  // Posters (image posts) take over the FULL screen on a page-flip cycle so
  // they never bury the numbers: board page for BOARD_MS, then each poster
  // for POSTER_MS, then back. Text notices stay as a slim banner on the board.
  const notices = (data && data.notices) || [];
  const posters = notices.filter(n => n.kind === 'poster' && (n.image || n.image_url));
  const banners = notices.filter(n => !(n.kind === 'poster' && (n.image || n.image_url)));

  // Rotate text banners on the board page.
  useEffect(() => {
    if (banners.length < 2) { setNoticeIdx(0); return undefined; }
    const t = setInterval(() => setNoticeIdx(i => (i + 1) % banners.length), NOTICE_FLIP_MS);
    return () => clearInterval(t);
  }, [banners.length]);

  // Page-flip: board <-> full-screen poster(s).
  useEffect(() => {
    if (!posters.length) { setShowPoster(false); return undefined; }
    let t;
    let cancelled = false;
    const showBoard = () => {
      t = setTimeout(() => {
        if (cancelled) return;
        setShowPoster(true);
        t = setTimeout(() => {
          if (cancelled) return;
          setShowPoster(false);
          setPosterIdx(i => (i + 1) % posters.length);
          showBoard();
        }, POSTER_MS);
      }, BOARD_MS);
    };
    showBoard();
    return () => { cancelled = true; clearTimeout(t); };
  }, [posters.length]);

  // ☀/🌙 switch — big enough to hit on a TV touchscreen, quiet enough to ignore.
  const themeToggle = (
    <button onClick={() => setBoardTheme(t => (t === 'dark' ? 'light' : 'dark'))}
      title={boardTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle light/dark mode"
      style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer', lineHeight: 1.3 }}>
      <Icon name={boardTheme === 'dark' ? 'sun' : 'moon'} size={16} style={{ verticalAlign: 'middle' }} />
    </button>
  );

  // PIN entry screen
  if (!entered) {
    return (
      <div style={wrap}>
        <div style={{ position: 'fixed', top: '18px', right: '18px' }}>{themeToggle}</div>
        <form onSubmit={e => { e.preventDefault(); if (pin) setEntered(true); }} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '28px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '-1px', marginBottom: '6px' }}>OPS DISPLAY</div>
          <div style={{ color: 'var(--text3)', fontSize: '14px', marginBottom: '24px' }}>Enter the display PIN for this location</div>
          <input
            autoFocus type="text" inputMode="text" value={pin}
            onChange={e => setPin(e.target.value.slice(0, 12))}
            placeholder="PIN"
            style={{ fontSize: '32px', letterSpacing: '8px', textAlign: 'center', padding: '12px 20px', width: '220px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)' }}
          />
          <div><button className="primary" type="submit" style={{ marginTop: '20px', fontSize: '16px', padding: '10px 28px' }}>Show board</button></div>
          {error && <div style={{ color: 'var(--danger)', marginTop: '16px', fontSize: '14px' }}>{error}</div>}
        </form>
      </div>
    );
  }

  if (!data) {
    return <div style={wrap}><div style={{ color: 'var(--text3)', fontSize: '18px' }}>{error || 'Loading board…'}</div></div>;
  }

  const target = data.target;
  const pct = data.pct_to_target;
  const barPct = pct == null ? 0 : Math.max(2, Math.min(100, pct));
  const over = target != null && data.revenue >= target;
  const onPace = data.pace_pct != null && data.pace_pct >= 100;
  const barColor = over ? 'var(--success)' : (onPace ? 'var(--success)' : (data.pace_pct != null && data.pace_pct >= 90 ? 'var(--warning)' : 'var(--danger)'));
  const effTarget = data.efficiency_target || 80;

  const showYtd = period === 'ytd' && hasYtd;
  const techRows = showYtd ? data.techs_ytd : data.techs;
  const notice = banners.length ? banners[Math.min(noticeIdx, banners.length - 1)] : null;
  const nStyle = notice ? (NOTICE_STYLE[notice.kind] || NOTICE_STYLE.notice) : null;
  const poster = posters.length ? posters[posterIdx % posters.length] : null;

  // After-hours rest screen — logo, clock, lights out on the numbers.
  if (night && !celebrate) {
    return (
      <div style={{ ...wrap, justifyContent: 'center' }}>
        <div style={{ position: 'fixed', top: '18px', right: '18px' }}>{themeToggle}</div>
        <div style={{ textAlign: 'center', ...nudge }}>
          <div style={{ fontSize: '34px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '-1px' }}>OPS</div>
          <div style={{ fontFamily: 'var(--font-disp)', fontSize: '26px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text2)', marginTop: '6px' }}>{data.location.name}</div>
          <div style={{ fontFamily: 'var(--font-disp)', fontSize: '84px', fontWeight: 700, color: 'var(--text)', marginTop: '30px', fontVariantNumeric: 'tabular-nums' }}>
            {new Date(nowTick).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}
          </div>
          <div style={{ fontSize: '17px', color: 'var(--text3)', marginTop: '14px' }}>
            {new Date(nowTick).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })} · see you tomorrow
          </div>
        </div>
      </div>
    );
  }

  // One-time target-hit takeover (30s, once per month per board).
  if (celebrate) {
    return (
      <div style={{ ...wrap, justifyContent: 'center', overflow: 'hidden' }}>
        <style>{`
          @keyframes ops-pop { 0% { transform: scale(0.6); opacity: 0; } 60% { transform: scale(1.08); opacity: 1; } 100% { transform: scale(1); } }
          @keyframes ops-drift { 0% { transform: translateY(-8vh) rotate(0deg); opacity: 0; } 12% { opacity: 1; } 100% { transform: translateY(108vh) rotate(320deg); opacity: 0.9; } }
        `}</style>
        {['🎉','🏁','⭐','🎉','🔧','🎉','⭐','🏁','🎉','⭐','🎉','🔧'].map((e, i) => (
          <span key={i} style={{ position: 'fixed', top: 0, left: `${(i * 8.3 + 4) % 100}%`, fontSize: `${26 + (i % 3) * 12}px`, animation: `ops-drift ${5 + (i % 4)}s linear ${(i % 5) * 0.9}s infinite` }}>{e}</span>
        ))}
        <div style={{ textAlign: 'center', animation: 'ops-pop 0.8s ease' }}>
          <div style={{ fontSize: '30px', fontWeight: 800, letterSpacing: '0.2em', color: 'var(--success)', textTransform: 'uppercase' }}>Target hit</div>
          <div style={{ fontFamily: 'var(--font-disp)', fontSize: '110px', fontWeight: 700, color: 'var(--text)', lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>{money(data.revenue)}</div>
          <div style={{ fontSize: '24px', color: 'var(--text2)', marginTop: '10px' }}>
            {data.location.name} just cleared this month's {money(target)} target. That's everyone. 🍻
          </div>
        </div>
      </div>
    );
  }

  // Full-screen poster page — flips back to the board automatically.
  if (showPoster && poster) {
    return (
      <div style={{ ...wrap, alignItems: 'stretch', justifyContent: 'flex-start', padding: '24px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
            <span style={{ fontSize: '26px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '-1px' }}>OPS</span>
            <span style={{ fontFamily: 'var(--font-disp)', fontSize: '26px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em', color: 'var(--text)' }}>{data.location.name}</span>
          </div>
          {posters.length > 1 && <NoticeDots count={posters.length} idx={posterIdx % posters.length} />}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
          {/* No title/body caption here: the poster IS the message (AI posters bake
              the words into the design), so a caption just echoed the same text. */}
          <img src={poster.image || poster.image_url} alt={poster.title || 'Poster'}
            style={{ maxWidth: '96%', maxHeight: '84vh', objectFit: 'contain', borderRadius: '14px' }} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...wrap, alignItems: 'stretch', justifyContent: 'flex-start', padding: '32px 40px', ...nudge }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
          <span style={{ fontSize: '26px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '-1px' }}>OPS</span>
          <span style={{ fontFamily: 'var(--font-disp)', fontSize: '26px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em', color: 'var(--text)' }}>{data.location.name}</span>
        </div>
        {/* Honest freshness: if refresh is failing, the numbers stay up but the
            header says so — old data must never impersonate live data. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          {stale ? (
            <div style={{ fontSize: '13px', color: 'var(--warning)', fontWeight: 700 }}>
              ⚠ Last updated {updatedAt ? updatedAt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '—'} — reconnecting…
            </div>
          ) : (
            <div style={{ fontSize: '13px', color: 'var(--text3)' }}>
              {loading ? 'Refreshing…' : `Updated ${updatedAt ? updatedAt.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : ''}`} · auto-refresh 1 min
            </div>
          )}
          {themeToggle}
        </div>
      </div>

      {/* Text notices — slim banner above the numbers; posters get their own
          full-screen page on the flip cycle instead of living here. */}
      {notice ? (
        <div key={notice.id} style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', marginBottom: '28px', background: 'var(--bg2)', border: `1px solid ${nStyle.color}`, borderLeft: `8px solid ${nStyle.color}`, borderRadius: '16px', padding: '20px 28px' }}>
          <div style={{ fontSize: '40px', lineHeight: 1 }}>{nStyle.icon}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: nStyle.color, marginBottom: '4px' }}>{nStyle.label}</div>
            {notice.title && <div style={{ fontSize: '26px', fontWeight: 700, color: 'var(--text)' }}>{notice.title}</div>}
            {notice.body && <div style={{ fontSize: '19px', color: 'var(--text2)', marginTop: '6px', whiteSpace: 'pre-wrap' }}>{notice.body}</div>}
          </div>
          {(notice.image || notice.image_url) && <img src={notice.image || notice.image_url} alt="" style={{ maxHeight: '120px', maxWidth: '200px', objectFit: 'contain', borderRadius: '10px' }} />}
          {banners.length > 1 && <NoticeDots count={banners.length} idx={noticeIdx} vertical />}
        </div>
      ) : null}

      {/* Revenue vs target bar */}
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', padding: '28px 32px', marginBottom: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>Revenue this month</div>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: '72px', fontWeight: 700, color: 'var(--text)', lineHeight: 1.02, fontVariantNumeric: 'tabular-nums' }}>{money(data.revenue)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>Target</div>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: '44px', fontWeight: 700, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{target != null ? money(target) : 'Not set'}</div>
          </div>
        </div>

        <div style={{ height: '34px', background: 'var(--bg3)', borderRadius: '17px', overflow: 'hidden', position: 'relative' }}>
          <div style={{ width: `${barPct}%`, height: '100%', background: barColor, borderRadius: '17px', transition: 'width 0.6s ease' }} />
          {/* Best-month-this-year record line — beat your own best, not just the target. */}
          {data.record && target > 0 && data.record.revenue > 0 && (() => {
            const rp = Math.min(100, Math.round((data.record.revenue / target) * 100));
            return rp >= 5 ? <div title="Best month this year" style={{ position: 'absolute', top: 0, bottom: 0, left: `${rp}%`, width: '3px', background: 'var(--text)', opacity: 0.55 }} /> : null;
          })()}
          {pct != null && (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: 700, color: 'var(--text)' }}>
              {pct}% of target
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', marginTop: '14px', fontSize: '18px', flexWrap: 'wrap' }}>
          <div style={{ color: barColor, fontWeight: 700 }}>
            {target == null ? 'Set a monthly target' : over ? `${money(data.revenue - target)} over target 🎉` : `${money(data.gap)} to go`}
          </div>
          {/* What today needs — the month bar made actionable. */}
          {data.days && data.days.per_day_needed != null && !over && (
            <div style={{ color: 'var(--text2)' }}>
              Day {data.days.working_elapsed} of {data.days.working_total} · <b>{money(data.days.per_day_needed)}/working day</b> to hit target
            </div>
          )}
          <div style={{ display: 'flex', gap: '18px', color: 'var(--text3)' }}>
            {data.record && data.record.revenue > 0 && (
              <span>▍best month {money(data.record.revenue)}{data.revenue > data.record.revenue ? ' — new record! 🏆' : ''}</span>
            )}
            {data.pace_pct != null && <span>{data.pace_pct}% of pace</span>}
          </div>
        </div>
      </div>

      {/* Cars this month — board-legal, same treatment as revenue. */}
      {data.cars && data.cars.actual != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', padding: '18px 32px', marginBottom: '28px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em', width: '170px' }}>Cars this month</div>
          <div style={{ fontFamily: 'var(--font-disp)', fontSize: '40px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {data.cars.actual}{data.cars.target ? <span style={{ fontSize: '22px', color: 'var(--text3)', fontWeight: 600 }}> / {data.cars.target}</span> : null}
          </div>
          {data.cars.target > 0 && (
            <div style={{ flex: 1, height: '18px', background: 'var(--bg3)', borderRadius: '9px', overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(2, Math.min(100, data.cars.pct_to_target || 0))}%`, height: '100%', borderRadius: '9px', transition: 'width 0.6s ease', background: (data.cars.pace_pct == null || data.cars.pace_pct >= 100) ? 'var(--success)' : (data.cars.pace_pct >= 90 ? 'var(--warning)' : 'var(--danger)') }} />
            </div>
          )}
          {data.cars.pace_pct != null && <div style={{ fontSize: '16px', color: 'var(--text3)', whiteSpace: 'nowrap' }}>{data.cars.pace_pct}% of pace</div>}
        </div>
      )}

      {/* Bonus gate — visibility only: sales-vs-target, which is already on this
          board. Pool %, net profit, and dollar amounts never appear here. */}
      {data.bonus_gate && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', background: 'var(--bg2)', border: `1px solid ${data.bonus_gate.pct >= 100 ? 'var(--success)' : 'var(--border)'}`, borderRadius: '14px', padding: '14px 28px', marginBottom: '28px', fontSize: '19px', fontWeight: 600 }}>
          {data.bonus_gate.pct >= (data.bonus_gate.stretch_pct || 110) ? (
            <span style={{ color: 'var(--success)' }}>🚀 Stretch tier reached — team bonus at its top rate this month.</span>
          ) : data.bonus_gate.pct >= 100 ? (
            <span style={{ color: 'var(--success)' }}>✅ Team bonus unlocked{data.bonus_gate.stretch_pct ? ` — stretch tier at ${data.bonus_gate.stretch_pct}% of target` : ''}.</span>
          ) : (
            <span style={{ color: 'var(--text2)' }}>🎯 Team bonus unlocks at 100% of target — currently <b style={{ color: 'var(--text)' }}>{data.bonus_gate.pct}%</b>.</span>
          )}
        </div>
      )}

      {/* Google reviews — rating + new reviews this month */}
      {data.reviews && data.reviews.rating != null && (
        <div style={{ display: 'flex', gap: '28px', marginBottom: '28px' }}>
          <div style={{ flex: 1, background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', padding: '24px 32px' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>Google rating</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px', marginTop: '8px' }}>
              <span style={{ fontFamily: 'var(--font-disp)', fontSize: '60px', fontWeight: 700, lineHeight: 1 }}>{Number(data.reviews.rating).toFixed(1)}</span>
              <span style={{ fontSize: '28px', color: 'var(--accent)', letterSpacing: '2px' }}>★★★★★</span>
            </div>
            <div style={{ fontSize: '16px', color: 'var(--text3)', marginTop: '10px' }}>
              {data.reviews.total != null ? `${Number(data.reviews.total).toLocaleString('en-CA')} reviews total` : ''}
            </div>
          </div>
          <div style={{ flex: 1, background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', padding: '24px 32px' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>New reviews this month</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
              <div style={{ fontFamily: 'var(--font-disp)', fontSize: '60px', fontWeight: 700, lineHeight: 1, marginTop: '8px', color: data.reviews.delta > 0 ? 'var(--success)' : 'var(--text)' }}>
                {data.reviews.delta > 0 ? `+${data.reviews.delta}` : (data.reviews.delta || 0)}
              </div>
              {reviewBump && (
                <span style={{ fontSize: '17px', fontWeight: 800, color: 'var(--success)', background: 'rgba(80,200,120,0.14)', border: '1px solid var(--success)', borderRadius: '12px', padding: '5px 14px', whiteSpace: 'nowrap' }}>
                  +1 ★★★★★ today
                </span>
              )}
            </div>
            <div style={{ fontSize: '16px', color: 'var(--text3)', marginTop: '10px' }}>month to date</div>
          </div>
        </div>
      )}

      {/* Tech leaderboard — cycles between this month and year-to-date */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
          Technicians · hours sold {!showYtd && data.totals && `(${hrs(data.totals.hours_sold)} sold / ${hrs(data.totals.hours_billed)} billed)`}
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '13px', fontWeight: 800, letterSpacing: '0.1em', padding: '4px 14px', borderRadius: '12px', background: !showYtd ? 'var(--accent)' : 'var(--bg3)', color: !showYtd ? '#1a1a1a' : 'var(--text3)', transition: 'all 0.3s' }}>THIS MONTH</span>
          {hasYtd && <span style={{ fontSize: '13px', fontWeight: 800, letterSpacing: '0.1em', padding: '4px 14px', borderRadius: '12px', background: showYtd ? 'var(--accent)' : 'var(--bg3)', color: showYtd ? '#1a1a1a' : 'var(--text3)', transition: 'all 0.3s' }}>YEAR TO DATE</span>}
        </div>
      </div>
      <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', overflow: 'hidden', opacity: fade ? 1 : 0, transition: 'opacity 0.4s ease' }}>
        <div style={{ display: 'grid', gridTemplateColumns: showYtd ? '2fr 1fr 1fr 1.2fr' : '2fr 0.9fr 1fr 1fr 1.2fr', padding: '12px 24px', borderBottom: '0.5px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          <div>Technician</div>
          {!showYtd && <div style={{ textAlign: 'right' }}>This week</div>}
          <div style={{ textAlign: 'right' }}>Billed</div>
          <div style={{ textAlign: 'right' }}>Sold</div>
          <div style={{ textAlign: 'right' }}>Efficiency</div>
        </div>
        {techRows.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text3)' }}>{showYtd ? 'No YTD tech hours yet.' : 'No tech hours yet this month.'}</div>
        )}
        {techRows.map(t => {
          const eff = t.efficiency;
          const effColor = eff == null ? 'var(--text3)' : (eff >= effTarget ? 'var(--success)' : (eff >= effTarget - 10 ? 'var(--warning)' : 'var(--danger)'));
          // Live kiosk status: mirror the time clock on the board (matched by
          // folded first name, same rule the bonus pull uses).
          const nf = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/)[0];
          const c = (data.clock || []).find(x => nf(x.name) && nf(t.tech_name).startsWith(nf(x.name)));
          const tmin = ts => Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
          const tfmt = ts => new Date(ts).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
          const chip = !c ? null
            : c.status === 'on' ? { txt: `🟢 In since ${tfmt(c.clock_in)}`, col: 'var(--success)' }
            : c.status === 'break' ? { txt: `🟡 Break · ${tmin(c.break_started_at)} min`, col: 'var(--warning)' }
            : { txt: '⚫ Clocked out', col: 'var(--text3)' };
          return (
            <div key={t.tech_id || t.tech_name} style={{ display: 'grid', gridTemplateColumns: showYtd ? '2fr 1fr 1fr 1.2fr' : '2fr 0.9fr 1fr 1fr 1.2fr', padding: '16px 24px', borderBottom: '0.5px solid var(--border)', alignItems: 'center' }}>
              <div style={{ fontSize: '22px', fontWeight: 600, color: (c && c.color) || 'var(--text)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                {c && c.photo && <img src={c.photo} alt="" style={{ width: '34px', height: '34px', borderRadius: '50%', objectFit: 'cover', border: c.color ? `2px solid ${c.color}` : 'none' }} />}
                {t.tech_name}
                {chip && <span style={{ fontSize: '13px', fontWeight: 600, color: chip.col, whiteSpace: 'nowrap' }}>{chip.txt}</span>}
              </div>
              {!showYtd && <div style={{ textAlign: 'right', fontFamily: 'var(--font-disp)', fontSize: '24px', fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{hrs(t.hours_sold_week)}</div>}
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-disp)', fontSize: '24px', fontWeight: 700, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{hrs(t.hours_billed)}</div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-disp)', fontSize: '24px', fontWeight: 700, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>{hrs(t.hours_sold)}</div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-disp)', fontSize: '27px', fontWeight: 700, color: effColor, fontVariantNumeric: 'tabular-nums' }}>{eff == null ? '—' : `${eff}%`}</div>
            </div>
          );
        })}
      </div>

      {/* All-locations revenue standings (revenue only) */}
      {data.leaderboard && data.leaderboard.length >= 2 && (
        <div style={{ marginTop: '28px' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.14em', marginBottom: '10px' }}>
            Group standings · revenue to date
          </div>
          <div style={{ background: 'var(--bg2)', border: '0.5px solid var(--border)', borderRadius: '16px', overflow: 'hidden' }}>
            {data.leaderboard.map(loc => (
              <div key={loc.id} style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '14px 24px', borderBottom: '0.5px solid var(--border)', background: loc.is_current ? 'var(--bg3)' : 'transparent' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: 800, color: loc.rank === 1 ? '#1a1a1a' : 'var(--text2)', background: loc.rank === 1 ? 'var(--accent)' : 'var(--bg3)' }}>{loc.rank}</div>
                <div style={{ flex: 1, fontSize: '22px', fontWeight: loc.is_current ? 700 : 500, color: 'var(--text)' }}>
                  {loc.name}{loc.is_current ? ' (this shop)' : ''}
                </div>
                <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--text)' }}>{money(loc.revenue)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 'auto', paddingTop: '20px', fontSize: '12px', color: 'var(--text3)', textAlign: 'center' }}>
        Efficiency = hours sold ÷ available hours ({data.location.weekly_hours || 40}h/wk base, minus {data.location.province?.toUpperCase()} stat holidays) · target {effTarget}%
      </div>
    </div>
  );
}

function NoticeDots({ count, idx, vertical }) {
  return (
    <div style={{ display: 'flex', flexDirection: vertical ? 'column' : 'row', gap: '6px', justifyContent: 'center', padding: vertical ? 0 : '0 0 12px' }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ width: '8px', height: '8px', borderRadius: '50%', background: i === idx ? 'var(--accent)' : 'var(--bg3)' }} />
      ))}
    </div>
  );
}

const wrap = {
  minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px'
};
