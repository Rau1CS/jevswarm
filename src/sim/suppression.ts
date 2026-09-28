/**
 * Physical suppressant application (SIM, uncalibrated). Separates three quantities:
 *   released  — agent leaving the nozzle
 *   onTarget  — the part landing on the intended fuel (aim × agent cohesion × wind)
 *   effective — the on-target part that landed on flaming fuel (DIRECT) or unburned fuel (PRETREAT)
 * Foam expansion is never used as a multiplier: capacity and cooling come from the liquid carried.
 */
import { FIRE_CELL, FIRE_N } from '../config';
import { clamp, windToward } from '../core/math';
import { BURNING, UNBURNED, type FireModel } from './fire';
import { landingFraction, type Loadout } from './loadout/catalogue';

export const CELL_AREA = FIRE_CELL * FIRE_CELL;
/**
 * SIM: application density (L/m² of plain water) that knocks down flaming fuel at full intensity.
 * 1 L/m² is the research worked example's *test loading*, not a validated extinguishment threshold.
 */
export const BASE_REQ_DENSITY = 1.0;

export interface Application {
  released: number;
  onTarget: number;
  effective: number;
  knocked: boolean;
  cell: number;
  intensityBefore: number;
  intensityAfter: number;
}

/** Hottest burning cell within `radius` of (x, z) — onboard thermal targeting. -1 if none. */
export function hottestCell(fire: FireModel, x: number, z: number, radius: number): number {
  const r = Math.ceil(radius / FIRE_CELL);
  const c = fire.cellOf(x, z);
  const ci = c % FIRE_N, cj = (c / FIRE_N) | 0;
  let best = -1, bestI = 0;
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    const i = ci + di, j = cj + dj;
    if (i < 0 || j < 0 || i >= FIRE_N || j >= FIRE_N || Math.hypot(di, dj) * FIRE_CELL > radius) continue;
    const k = j * FIRE_N + i;
    if (fire.state[k] !== BURNING) continue;
    // Prefer intense cells with little treatment already on them.
    const score = fire.intensity[k] * (1 - fire.cover[k]);
    if (score > bestI) { bestI = score; best = k; }
  }
  return best;
}

/** Required density (L/m²) to knock down flaming fuel of intensity I with this agent. */
export function requiredDensity(l: Loadout, I: number, base = BASE_REQ_DENSITY): number {
  return (base * (0.3 + 0.7 * I)) / l.agent.contact.v;
}

/** Release `litres` of the loadout's agent aimed at (x, z). Mutates the fire model. */
export function applyAgent(fire: FireModel, l: Loadout, x: number, z: number, litres: number, base = BASE_REQ_DENSITY): Application {
  const a = l.agent;
  const onTarget = litres * landingFraction(l, fire.wind.speed);
  const direct = a.mission === 'DIRECT';
  const hot = direct ? hottestCell(fire, x, z, 24) : -1;
  const k = hot >= 0 ? hot : fire.cellOf(x, z);
  const res: Application = { released: litres, onTarget, effective: 0, knocked: false, cell: k, intensityBefore: fire.intensity[k], intensityAfter: fire.intensity[k] };
  deposit(fire, k, onTarget, l);
  // Drift: half of the miss lands one cell downwind as light wetting (never counted as effective).
  const w = windToward(fire.wind.fromDeg);
  const dk = fire.cellOf(fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0).x + w.x * FIRE_CELL, fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0).z + w.z * FIRE_CELL);
  if (dk !== k) deposit(fire, dk, (litres - onTarget) * 0.5, l);

  if (direct) {
    if (fire.state[k] === BURNING) {
      res.effective = onTarget;
      const I = fire.intensity[k];
      const frac = onTarget / (requiredDensity(l, I, base) * CELL_AREA * Math.max(0.2, fire.fuel0[k]));
      const c0 = fire.cover[k];
      const c1 = Math.min(1, c0 + frac);
      fire.cover[k] = c1;
      fire.coverWater[k] = a.water.v;
      fire.intensity[k] = I * clamp((1 - c1) / Math.max(0.02, 1 - c0), 0, 1);
      if (c1 >= 0.93 || fire.intensity[k] < 0.07) {
        fire.knockDown(k, a.residualHeat.v);
        res.knocked = true;
      }
    } else if (fire.state[k] === UNBURNED && fire.fuel[k] > 0.08) {
      // Pre-wetting fuel next to the fire: counts as coverage at the lower no-flame density.
      fire.cover[k] = Math.min(1, fire.cover[k] + onTarget / (requiredDensity(l, 0, base) * CELL_AREA));
      fire.coverWater[k] = a.water.v;
    }
  } else if (fire.state[k] === UNBURNED && fire.fuel[k] > 0.08) {
    res.effective = onTarget;
  }
  res.intensityAfter = fire.intensity[k];
  fire.commit();
  return res;
}

function deposit(fire: FireModel, k: number, litres: number, l: Loadout): void {
  if (litres <= 0) return;
  const a = l.agent;
  const water = (litres * a.water.v) / CELL_AREA;
  if (water > 0) {
    const w0 = fire.water[k];
    fire.retain[k] = (fire.retain[k] * w0 + a.retention.v * water) / (w0 + water);
    fire.water[k] = w0 + water;
  }
  if (a.salts.v > 0) fire.salts[k] += (litres * a.salts.v) / CELL_AREA;
}
