#!/usr/bin/env python3
"""Phase 1 token codemod (OPS 1.0). Collapses the inline font-size sprawl
(32 hand-typed values doing 7 jobs), the 13 border radii, the repeated mono
stack and the hardcoded brand hexes onto the index.css tokens.

Excluded: Display.js, ClockKiosk.js, Login.js (floor surfaces are reskinned
last, on real hardware — see the migration manifest). Sizes >=14.5px that
aren't exact ramp steps are left for the per-screen Phase 2 passes.

Run from repo root:  python3 scripts/codemod-tokens.py
"""
import pathlib, re, collections

ROOT = pathlib.Path(__file__).resolve().parent.parent / 'client' / 'src'
EXCLUDE = {'Display.js', 'ClockKiosk.js', 'Login.js'}
# Files where the brand hex lives in non-cascading contexts (SVG-string poster
# template rasterized off-DOM; Canvas 2D paint styles): var() would render
# BLACK there. They keep literal hexes (PaceTach uses its cssVar() helper).
HEX_EXCLUDE = {'ApprovalQueue.js', 'PaceTach.js'}

FZ = {
    '9.5px': 'var(--fz-micro)', '10px': 'var(--fz-micro)', '10.5px': 'var(--fz-micro)',
    '11px': 'var(--fz-label)', '11.5px': 'var(--fz-label)', '12px': 'var(--fz-label)',
    '12.5px': 'var(--fz-body)', '13px': 'var(--fz-body)', '13.5px': 'var(--fz-body)', '14px': 'var(--fz-body)',
    '16px': 'var(--fz-title)', '22px': 'var(--fz-d3)', '30px': 'var(--fz-d2)', '46px': 'var(--fz-d1)',
}
# 3-5px radii are deliberately NOT mapped: on 7-10px-tall meter bars a 6px
# radius clamps to half-height and turns the bar into a pill (verify finding).
BR = {
    '6px': 'var(--r-sm)', '7px': 'var(--r-sm)',
    '8px': 'var(--radius)', '9px': 'var(--radius)', '10px': 'var(--radius)',
    '12px': 'var(--radius-lg)', '13px': 'var(--radius-lg)', '14px': 'var(--radius-lg)',
    '16px': 'var(--radius-lg)', '17px': 'var(--radius-lg)', '999px': 'var(--r-pill)',
}
MONO_LITS = [
    "\"ui-monospace, 'SF Mono', Menlo, monospace\"",
    "'ui-monospace, \"SF Mono\", Menlo, monospace'",
]

stats = collections.Counter()
for f in sorted(ROOT.rglob('*.js')):
    if f.name in EXCLUDE:
        continue
    src = f.read_text()
    orig = src
    for px, var in FZ.items():
        for q in ("'", '"'):
            pat = re.compile(r'(fontSize:\s*)' + q + re.escape(px) + q)
            src, n = pat.subn(r"\1'" + var + "'", src)
            stats['fontSize'] += n
    for px, var in BR.items():
        for q in ("'", '"'):
            pat = re.compile(r'(borderRadius:\s*)' + q + re.escape(px) + q)
            src, n = pat.subn(r"\1'" + var + "'", src)
            stats['borderRadius'] += n
    # bare-number radii (React treats numbers as px)
    def br_num(m):
        px = m.group(2) + 'px'
        if px in BR:
            stats['borderRadius'] += 1
            return m.group(1) + "'" + BR[px] + "'" + m.group(3)
        return m.group(0)
    src = re.sub(r'(borderRadius:\s*)(\d+)(\s*[,}\)])', br_num, src)
    for lit in MONO_LITS:
        n = src.count(lit)
        if n:
            src = src.replace(lit, "'var(--font-mono)'")
            stats['mono'] += n
    for hexv, var in (() if f.name in HEX_EXCLUDE else (("'#F05423'", "'var(--accent)'"), ("'#F8703B'", "'var(--accent-hover)'"),
                      ('"#F05423"', "'var(--accent)'"), ('"#F8703B"', "'var(--accent-hover)'"))):
        n = src.count(hexv)
        if n:
            src = src.replace(hexv, var)
            stats['brand-hex'] += n
    if src != orig:
        f.write_text(src)
        stats['files'] += 1
print(dict(stats))
