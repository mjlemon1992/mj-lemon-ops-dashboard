// OPS 1.0 shared primitives (Phase 1). One card-header dialect, one status
// dot, one stat block — the audit found ~10 hand-rolled copies of each.
// Values come from the index.css tokens; nothing here restates a size or hex.
import React from 'react';

// 6px status dot. tone: any CSS color (use var(--success) etc.).
export const Dot = ({ tone = 'var(--text3)', size = 6 }) => (
  <span style={{ width: size, height: size, borderRadius: 'var(--r-pill)', background: tone, display: 'inline-block', flexShrink: 0 }} />
);

// The mono uppercase eyebrow label — the OPS signature.
export const Eyebrow = ({ children, tone = 'var(--text2)', style }) => (
  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-micro)', fontWeight: 600, letterSpacing: '0.13em', textTransform: 'uppercase', color: tone, ...style }}>
    {children}
  </span>
);

// One card header: eyebrow left, optional dot + mono meta right.
// <CardHeader title="Google reviews" meta="live" dot="var(--success)" />
export const CardHeader = ({ title, meta, dot, right, style }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12, ...style }}>
    <Eyebrow>{title}</Eyebrow>
    <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {right}
      {(dot || meta) && (
        <Eyebrow tone="var(--text2)" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, letterSpacing: '0.1em' }}>
          {dot && <Dot tone={dot} />}
          {meta}
        </Eyebrow>
      )}
    </span>
  </div>
);

// Display-face stat. size: 'd1' page hero · 'd2' card primary · 'd3' secondary.
export const Stat = ({ value, unit, size = 'd2', tone = 'var(--text)', label, style }) => (
  <div style={style}>
    <div style={{ fontFamily: 'var(--font-disp)', fontSize: `var(--fz-${size})`, fontWeight: 700, lineHeight: 1, color: tone, fontVariantNumeric: 'tabular-nums' }}>
      {value}
      {unit && <span style={{ fontSize: 'var(--fz-d3)', color: 'var(--text3)' }}>{unit}</span>}
    </div>
    {label && (
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-micro)', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text2)', marginTop: 5 }}>
        {label}
      </div>
    )}
  </div>
);
