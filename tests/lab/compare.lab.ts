/**
 * `npm run lab` — headless policy comparison across loadouts (fallback coordinator, no Jev calls).
 * Prints tables; not part of the default test suite.
 */
import { appendFileSync } from 'node:fs';
import { it } from 'vitest';
import { aggregate, POLICIES, runHeadless, type RunResult } from '../../src/lab/experiment';
import type { SuppressionSetup } from '../../src/app/scenarios';
import type { AgentId, PlatformId } from '../../src/sim/loadout/catalogue';

const DRONES = Number(process.env.LAB_DRONES ?? 24);
const SEEDS = (process.env.LAB_SEEDS ?? '11,12,13').split(',').map(Number);
const DURATION = Number(process.env.LAB_SEC ?? 600);
const SCENARIO = (process.env.LAB_SCENARIO ?? 'INITIAL_ATTACK') as SuppressionSetup['scenario'];
const CASES: [PlatformId, AgentId, boolean][] = (process.env.LAB_CASES ?? 'HEAVY:WATER:0,HEAVY:FOAM_A:0,HEAVY:GEL:0,HEAVY:WATER:1,X500:WATER:0,HEAVY:LTR:0,HEAVY:DRY_CHEM:0')
  .split(',').map((c) => { const [p, a, f] = c.split(':'); return [p as PlatformId, a as AgentId, f === '1']; });

it('suppression lab', { timeout: 3_600_000 }, () => {
  for (const [platform, agent, forward] of CASES) {
    const setup: SuppressionSetup = { platform, agent, scenario: SCENARIO, forward, detectSec: Number(process.env.LAB_DETECT ?? 60), dryness: Number(process.env.LAB_DRY ?? 0.45), knockdownDensity: Number(process.env.LAB_KD ?? 1) };
    const results: RunResult[] = [];
    for (const seed of SEEDS) for (const policy of POLICIES) results.push(runHeadless(setup, DRONES, seed, policy, DURATION));
    const head = `\n=== ${platform} · ${agent}${forward ? ' · forward refill' : ''} · ${SCENARIO} · ${DRONES} drones · seeds ${SEEDS.join('/')} · ${DURATION}s · detect ${setup.detectSec}s · dryness ${setup.dryness} · knockdown ${setup.knockdownDensity} L/m² ===`;
    const rows = aggregate(results).map((r) => ({
      policy: r.policy,
      'area ha': r.areaHa.toFixed(2),
      'fire out': `${Math.round(r.outRate * 100)}%`,
      'front km': r.frontKm.toFixed(2),
      'on-target': r.onTarget.toFixed(0),
      'effective %': Math.round(r.effectivePct * 100),
      'L/min': r.throughputPerMin.toFixed(1),
      'cycle s': r.meanCycleSec.toFixed(0),
      'queue s': r.meanQueueSec.toFixed(0),
      'first eff s': Number.isFinite(r.firstEffectiveSec) ? r.firstEffectiveSec.toFixed(0) : '—',
      knock: r.knockdowns.toFixed(0),
      reign: r.reignitions.toFixed(0),
      'cost $': r.costTotal.toFixed(0),
      'saved ha': Number.isFinite(r.savedHa) ? r.savedHa.toFixed(2) : '—',
      '$/ha saved': Number.isFinite(r.costPerHaSaved) ? r.costPerHaSaved.toFixed(0) : '—',
    }));
    console.log(head);
    console.table(rows);
    if (process.env.LAB_OUT) appendFileSync(process.env.LAB_OUT, `${head}\n${rows.map((r) => Object.values(r).join(' | ')).join('\n')}\n`);
  }
});
