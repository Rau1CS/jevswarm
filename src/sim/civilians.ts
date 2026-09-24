/**
 * Civilians: hidden ground truth. Jev only learns about them through detections.
 */
import { SAFE_ZONE } from '../config';
import { Rng, dist2 } from '../core/math';
import { BUILDINGS, HERO_BUILDING_POS, ROADS, VILLAGE, type Pt } from '../world/layout';
import type { FireModel } from './fire';

export type CivBehavior = 'SHELTER' | 'EVACUATE' | 'TRAPPED' | 'WANDER' | 'GUIDED' | 'SAFE';

export interface Civilian {
  id: string;
  x: number; z: number;
  heading: number;
  behavior: CivBehavior;
  indoor: boolean;
  path: Pt[];
  pathI: number;
  speed: number;
  confirmed: boolean;
  confirmedAt: number;
  spawnedAt: number;
  exposed: boolean;
  hero: boolean;
  supplied: boolean;
  walkPhase: number;
}

function evacPath(x: number, z: number): Pt[] {
  // Nearest vertex on the evacuation road, then follow it to the safe zone.
  const r2 = ROADS.find((r) => r.id === 'R2')!;
  let best = 0, bd = Infinity;
  r2.pts.forEach((p, i) => {
    const d = dist2(x, z, p.x, p.z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return [...r2.pts.slice(best), { x: SAFE_ZONE.x, z: SAFE_ZONE.z }];
}

export function spawnCivilians(rng: Rng, count: number, heroScenario: boolean): Civilian[] {
  const out: Civilian[] = [];
  const mk = (x: number, z: number, behavior: CivBehavior, indoor: boolean, hero = false): Civilian => ({
    id: `P${String(out.length + 1).padStart(2, '0')}`,
    x, z, heading: rng.range(0, 6.28), behavior, indoor,
    path: behavior === 'EVACUATE' ? evacPath(x, z) : [],
    pathI: 0,
    speed: rng.range(1.1, 1.6),
    confirmed: false, confirmedAt: 0, spawnedAt: 0, exposed: false, hero, supplied: false,
    walkPhase: rng.range(0, 6),
  });
  if (heroScenario) out.push(mk(HERO_BUILDING_POS.x + 16, HERO_BUILDING_POS.z + 10, 'TRAPPED', false, true));
  const behaviors: CivBehavior[] = ['SHELTER', 'SHELTER', 'EVACUATE', 'EVACUATE', 'WANDER', 'TRAPPED'];
  let guard = 0;
  while (out.length < count && guard++ < 500) {
    const b = rng.pick(BUILDINGS);
    const beh = rng.pick(behaviors);
    if (beh === 'WANDER') {
      // Someone out in the forest or fields (hiker, farmer).
      const a = rng.range(0, 6.28), r = rng.range(300, 700);
      out.push(mk(VILLAGE.x + Math.cos(a) * r, VILLAGE.z + Math.sin(a) * r, 'WANDER', false));
      continue;
    }
    if (out.some((c) => dist2(c.x, c.z, b.x, b.z) < 10) && beh === 'SHELTER') continue;
    const off = beh === 'SHELTER' ? 0 : rng.range(12, 22);
    const a = rng.range(0, 6.28);
    out.push(mk(b.x + Math.cos(a) * off, b.z + Math.sin(a) * off, beh, beh === 'SHELTER'));
  }
  return out;
}

export function updateCivilian(c: Civilian, dt: number, fire: FireModel, rng: Rng): void {
  if (fire.intensityAt(c.x, c.z) > 0.3) c.exposed = true;
  if (c.behavior === 'SAFE' || c.behavior === 'SHELTER') return;
  if (dist2(c.x, c.z, SAFE_ZONE.x, SAFE_ZONE.z) < SAFE_ZONE.r * 0.7) {
    c.behavior = 'SAFE';
    return;
  }
  if (c.behavior === 'TRAPPED') {
    // Small anxious movements; stays put.
    c.walkPhase += dt * 0.5;
    return;
  }
  if (c.behavior === 'WANDER') {
    c.heading += rng.range(-0.6, 0.6) * dt;
    step(c, Math.cos(c.heading), Math.sin(c.heading), c.speed * 0.6, dt);
    if (fire.intensityAt(c.x + Math.cos(c.heading) * 40, c.z + Math.sin(c.heading) * 40) > 0.1) c.heading += Math.PI * 0.7;
    return;
  }
  // EVACUATE / GUIDED: follow path.
  const p = c.path[c.pathI];
  if (!p) return;
  const dx = p.x - c.x, dz = p.z - c.z;
  const d = Math.hypot(dx, dz);
  if (d < 4) {
    c.pathI++;
    return;
  }
  // Evacuees stop if fire blocks the way ahead (GUIDED routes were planned around it).
  if (c.behavior === 'EVACUATE' && fire.intensityAt(c.x + (dx / d) * 35, c.z + (dz / d) * 35) > 0.15) {
    c.behavior = 'TRAPPED';
    return;
  }
  c.heading = Math.atan2(dz, dx);
  step(c, dx / d, dz / d, c.behavior === 'GUIDED' ? 2.2 : c.speed, dt);
}

function step(c: Civilian, ux: number, uz: number, v: number, dt: number) {
  c.x += ux * v * dt;
  c.z += uz * v * dt;
  c.walkPhase += dt * v * 3;
  c.indoor = false;
}

export function startGuided(c: Civilian, route: Pt[]): void {
  c.behavior = 'GUIDED';
  c.path = route;
  c.pathI = 0;
  c.indoor = false;
}
