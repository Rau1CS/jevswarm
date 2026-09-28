/**
 * Suppression lab: run the same scenario headless under several tasking policies and
 * compare outcomes. Uses the deterministic fallback coordinator (no Jev calls, no token
 * spend) and no random disruption events, so differences come from the policy alone.
 */
import { setupScenario, type SuppressionSetup } from '../app/scenarios';
import { Simulation, type Policy } from '../sim/simulation';
import type { SuppressionSummary } from '../sim/ledger';

export interface RunResult {
  policy: Policy;
  seed: number;
  areaHa: number;
  burningCells: number;
  frontKm: number;
  containment: number;
  villageBurnt: boolean;
  confirmed: number;
  sup: SuppressionSummary;
}

export interface PolicyRow {
  policy: Policy;
  runs: number;
  areaHa: number;
  frontKm: number;
  outRate: number; // share of runs with no active fire at the end
  knockdowns: number;
  reignitions: number;
  onTarget: number;
  effectivePct: number;
  throughputPerMin: number;
  meanCycleSec: number;
  meanQueueSec: number;
  firstEffectiveSec: number;
  costTotal: number;
  /** Area saved vs the NONE baseline (ha), and cost per hectare saved. */
  savedHa: number;
  costPerHaSaved: number;
}

export const POLICIES: Policy[] = ['NONE', 'NEAREST', 'COORDINATOR'];

function finish(sim: Simulation, policy: Policy, seed: number): RunResult {
  const st = sim.fire.stats();
  const r = sim.results();
  return {
    policy, seed,
    areaHa: st.areaHa,
    burningCells: st.burningCells,
    frontKm: st.frontKm,
    containment: st.containment,
    villageBurnt: false,
    confirmed: r.confirmed,
    sup: r.suppression,
  };
}

function makeSim(setup: SuppressionSetup, drones: number, seed: number, policy: Policy): Simulation {
  const sim = new Simulation(setupScenario(drones, { ...setup, policy }, seed));
  sim.launchAll(sim.t + 2, 0.3);
  return sim;
}

/** Synchronous run (tests / CLI). */
export function runHeadless(setup: SuppressionSetup, drones: number, seed: number, policy: Policy, durationSec: number): RunResult {
  const sim = makeSim(setup, drones, seed, policy);
  const steps = Math.round(durationSec * 30);
  for (let i = 0; i < steps; i++) sim.step(1 / 30);
  return finish(sim, policy, seed);
}

/** Browser run: yields to the UI between chunks. */
export async function runChunked(
  setup: SuppressionSetup, drones: number, seed: number, policy: Policy, durationSec: number,
  progress: (f: number) => void, cancelled: () => boolean,
): Promise<RunResult | null> {
  const sim = makeSim(setup, drones, seed, policy);
  const steps = Math.round(durationSec * 30);
  for (let i = 0; i < steps; i++) {
    sim.step(1 / 30);
    if (i % 600 === 0) {
      progress(i / steps);
      await new Promise((r) => setTimeout(r, 0));
      if (cancelled()) return null;
    }
  }
  return finish(sim, policy, seed);
}

export function aggregate(results: RunResult[]): PolicyRow[] {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const finite = (xs: number[]) => xs.filter(Number.isFinite);
  const none = results.filter((r) => r.policy === 'NONE');
  const baseArea = none.length ? mean(none.map((r) => r.areaHa)) : NaN;
  return POLICIES.filter((p) => results.some((r) => r.policy === p)).map((policy) => {
    const rs = results.filter((r) => r.policy === policy);
    const area = mean(rs.map((r) => r.areaHa));
    const cost = mean(rs.map((r) => r.sup.costTotal));
    const saved = Number.isFinite(baseArea) ? baseArea - area : NaN;
    return {
      policy,
      runs: rs.length,
      areaHa: area,
      frontKm: mean(rs.map((r) => r.frontKm)),
      outRate: rs.filter((r) => r.burningCells === 0).length / rs.length,
      knockdowns: mean(rs.map((r) => r.sup.knockdowns)),
      reignitions: mean(rs.map((r) => r.sup.reignitions)),
      onTarget: mean(rs.map((r) => r.sup.onTarget)),
      effectivePct: mean(rs.map((r) => r.sup.effectivePct)),
      throughputPerMin: mean(rs.map((r) => r.sup.throughputPerMin)),
      meanCycleSec: mean(rs.map((r) => r.sup.meanCycleSec)),
      meanQueueSec: mean(rs.map((r) => r.sup.meanQueueSec)),
      firstEffectiveSec: finite(rs.map((r) => r.sup.firstEffectiveSec)).length ? mean(finite(rs.map((r) => r.sup.firstEffectiveSec))) : NaN,
      costTotal: cost,
      savedHa: saved,
      costPerHaSaved: saved > 0.05 ? cost / saved : NaN,
    };
  });
}
