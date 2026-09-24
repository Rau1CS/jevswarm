import { HALF, SECTOR_N, SECTOR_ROWS, SECTOR_SIZE } from '../config';

/** Mulberry32 seeded RNG — deterministic scenarios for the cinematic demo. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Hash-based 2D value noise with fbm — cheap and deterministic. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
export function valueNoise(x: number, y: number, seed = 1): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
export function fbm(x: number, y: number, oct = 4, seed = 1): number {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * valueNoise(x * f, y * f, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return v / norm;
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const dist2 = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

/** Sector label for a world position, e.g. "D4". */
export function sectorOf(x: number, z: number): string {
  const c = clamp(Math.floor((x + HALF) / SECTOR_SIZE), 0, SECTOR_N - 1);
  const r = clamp(Math.floor((z + HALF) / SECTOR_SIZE), 0, SECTOR_N - 1);
  return `${SECTOR_ROWS[r]}${c + 1}`;
}
export function sectorCenter(label: string): { x: number; z: number } {
  const r = SECTOR_ROWS.indexOf(label[0]);
  const c = Number(label.slice(1)) - 1;
  return { x: -HALF + (c + 0.5) * SECTOR_SIZE, z: -HALF + (r + 0.5) * SECTOR_SIZE };
}
export function allSectors(): string[] {
  const out: string[] = [];
  for (let r = 0; r < SECTOR_N; r++) for (let c = 0; c < SECTOR_N; c++) out.push(`${SECTOR_ROWS[r]}${c + 1}`);
  return out;
}

/** Meteorological wind "from" degrees → unit vector the air moves toward (x east, z south). */
export function windToward(fromDeg: number): { x: number; z: number } {
  const toward = ((fromDeg + 180) * Math.PI) / 180;
  return { x: Math.sin(toward), z: -Math.cos(toward) };
}
/** Compass bearing (0=N, 90=E) of a direction vector. */
export function bearing(dx: number, dz: number): number {
  const b = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return (b + 360) % 360;
}
export function compassName(deg: number): string {
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return names[Math.round(deg / 45) % 8];
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export function angleLerp(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
