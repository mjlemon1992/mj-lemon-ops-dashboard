// Pure bonus-run math for the profit-share program (see spec §1).
// Deliberately side-effect-free so the acceptance numbers can be verified in
// isolation (scripts/test-bonus-calc.js) and the route layer stays thin.
//
// Money rule (spec §6.8): round half-up at the LINE level; totals are the sum
// of the rounded lines. Rates/floors are fractions (0.005, 0.90), efficiencies
// are fractions (0.96) derived from billed ÷ clocked hours.

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// Which rate applies for the month: none (target missed), base, or stretch.
// The stretch boundary is compared in CENTS (round2) — raw float math makes
// 110000 × 1.10 = 121000.00000000001, which would deny stretch to a month
// that landed exactly on the line.
function rateFor(revenue, target, formula) {
  if (!(target > 0) || revenue < target) return { rate: 0, tier: 'none' };
  if (round2(revenue) >= round2(target * Number(formula.stretch_threshold))) {
    return { rate: Number(formula.stretch_rate), tier: 'stretch' };
  }
  return { rate: Number(formula.base_rate), tier: 'base' };
}

// A tech's multiplier against HIS OWN floor — never other techs (spec §1.6).
// eff >= floor -> 1.0; else linear eff/floor, clamped at the hard minimum.
function multiplierFor(eff, floor, hardMin) {
  if (eff == null || !(floor > 0)) return null;
  if (eff >= floor) return 1;
  return Math.max(Number(hardMin) || 0, eff / floor);
}

// Compute a full draft run.
//   people:      [{ id, name, role: 'tech'|'advisor', efficiency_floor|null }] (active only)
//   efficiency:  { [personId]: { billed_hours, clocked_hours } }  (techs)
// Returns { rate, tier, stretch_needed, lines, total, missing } where missing
// lists techs without efficiency input (caller decides block vs assume-1.0).
function computeRun({ revenue, target, netProfit, formula, people, efficiency, missingAsFull = false }) {
  const { rate, tier } = rateFor(Number(revenue), Number(target), formula);
  const stretchNeeded = target > 0 ? round2(Number(target) * Number(formula.stretch_threshold)) : null;
  const effOn = !!formula.efficiency_enabled;
  const missing = [];

  const lines = people.map((p) => {
    if (p.role === 'advisor') {
      // Advisor: always flat share, exempt from efficiency (spec §1.6).
      return {
        person_id: p.id, name: p.name, role_at_calc: 'advisor',
        efficiency: null, floor_used: null, multiplier: null,
        calculated: rate === 0 ? 0 : round2(Number(netProfit) * rate),
      };
    }
    const floorUsed = p.efficiency_floor != null ? Number(p.efficiency_floor) : Number(formula.group_floor);
    let eff = null, mult = null;
    if (effOn) {
      const e = efficiency[p.id];
      if (e && Number(e.clocked_hours) > 0) {
        eff = Number(e.billed_hours) / Number(e.clocked_hours);
        mult = multiplierFor(eff, floorUsed, formula.multiplier_hard_min);
      } else {
        missing.push({ person_id: p.id, name: p.name });
        if (missingAsFull) mult = 1;
      }
    } else {
      mult = 1;
    }
    const calculated = rate === 0 || mult == null ? 0 : round2(Number(netProfit) * rate * mult);
    return {
      person_id: p.id, name: p.name, role_at_calc: 'tech',
      efficiency: eff, floor_used: effOn ? floorUsed : null,
      multiplier: effOn ? mult : 1,
      calculated,
    };
  });

  const total = round2(lines.reduce((s, l) => s + l.calculated, 0));
  return { rate, tier, stretch_needed: stretchNeeded, lines, total, missing };
}

module.exports = { round2, rateFor, multiplierFor, computeRun };
