import React, { useEffect, useRef } from 'react';

// OPS pace tachometer — a small canvas gauge reading % to target. Redline zone
// past 85%, needle sweeps on mount, redraws when the light/dark theme flips.
export default function PaceTach({ pct, size = 140 }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return undefined;
    const x = c.getContext('2d');
    const W = size, H = Math.round(size * 0.86);
    // Render at the device's real pixel density — without this the gauge is
    // drawn at 1x and upscaled (blurry on every Retina screen).
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr;
    c.style.width = `${W}px`; c.style.height = `${H}px`;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = W / 2, cy = H * 0.6, R = W * 0.37;
    const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;
    const ang = (f) => A0 + (A1 - A0) * f;
    const cssVar = (v, fb) => (getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fb);
    // Canvas paint styles can't resolve var() — read the token's computed
    // value once per draw so the gauge follows the theme (verify finding:
    // a raw var() string is silently ignored and the arc rendered black).
    const draw = (f) => {
      const steel = '#8b93a3';
      const accent = cssVar('--accent', '#F05423');
      x.clearRect(0, 0, W, H);
      x.beginPath(); x.arc(cx, cy, R, ang(0.85), A1); x.strokeStyle = accent; x.lineWidth = 6; x.stroke();
      for (let i = 0; i <= 10; i++) {
        const a = ang(i / 10);
        x.beginPath();
        x.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        x.lineTo(cx + Math.cos(a) * (R - 8), cy + Math.sin(a) * (R - 8));
        x.strokeStyle = i / 10 >= 0.85 ? accent : steel; x.lineWidth = 2; x.stroke();
      }
      const a = ang(f);
      x.beginPath();
      x.moveTo(cx + Math.cos(a + Math.PI / 2) * 3, cy + Math.sin(a + Math.PI / 2) * 3);
      x.lineTo(cx + Math.cos(a) * (R - 11), cy + Math.sin(a) * (R - 11));
      x.lineTo(cx + Math.cos(a - Math.PI / 2) * 3, cy + Math.sin(a - Math.PI / 2) * 3);
      x.closePath(); x.fillStyle = accent; x.fill();
      x.beginPath(); x.arc(cx, cy, 4.5, 0, 7); x.fillStyle = cssVar('--text', '#e0e0e0'); x.fill();
      x.fillStyle = accent; x.font = `700 ${Math.round(W * 0.09)}px 'Avenir Next Condensed','Barlow Condensed','Arial Narrow',sans-serif`;
      x.textAlign = 'center';
      x.fillText(pct != null ? Math.round(pct) : '—', cx, cy + R * 0.55);
      x.fillStyle = steel; x.font = '600 8px ui-monospace, Menlo, monospace';
      x.fillText('% TO TARGET', cx, cy + R * 0.55 + 12);
    };
    const T = Math.max(0, Math.min((pct || 0) / 100, 1));
    let raf = null, t0 = null;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) draw(T);
    else {
      const fr = (ts) => {
        if (!t0) t0 = ts;
        const p = Math.min((ts - t0) / 1100, 1);
        draw(p < 1 ? T * (1 - Math.pow(1 - p, 3)) : T);
        if (p < 1) raf = requestAnimationFrame(fr);
      };
      raf = requestAnimationFrame(fr);
    }
    const mo = new MutationObserver(() => draw(T));   // hub colour follows the theme
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { if (raf) cancelAnimationFrame(raf); mo.disconnect(); };
  }, [pct, size]);
  return <canvas ref={ref} width={size} height={Math.round(size * 0.86)} aria-label={`Pace gauge: ${pct != null ? Math.round(pct) : 'no'} percent to target`} />;
}
