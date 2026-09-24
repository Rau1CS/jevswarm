/**
 * Static world layout: terrain height field, roads, buildings, vegetation.
 * Pure data (no rendering) so the fire model, sensors and renderer share one truth.
 */
import { BASE_POS, LAKE, SAFE_ZONE } from '../config';
import { Rng, clamp, fbm, smoothstep } from '../core/math';

export interface Pt { x: number; z: number }
export interface Road { id: string; name: string; pts: Pt[]; evac: boolean; width: number }
export interface Building {
  id: string;
  x: number; z: number;
  w: number; d: number; h: number;
  rot: number;
  roof: number; // roof color index
}

export const VILLAGE = { x: 60, z: -60, r: 330 };
export const HERO_BUILDING_POS = { x: -205, z: -100 };

const flat = (x: number, z: number, cx: number, cz: number, r: number, soft: number) =>
  1 - smoothstep(r, r + soft, Math.hypot(x - cx, z - cz));

/** Terrain height in metres. Deterministic, continuous. */
export function heightAt(x: number, z: number): number {
  const n = fbm(x / 520 + 11.3, z / 520 + 4.1, 5, 3);
  const ridge = smoothstep(-200, -900, z) * 95 + smoothstep(-300, -950, x) * 40;
  let h = 18 + (n - 0.45) * 150 + ridge;
  h += fbm(x / 90, z / 90, 2, 9) * 6;
  const vil = flat(x, z, VILLAGE.x, VILLAGE.z, VILLAGE.r * 0.75, 260);
  h = h * (1 - vil) + (22 + (n - 0.45) * 30) * vil;
  const base = flat(x, z, BASE_POS.x, BASE_POS.z, 90, 140);
  h = h * (1 - base) + 16 * base;
  const safe = flat(x, z, SAFE_ZONE.x, SAFE_ZONE.z, SAFE_ZONE.r, 160);
  h = h * (1 - safe) + 14 * safe;
  const lake = flat(x, z, LAKE.x, LAKE.z, LAKE.r * 1.25, 200);
  h = h * (1 - lake) + (4 - flat(x, z, LAKE.x, LAKE.z, LAKE.r * 0.8, 60) * 10) * lake;
  return Math.max(h, -8);
}
export const WATER_LEVEL = 3;

export const ROADS: Road[] = [
  {
    id: 'R1', name: 'Main road', evac: true, width: 9,
    pts: [
      { x: -640, z: 640 }, { x: -470, z: 470 }, { x: -300, z: 250 }, { x: -170, z: 60 },
      { x: 0, z: -20 }, { x: 240, z: -80 }, { x: 520, z: -330 }, { x: 760, z: -560 }, { x: 990, z: -700 },
    ],
  },
  {
    id: 'R2', name: 'Evacuation road', evac: true, width: 8,
    pts: [{ x: 60, z: -20 }, { x: 180, z: 120 }, { x: 330, z: 290 }, { x: 500, z: 460 }, { x: 690, z: 620 }],
  },
  {
    id: 'R3', name: 'North forest track', evac: false, width: 5,
    pts: [{ x: 0, z: -20 }, { x: -60, z: -260 }, { x: -40, z: -520 }, { x: 60, z: -760 }, { x: 40, z: -990 }],
  },
  {
    id: 'R4', name: 'Village lane', evac: false, width: 6,
    pts: [{ x: -250, z: -140 }, { x: -110, z: -170 }, { x: 60, z: -190 }, { x: 250, z: -90 }],
  },
  {
    id: 'R5', name: 'West lane', evac: false, width: 5,
    pts: [{ x: -170, z: 60 }, { x: -230, z: -40 }, { x: -250, z: -140 }],
  },
];

function distToSeg(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const vx = b.x - a.x, vz = b.z - a.z;
  const len2 = vx * vx + vz * vz || 1;
  const t = clamp(((p.x - a.x) * vx + (p.z - a.z) * vz) / len2, 0, 1);
  return { d: Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t)), t };
}
export function distToRoad(x: number, z: number, road?: Road): number {
  let best = Infinity;
  for (const r of road ? [road] : ROADS) {
    for (let i = 0; i < r.pts.length - 1; i++) best = Math.min(best, distToSeg({ x, z }, r.pts[i], r.pts[i + 1]).d);
  }
  return best;
}

