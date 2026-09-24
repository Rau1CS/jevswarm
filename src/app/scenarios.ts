/** Scenario presets: the curated cinematic demo, and randomized free simulation. */
import { BASE_POS } from '../config';
import { Rng, dist2 } from '../core/math';
import { VILLAGE, vegetationAt } from '../world/layout';
import type { ScenarioOpts } from '../sim/simulation';

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
  };
}
