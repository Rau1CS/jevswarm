/**
 * Suppression objectives for physically modelled loadouts (plain code, observable state only):
 *   ATTACK — direct attack on the head / flanks of the fire while it may still be contained
 *   TREAT  — long-term retardant on unburned fuel ahead of the fire (PRETREAT agents)
 * Facts include delivery capacity so the judge can weigh feasibility, not just threat.
 */
import { FIRE_CELL, FIRE_N } from '../config';
import { bearing, compassName, dist2, sectorOf, windToward } from '../core/math';
import { VILLAGE, type Pt } from '../world/layout';
import { capacity, landingFraction } from '../sim/loadout/catalogue';
import { RET_HALF_DOSE } from '../sim/fire';
import { fmtMin, type CoordView } from './objectives';
import type { Objective, Slot } from './types';

const sup = (label: string, target: Pt): Slot => ({ task: 'SUPPRESS', prefer: 'SUPPRESSION', label, target });

interface FireShape { centroid: Pt; head: Pt; left: Pt; right: Pt; front: number; cells: number; toward: string }

/** Burning cells grouped into separate fires (cells within 2 cells of each other join). Largest first. */
export function fireClusters(v: CoordView): number[][] {
  const burning = new Set(v.fire.burning);
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const k0 of v.fire.burning) {
    if (seen.has(k0)) continue;
    const cl: number[] = [];
    const stack = [k0];
    seen.add(k0);
    while (stack.length) {
      const k = stack.pop()!;
      cl.push(k);
      const i = k % FIRE_N, j = (k / FIRE_N) | 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= FIRE_N || nj >= FIRE_N) continue;
        const nk = nj * FIRE_N + ni;
        if (burning.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    out.push(cl);
  }
  return out.sort((a, b) => b.length - a.length);
}

function shapeOf(v: CoordView, cells: number[]): FireShape {
  const front = new Set(v.fire.frontCells());
  const edge = cells.filter((k) => front.has(k));
  const use = edge.length ? edge : cells;
  const pts = use.map((k) => v.fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0));
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  const w = windToward(v.fire.wind.fromDeg);
  let head = pts[0], left = pts[0], right = pts[0];
  let hs = -Infinity, ls = -Infinity, rs = Infinity;
  for (const p of pts) {
    const along = (p.x - cx) * w.x + (p.z - cz) * w.z;
    const across = (p.x - cx) * -w.z + (p.z - cz) * w.x;
    if (along > hs) { hs = along; head = p; }
    // Flanks: widest points across the wind, biased toward the head half.
    const bias = Math.max(0, along) * 0.3;
    if (across + bias > ls) { ls = across + bias; left = p; }
    if (across - bias < rs) { rs = across - bias; right = p; }
  }
  return { centroid: { x: cx, z: cz }, head, left, right, front: edge.length, cells: cells.length, toward: compassName(bearing(w.x, w.z)) };
}

/** Shape of the largest fire (null when nothing burns). */
export function fireShape(v: CoordView): FireShape | null {
  const cl = fireClusters(v);
  return cl.length ? shapeOf(v, cl[0]) : null;
}

/** SIM: spot fires this small (cells) are worth finishing off completely. */
const SPOT_CELLS = 16;

/** Point `ahead` metres downwind of p (for retardant lines). */
function downwind(v: CoordView, p: Pt, ahead: number): Pt {
  const w = windToward(v.fire.wind.fromDeg);
  return { x: p.x + w.x * ahead, z: p.z + w.z * ahead };
}