function buildBuildings(): Building[] {
  const rng = new Rng(4242);
  const out: Building[] = [];
  const place = (x: number, z: number, rot: number) => {
    if (out.some((b) => Math.hypot(b.x - x, b.z - z) < 30)) return;
    if (distToRoad(x, z) < 12) return;
    out.push({
      id: `B${String(out.length + 1).padStart(2, '0')}`,
      x, z, rot,
      w: rng.range(12, 20), d: rng.range(10, 15), h: rng.range(5, 9),
      roof: rng.int(0, 3),
    });
  };
  // Hero building first: western edge of the village, in sector D4.
  place(HERO_BUILDING_POS.x, HERO_BUILDING_POS.z, 0.3);
  const segs: [Pt, Pt][] = [];
  for (const r of ROADS) {
    if (r.id === 'R3') continue;
    for (let i = 0; i < r.pts.length - 1; i++) segs.push([r.pts[i], r.pts[i + 1]]);
  }
  for (let tries = 0; tries < 400 && out.length < 22; tries++) {
    const [a, b] = rng.pick(segs);
    const t = rng.next();
    const x0 = a.x + (b.x - a.x) * t, z0 = a.z + (b.z - a.z) * t;
    if (Math.hypot(x0 - VILLAGE.x, z0 - VILLAGE.z) > VILLAGE.r) continue;
    const ang = Math.atan2(b.z - a.z, b.x - a.x);
    const side = rng.chance(0.5) ? 1 : -1;
    const off = rng.range(24, 42) * side;
    place(x0 - Math.sin(ang) * off, z0 + Math.cos(ang) * off, -ang + rng.range(-0.08, 0.08));
  }
  // A farmhouse and a forest cabin add isolated rescue targets.
  place(360, 330, 0.8);
  place(-300, -420, -0.4);
  place(560, -150, 0.2);
  return out;
}
export const BUILDINGS: Building[] = buildBuildings();

/** Vegetation fuel density 0..1 (0 = non-burnable). */
export function vegetationAt(x: number, z: number): number {
  if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r) return 0;
  if (heightAt(x, z) < WATER_LEVEL + 0.5) return 0;
  const road = distToRoad(x, z);
  if (road < 7) return 0;
  if (Math.hypot(x - BASE_POS.x, z - BASE_POS.z) < 110) return 0.05;
  if (Math.hypot(x - SAFE_ZONE.x, z - SAFE_ZONE.z) < SAFE_ZONE.r + 20) return 0;
  const n = fbm(x / 260 + 3, z / 260 - 7, 4, 21);
  let forest = smoothstep(0.38, 0.6, n);
  // Open fields: south-east plain between village and safe zone, and a meadow in the west.
  const field = Math.max(
    flat(x, z, 380, 330, 230, 120),
    flat(x, z, -380, 420, 150, 90),
    flat(x, z, 250, 620, 200, 120),
  );
  forest *= 1 - field;
  const vil = flat(x, z, VILLAGE.x, VILLAGE.z, VILLAGE.r * 0.65, 160);
  let v = 0.22 + forest * 0.78;
  v = v * (1 - vil) + 0.3 * vil; // gardens
  return clamp(v, 0, 1);
}
/** True if the location reads as forest (for tree placement). */
export function isForest(x: number, z: number): boolean {
  const v = vegetationAt(x, z);
  return v > 0.55 && distToRoad(x, z) > 14 && !BUILDINGS.some((b) => Math.hypot(b.x - x, b.z - z) < 22);
}

/** Polyline length helpers for vehicles and evacuation routing. */
export function polyLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
  return L;
}
export function pointAlong(pts: Pt[], s: number): Pt & { ang: number } {
  let rem = s;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (rem <= L || i === pts.length - 2) {
      const t = clamp(rem / (L || 1), 0, 1);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, ang: Math.atan2(b.z - a.z, b.x - a.x) };
    }
    rem -= L;
  }
  const last = pts[pts.length - 1];
  return { ...last, ang: 0 };
}
