/** Scenario presets: the curated cinematic demo, and randomized free simulation. */
import { BASE_POS } from '../config';
import { Rng, dist2 } from '../core/math';
import { VILLAGE, vegetationAt } from '../world/layout';
import type { Policy, ScenarioOpts } from '../sim/simulation';
import type { AgentId, PlatformId } from '../sim/loadout/catalogue';

export type ScenarioKind = 'ESTABLISHED' | 'INITIAL_ATTACK';
export interface SuppressionSetup {
  platform: PlatformId;
  agent: AgentId;
  scenario: ScenarioKind;
  forward: boolean;
  policy?: Policy;
  /** Initial attack only: seconds from ignition to swarm dispatch (SIM detection + dispatch delay). */
  detectSec?: number;
  /** Initial attack only: fuel dryness multiplier on spread rate (SIM). */
  dryness?: number;
  /** SIM knockdown density for plain water (L/m²); the most influential uncalibrated parameter. */
  knockdownDensity?: number;
}

export function demoScenario(drones: number): ScenarioOpts {
  return {
    seed: 1337,
    drones,
    civilians: 14,
    hero: true,
    fireOrigin: { x: -760, z: -80 },
    wind: { fromDeg: 210, speed: 6 },
    sensorQuality: 1,
  };
}

/** Free simulation with a chosen loadout: an established fire, or an initial-attack incident. */
export function setupScenario(drones: number, set: SuppressionSetup, seed = (Math.random() * 1e9) | 0): ScenarioOpts {
  const base = set.scenario === 'INITIAL_ATTACK' ? initialAttackScenario(drones, seed, set.detectSec, set.dryness) : freeScenario(drones, seed);
  const o = base.fireOrigin;
  // Forward refill truck: on the line from the fire toward the command post, ~350 m from the origin.
  const d = dist2(o.x, o.z, BASE_POS.x, BASE_POS.z) || 1;
  const k = Math.min(0.8, 350 / d);
  return {
    ...base,
    loadout: { platform: set.platform, agent: set.platform === 'CONCEPT120' ? 'ABSTRACT' : set.agent },
    policy: set.policy ?? 'COORDINATOR',
    knockdownDensity: set.knockdownDensity,
    crn: true, // physical-loadout runs use common random numbers so policies can be compared
    forwardStation: set.forward ? { x: o.x + (BASE_POS.x - o.x) * k, z: o.z + (BASE_POS.z - o.z) * k } : null,
  };
}

/**
 * Initial attack (SIM): a small, newly detected ignition in moderate conditions, plus two spot
 * fires downwind. Tests the proposition "a coordinated swarm keeps a small ignition small".
 */
export function initialAttackScenario(drones: number, seed = (Math.random() * 1e9) | 0, detectSec = 60, dryness = 0.45): ScenarioOpts {
  const f = freeScenario(drones, seed);
  const rng = new Rng(seed + 77);
  const w = f.wind.fromDeg * Math.PI / 180;
  const toward = { x: -Math.sin(w), z: Math.cos(w) };
  const spot = (t: number, dist: number) => ({ t, x: f.fireOrigin.x + toward.x * dist + rng.range(-40, 40), z: f.fireOrigin.z + toward.z * dist + rng.range(-40, 40) });
  return {
    ...f,
    name: 'Initial attack',
    civilians: rng.int(4, 8),
    wind: { fromDeg: f.wind.fromDeg, speed: rng.range(2.5, 4) },
    preburnSec: detectSec, // SIM: detection + dispatch delay
    ignitionRadius: 10,
    spreadMult: dryness, // SIM: 0.45 ≈ moderate fuel moisture (not peak dry season)
    spotFires: [spot(160, rng.range(140, 220)), spot(320, rng.range(200, 300))],
    mix: [0.25, 0.59, 0.04, 0.12],
  };
}

export function freeScenario(drones: number, seed = (Math.random() * 1e9) | 0): ScenarioOpts {
  const rng = new Rng(seed);
  let origin = { x: -700, z: -300 };
  for (let i = 0; i < 400; i++) {
    const x = rng.range(-900, 900), z = rng.range(-900, 900);
    if (vegetationAt(x, z) < 0.6) continue;
    const dv = dist2(x, z, VILLAGE.x, VILLAGE.z);
    if (dv < 480 || dv > 950 || dist2(x, z, BASE_POS.x, BASE_POS.z) < 650) continue;
    origin = { x, z };
    break;
  }
  // Wind blowing roughly toward the village keeps free runs eventful.
  const toward = (Math.atan2(VILLAGE.x - origin.x, -(VILLAGE.z - origin.z)) * 180) / Math.PI;
  const from = (toward + 180 + rng.range(-70, 70) + 360) % 360;
  return {
    seed,
    drones,
    civilians: rng.int(10, 20),
    hero: false,
    fireOrigin: origin,
    wind: { fromDeg: from, speed: rng.range(4.5, 7.5) },
    sensorQuality: rng.range(0.75, 1),
    name: 'Established fire',
  };
}