export function suppressionObjectives(v: CoordView, suppressionDrones: number, arrivalNear: (x: number, z: number) => number): Objective[] {
  const clusters = fireClusters(v);
  const lo = v.loadout;
  if (!clusters.length || !lo) return [];
  const shape = shapeOf(v, clusters[0]);
  const cap = capacity(lo);
  const perSortie = cap * landingFraction(lo, v.fire.wind.speed);
  const u = lo.agent.unit;
  const capFacts = `Each suppression drone lands about ${perSortie.toFixed(1)} ${u} of ${lo.agent.name.toLowerCase()} on target per sortie; ${suppressionDrones} suppression drones available.`;
  const villageArr = arrivalNear(VILLAGE.x, VILLAGE.z);
  const haOf = (cells: number) => (cells * FIRE_CELL * FIRE_CELL) / 10000;
  const size = `${haOf(shape.cells).toFixed(2)} ha actively burning, ${((shape.front * FIRE_CELL) / 1000).toFixed(2)} km active front`;
  const out: Objective[] = [];

  if (lo.agent.mission === 'DIRECT') {
    // Separate small fires (spot fires) can be finished off; each gets its own objective.
    const spots = clusters.slice(1).filter((c) => c.length <= SPOT_CELLS).slice(0, 3);
    let left = suppressionDrones;
    spots.forEach((c, i) => {
      const sp = shapeOf(v, c);
      const sec = sectorOf(sp.head.x, sp.head.z);
      const n = Math.max(1, Math.min(3, Math.ceil(c.length / 2)));
      left -= n;
      out.push({
        id: `ATK_SPOT${i + 1}`, kind: 'ATTACK', sector: sec, x: sp.head.x, z: sp.head.z, arrivalSec: arrivalNear(sp.head.x, sp.head.z), sizeHa: haOf(c.length),
        slots: Array.from({ length: n }, () => sup(`ATTACK SPOT FIRE ${sec}`, sp.head)),
        facts: `Separate spot fire in ${sec}, ${c.length} burning cells (${haOf(c.length).toFixed(2)} ha), ${Math.round(dist2(sp.head.x, sp.head.z, shape.head.x, shape.head.z))} m from the main fire head. Small enough that concentrated drops could put it out before it merges or grows. ${capFacts}`,
        boost: 0,
      });
    });
    // Remaining aircraft: most on the main head, the rest split across its flanks.
    const avail = Math.max(1, left);
    const n = Math.max(1, Math.ceil(avail * 0.6));
    const nf = Math.max(1, Math.floor((avail - n) / 2));
    const hs = sectorOf(shape.head.x, shape.head.z);
    out.push({
      id: `ATK_HEAD`, kind: 'ATTACK', sector: hs, x: shape.head.x, z: shape.head.z, arrivalSec: villageArr, sizeHa: haOf(shape.cells),
      slots: Array.from({ length: n }, () => sup(`ATTACK HEAD ${hs}`, shape.head)),
      facts: `Head of the main fire in ${hs}, spreading ${shape.toward} (${size}). Village predicted fire arrival: ${fmtMin(villageArr)}. ${capFacts} Stopping the head while the fire is small can keep it contained.`,
      boost: 0,
    });
    for (const [name, p] of [['LEFT', shape.left], ['RIGHT', shape.right]] as const) {
      if (dist2(p.x, p.z, shape.head.x, shape.head.z) < 45) continue;
      const s = sectorOf(p.x, p.z);
      out.push({
        id: `ATK_${name}`, kind: 'ATTACK', sector: s, x: p.x, z: p.z, arrivalSec: arrivalNear(p.x, p.z), sizeHa: haOf(shape.cells),
        slots: Array.from({ length: nf }, () => sup(`ATTACK ${name} FLANK ${s}`, p)),
        facts: `${name === 'LEFT' ? 'Left' : 'Right'} flank of the main fire in ${s} (${size}). Flank attack narrows the head; less urgent than the head unless people or roads are on that side. ${capFacts}`,
        boost: 0,
      });
    }
    return out;
  }

  // PRETREAT: a short retardant line across the fire's path, far enough ahead to be laid before arrival.
  const leadSec = 150; // SIM: aim for fuel the fire should reach in ~2.5 min
  const rate = Math.max(0.05, 1.35 * v.fire.spreadMult * 0.6);
  const lineAt = downwind(v, shape.head, Math.min(260, Math.max(45, rate * leadSec)));
  const w = windToward(v.fire.wind.fromDeg);
  const n = Math.max(1, Math.min(8, suppressionDrones));
  const k = v.fire.cellOf(lineAt.x, lineAt.z);
  const treated = v.fire.salts[k] / RET_HALF_DOSE;
  const s = sectorOf(lineAt.x, lineAt.z);
  const arr = arrivalNear(lineAt.x, lineAt.z);
  out.push({
    id: 'TRT_HEAD', kind: 'TREAT', sector: s, x: lineAt.x, z: lineAt.z, arrivalSec: arr, sizeHa: haOf(shape.cells),
    slots: Array.from({ length: n }, (_, i) => {
      const off = (i - (n - 1) / 2) * FIRE_CELL;
      return sup(`RETARDANT LINE ${s}`, { x: lineAt.x - w.z * off, z: lineAt.z + w.x * off });
    }),
    facts: `Unburned fuel in ${s} ahead of the fire head (fire spreading ${shape.toward}, ${size}); fire predicted there in ${fmtMin(arr)}. Treatment so far ${Math.round(treated * 100)}% of the reference dose. Retardant slows spread but does not make fuel nonflammable. ${capFacts}`,
    boost: 0,
  });
  return out;
}
