/**
 * Deterministic planning helpers (plain code, no model): search patterns, safe-corridor
 * routing over the predicted fire-arrival field, relay placement, commander area mapping.
 */
import { BASE_POS, FIRE_CELL, FIRE_N, HALF, SAFE_ZONE, SECTOR_SIZE } from '../config';
import { allSectors, clamp, dist2, sectorCenter } from '../core/math';
import { VILLAGE, type Pt } from '../world/layout';
import { BURNING, type FireModel } from '../sim/fire';
import type { Area } from './types';

/** Lawnmower lanes across a sector. */
export function searchPattern(sector: string, laneSpacing = 70): Pt[] {
  const c = sectorCenter(sector);
  const h = SECTOR_SIZE / 2 - 25;
  const pts: Pt[] = [];
  let flip = false;
  for (let x = c.x - h; x <= c.x + h + 1; x += laneSpacing) {
    const a = { x, z: c.z - h }, b = { x, z: c.z + h };
    pts.push(...(flip ? [b, a] : [a, b]));
    flip = !flip;
  }
  return pts;
}

/**
 * Safe corridor from a person to the safe zone. A* on a 2×-coarsened fire grid; cells whose
 * predicted fire arrival is earlier than walking ETA + margin are blocked or penalised.
 */
export function planCorridor(from: Pt, fire: FireModel, arrival: Float64Array, walkSpeed = 2.2): Pt[] | null {
  // Prefer a route with timing margin; if the fire outruns every such route, take the
  // least-dangerous route that avoids burning ground (flagged by a higher cost).
  return astar(from, fire, arrival, walkSpeed, 20) ?? astar(from, fire, arrival, walkSpeed, -Infinity);
}

function astar(from: Pt, fire: FireModel, arrival: Float64Array, walkSpeed: number, minSlack: number): Pt[] | null {
  const S = 2, N = FIRE_N / S, cell = FIRE_CELL * S;
  const idx = (x: number, z: number) => {
    const i = clamp(Math.floor((x + HALF) / cell), 0, N - 1), j = clamp(Math.floor((z + HALF) / cell), 0, N - 1);
    return j * N + i;
  };
  const center = (k: number): Pt => ({ x: -HALF + ((k % N) + 0.5) * cell, z: -HALF + (((k / N) | 0) + 0.5) * cell });
  const danger = (k: number, eta: number) => {
    const i = k % N, j = (k / N) | 0;
    let minArr = Infinity, burning = false;
    for (let dj = 0; dj < S; dj++) for (let di = 0; di < S; di++) {
      const fk = (j * S + dj) * FIRE_N + i * S + di;
      minArr = Math.min(minArr, arrival[fk]);
      if (fire.state[fk] === BURNING) burning = true;
    }
    if (burning) return Infinity;
    const slack = minArr - eta;
    if (slack < minSlack) return Infinity;
    return slack < 240 ? Math.min(30, (240 - slack) / 20) : 0;
  };
  const start = idx(from.x, from.z), goal = idx(SAFE_ZONE.x, SAFE_ZONE.z);
  const g = new Float64Array(N * N).fill(Infinity);
  const prev = new Int32Array(N * N).fill(-1);
  const open = new Heap();
  const f = new Float64Array(N * N).fill(Infinity);
  const walked = new Float64Array(N * N).fill(Infinity);
  g[start] = 0;
  walked[start] = 0;
  const gp = center(goal);
  const h = (k: number) => {
    const p = center(k);
    return dist2(p.x, p.z, gp.x, gp.z) / cell;
  };
  f[start] = h(start);
  open.push(start, f[start]);
  const closed = new Uint8Array(N * N);
  while (open.size) {
    const k = open.pop();
    if (closed[k]) continue; // stale heap entry
    if (k === goal) break;
    closed[k] = 1;
    const i = k % N, j = (k / N) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const nk = nj * N + ni;
      if (closed[nk]) continue;
      const step = Math.hypot(di, dj);
      const eta = ((walked[k] + step) * cell) / walkSpeed;
      const dz = danger(nk, eta);
      if (!Number.isFinite(dz) && nk !== goal) continue;
      const ng = g[k] + step * (1 + (Number.isFinite(dz) ? dz : 0));
      if (ng < g[nk]) {
        g[nk] = ng;
        walked[nk] = walked[k] + step;
        prev[nk] = k;
        f[nk] = ng + h(nk);
        open.push(nk, f[nk]);
      }
    }
  }
  if (prev[goal] < 0 && goal !== start) return null;
  const path: Pt[] = [];
  for (let k = goal; k >= 0; k = prev[k]) {
    path.push(center(k));
    if (k === start) break;
  }
  path.reverse();
  // Simplify: keep every 3rd node, plus exact endpoints.
  const out: Pt[] = [{ ...from }];
  for (let q = 3; q < path.length - 1; q += 3) out.push(path[q]);
  out.push({ x: SAFE_ZONE.x, z: SAFE_ZONE.z });
  return out;
}

/** Minimal binary min-heap of (node, priority) with lazy deletion. */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.k.length;
  }
  push(key: number, val: number): void {
    const k = this.k, v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= v[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.k, v = this.v;
    const top = k[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && v[l] < v[m]) m = l;
        if (r < k.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

export const BASE_COMM_RANGE = 820; // SIM: command-post radio range (m)
export const RELAY_COMM_RANGE = 650; // SIM: airborne relay range (m)

/** Relay point on the base→target line, if the target is beyond base range. */
export function relayPointFor(t: Pt): Pt | null {
  const d = dist2(t.x, t.z, BASE_POS.x, BASE_POS.z);
  if (d <= BASE_COMM_RANGE - 60) return null;
  const k = Math.min(0.62, (BASE_COMM_RANGE - 120) / d);
  return { x: BASE_POS.x + (t.x - BASE_POS.x) * Math.max(k, 0.45), z: BASE_POS.z + (t.z - BASE_POS.z) * Math.max(k, 0.45) };
}

/** Commander area → sector labels. */
export function areaSectors(area: Area, fireSectors: string[]): string[] {
  const all = allSectors();
  switch (area) {
    case 'VILLAGE':
      return all.filter((s) => {
        const c = sectorCenter(s);
        return dist2(c.x, c.z, VILLAGE.x, VILLAGE.z) < 380;
      });
    case 'NORTH_FOREST':
      return all.filter((s) => s[0] === 'A' || s[0] === 'B');
    case 'SOUTH':
      return all.filter((s) => s[0] === 'G' || s[0] === 'H');
    case 'EAST':
      return all.filter((s) => Number(s.slice(1)) >= 7);
    case 'WEST':
      return all.filter((s) => Number(s.slice(1)) <= 2);
    case 'FIRE_FRONT':
      return fireSectors;
    case 'EVAC_ROAD':
      return ['D5', 'E5', 'E6', 'F6', 'F7', 'G7'];
    default:
      return [];
  }
}
