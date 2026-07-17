// Acceptance tests for the bonus calc engine (spec §7, tests 1-3 + math edges).
// Run: node scripts/test-bonus-calc.js  — exits non-zero on any failure.
const { computeRun, round2 } = require('../server/lib/bonusCalc');

let failures = 0;
const eq = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${pass ? '✓' : '✗'} ${label}: got ${JSON.stringify(got)}${pass ? '' : ` want ${JSON.stringify(want)}`}`);
  if (!pass) failures++;
};

const v2 = {
  base_rate: 0.005, stretch_rate: 0.0075, stretch_threshold: 1.10,
  efficiency_enabled: true, group_floor: 0.90, multiplier_hard_min: 0.50,
};
const crew = [
  { id: 'h', name: 'Hayden', role: 'tech', efficiency_floor: null },
  { id: 'k', name: 'Keith', role: 'tech', efficiency_floor: null },
  { id: 's', name: 'Scott', role: 'tech', efficiency_floor: null },
  { id: 't', name: 'Stephane', role: 'tech', efficiency_floor: null },
  { id: 'a', name: 'Stu', role: 'advisor', efficiency_floor: null },
];
// billed/clocked pairs that produce 96/93/88/76%
const eff = {
  h: { billed_hours: 96, clocked_hours: 100 },
  k: { billed_hours: 93, clocked_hours: 100 },
  s: { billed_hours: 88, clocked_hours: 100 },
  t: { billed_hours: 76, clocked_hours: 100 },
};

console.log('— Test 1: June 2026 replay —');
const june = computeRun({ revenue: 199129, target: 190250, netProfit: 67188, formula: v2, people: crew, efficiency: eff });
eq('tier', june.tier, 'base');
eq('rate', june.rate, 0.005);
eq('stretch needed', june.stretch_needed, 209275);
eq('shares', june.lines.map(l => l.calculated), [335.94, 335.94, 328.47, 283.68, 335.94]);
eq('total', june.total, 1619.97);
eq('multipliers(2dp)', june.lines.map(l => l.multiplier == null ? null : round2(l.multiplier)), [1, 1, 0.98, 0.84, null]);

console.log('— Test 2: stretch case (program doc example 2) —');
const stretch = computeRun({
  revenue: 121000, target: 110000, netProfit: 33000, formula: v2, people: crew,
  efficiency: { h: { billed_hours: 100, clocked_hours: 100 }, k: { billed_hours: 100, clocked_hours: 100 }, s: { billed_hours: 100, clocked_hours: 100 }, t: { billed_hours: 100, clocked_hours: 100 } },
});
eq('tier', stretch.tier, 'stretch');
eq('per-person at 1.0', [...new Set(stretch.lines.map(l => l.calculated))], [247.5]);

console.log('— Test 3: target missed —');
const missed = computeRun({ revenue: 150000, target: 190250, netProfit: 60000, formula: v2, people: crew, efficiency: eff });
eq('tier', missed.tier, 'none');
eq('all zero', missed.lines.every(l => l.calculated === 0), true);
eq('total zero', missed.total, 0);

console.log('— Edge: hard minimum clamps multiplier —');
const low = computeRun({ revenue: 200000, target: 190250, netProfit: 60000, formula: v2, people: [crew[0]], efficiency: { h: { billed_hours: 30, clocked_hours: 100 } } });
eq('clamped to 0.5', round2(low.lines[0].multiplier), 0.5);

console.log('— Edge: missing efficiency input reported —');
const miss = computeRun({ revenue: 200000, target: 190250, netProfit: 60000, formula: v2, people: crew, efficiency: { h: eff.h, k: eff.k, s: eff.s } });
eq('missing lists Stephane', miss.missing.map(m => m.name), ['Stephane']);

console.log('— Edge: efficiency disabled = flat shares —');
const flat = computeRun({ revenue: 199129, target: 190250, netProfit: 67188, formula: { ...v2, efficiency_enabled: false }, people: crew, efficiency: {} });
eq('all flat', [...new Set(flat.lines.map(l => l.calculated))], [335.94]);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
