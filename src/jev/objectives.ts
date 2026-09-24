/**
 * Builds candidate objectives from OBSERVABLE state. Ground truth about civilians is only
 * read after a detection is CONFIRMED (i.e. the swarm has eyes on the person).
 */
import { BASE_POS, FIRE_CELL, FIRE_N } from '../config';
import { bearing, compassName, dist2, sectorCenter, sectorOf } from '../core/math';
import { BUILDINGS, ROADS, VILLAGE, type Pt } from '../world/layout';
import type { Civilian } from '../sim/civilians';
import type { Drone } from '../sim/drone';
import type { FireModel } from '../sim/fire';
import type { Sensors } from '../sim/sensors';
import { areaSectors, relayPointFor, searchPattern } from './planner';
import type { Directive, Objective, Slot } from './types';

export interface CorridorState {
  route: Pt[] | null;
  flown: boolean;
  guided: boolean;
  plannedAt: number;
}

export interface CoordView {
  t: number;
  fire: FireModel;
  arrival: Float64Array;
  sensors: Sensors;
  drones: Drone[];
  directive: Directive | null;
  corridors: Map<string, CorridorState>;
  confirmedCiv(detId: string): Civilian | undefined;
}

export const fmtMin = (s: number) => (Number.isFinite(s) ? `${(s / 60).toFixed(1)} min` : 'not predicted within 15 min');

export function arrivalNear(v: CoordView, x: number, z: number, r = 30): number {
  const n = Math.ceil(r / FIRE_CELL);
  const c = v.fire.cellOf(x, z);
  const ci = c % FIRE_N, cj = (c / FIRE_N) | 0;
  let best = Infinity;
  for (let dj = -n; dj <= n; dj++) for (let di = -n; di <= n; di++) {
    const i = ci + di, j = cj + dj;
    if (i < 0 || j < 0 || i >= FIRE_N || j >= FIRE_N) continue;
    best = Math.min(best, v.arrival[j * FIRE_N + i]);
  }
  return best;
}

/** Nearest active fire-front cell to a point, within maxDist. */
function nearestFront(front: number[], fire: FireModel, p: Pt, maxDist: number): { pt: Pt; d: number } | null {
  let best: { pt: Pt; d: number } | null = null;
  for (const k of front) {
    const c = fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0);
    const d = dist2(c.x, c.z, p.x, p.z);
    if (d < maxDist && (!best || d < best.d)) best = { pt: c, d };
  }
  return best;
}

const slot = (task: Slot['task'], prefer: Slot['prefer'], label: string, target: Pt, waypoints?: Pt[]): Slot =>
  ({ task, prefer, label, target, waypoints });

export function buildObjectives(v: CoordView): Objective[] {
  const out: Objective[] = [];
  const front = v.fire.frontCells();
  const dir = v.directive;
  const fireSectors = [...new Set(front.map((k) => { const c = v.fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0); return sectorOf(c.x, c.z); }))];
  const focus = dir ? new Set(areaSectors(dir.area, fireSectors)) : new Set<string>();
  const areaBoost = (sector: string) => (focus.has(sector) && (dir?.intent === 'PRIORITIZE_AREA' || dir?.intent === 'SEARCH_AREA') ? 1.2 : 0);

  // People: possible detections to verify, confirmed people to rescue.
  const assets: { p: Pt; label: string; detId: string }[] = [];
  for (const det of v.sensors.detections) {
    if (det.status === 'DISMISSED') continue;
    const civ = det.status === 'CONFIRMED' ? v.confirmedCiv(det.id) : undefined;
    if (civ && civ.behavior === 'SAFE') continue;
    const p = civ ? { x: civ.x, z: civ.z } : { x: det.x, z: det.z };
    const arr = arrivalNear(v, p.x, p.z);
    const cor = v.corridors.get(det.id);
    const slots: Slot[] = [];
    let facts: string;
    if (det.status === 'POSSIBLE') {
      slots.push(slot('VERIFY', 'SCOUT', `VERIFY ${det.sector}`, p));
      if (arr < 420 && !cor?.flown) slots.push(slot('CORRIDOR', 'SCOUT', `EVAC ROUTE ${det.sector}`, p));
      facts = `Unverified thermal signature that may be a person in ${det.sector}, thermal confidence ${det.conf.toFixed(2)}. Predicted fire arrival there: ${fmtMin(arr)}.`;
    } else {
      if (!civ?.supplied) slots.push(slot('DELIVER', 'LOGISTICS', `SUPPLY DROP ${det.sector}`, p));
      if (!cor?.flown) slots.push(slot('CORRIDOR', 'SCOUT', `EVAC ROUTE ${det.sector}`, p));
      else if (cor.route) slots.push(slot('GUIDE', 'SCOUT', `GUIDE ${det.id}`, p));
      facts = `Confirmed person in ${det.sector}${civ?.behavior === 'TRAPPED' ? ', not moving, apparently trapped' : ''}. Predicted fire arrival: ${fmtMin(arr)}. ${cor?.flown ? 'A safe corridor has been found.' : 'No safe route identified yet.'}`;
    }
    out.push({ id: `CIV_${det.id}`, kind: det.status === 'POSSIBLE' ? 'VERIFY' : 'RESCUE', sector: det.sector, x: p.x, z: p.z, facts, arrivalSec: arr, detectionId: det.id, slots, boost: areaBoost(det.sector) });
    assets.push({ p, label: det.status === 'CONFIRMED' ? `confirmed person ${det.id}` : `possible person ${det.id}`, detId: det.id });
  }

  // Suppression near people and the village.
  const civFocus = dir?.intent === 'FOCUS_SUPPRESSION_CIVILIANS';
  const supBySector = new Map<string, Objective>();
  const village = { p: { x: VILLAGE.x, z: VILLAGE.z }, label: 'village buildings', detId: '' };
  for (const a of [...assets, village]) {
    const nf = nearestFront(front, v.fire, a.p, a.detId ? (civFocus ? 650 : 480) : 520);
    if (!nf) continue;
    const sec = sectorOf(nf.pt.x, nf.pt.z);
    const arr = arrivalNear(v, a.p.x, a.p.z);
    const prev = supBySector.get(sec);
    if (prev && prev.arrivalSec <= arr) continue;
    const n = nf.d < 300 || arr < 360 ? 2 : 1;
    const slots = Array.from({ length: n }, () => slot('SUPPRESS', 'SUPPRESSION', `SUPPRESS ${sec}`, nf.pt));
    supBySector.set(sec, {
      id: `SUP_${sec}`, kind: 'SUPPRESS', sector: sec, x: nf.pt.x, z: nf.pt.z, arrivalSec: arr, slots,
      facts: `Active fire front in ${sec}, ${Math.round(nf.d)} m from ${a.label}; fire predicted to reach them in ${fmtMin(arr)}. A suppressant drop could slow it there.`,
      boost: (civFocus && a.detId ? 1.5 : 0) + areaBoost(sec),
    });
  }
  out.push(...supBySector.values());

  // Evacuation road protection.
  const protect = dir?.intent === 'PROTECT_ROAD';
  for (const road of ROADS.filter((r) => r.evac)) {
    let worst: { p: Pt; arr: number } | null = null;
    for (let i = 0; i < road.pts.length - 1; i++) {
      for (let s = 0; s <= 1; s += 0.25) {
        const p = { x: road.pts[i].x + (road.pts[i + 1].x - road.pts[i].x) * s, z: road.pts[i].z + (road.pts[i + 1].z - road.pts[i].z) * s };
        const arr = arrivalNear(v, p.x, p.z, 20);
        if (!worst || arr < worst.arr) worst = { p, arr };
      }
    }
    if (!worst || (!protect && worst.arr > 420)) continue;
    const sec = sectorOf(worst.p.x, worst.p.z);
    const slots: Slot[] = [slot('PATROL', 'SCOUT', `PATROL ${road.name.toUpperCase()}`, worst.p, road.pts)];
    const nf = nearestFront(front, v.fire, worst.p, 500);
    if (nf) slots.push(slot('SUPPRESS', 'SUPPRESSION', `PROTECT ROAD ${sectorOf(nf.pt.x, nf.pt.z)}`, nf.pt));
    out.push({
      id: `ROAD_${road.id}`, kind: 'PROTECT_ROAD', sector: sec, x: worst.p.x, z: worst.p.z, arrivalSec: worst.arr, slots,
      facts: `${road.name} (evacuation route) near ${sec}: fire predicted to cut it in ${fmtMin(worst.arr)}.`,
      boost: protect ? 1.5 : 0,
    });
  }

  // Fire mapping.
  if (front.length) {
    let cx = 0, cz = 0;
    for (const k of front) { const c = v.fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0); cx += c.x; cz += c.z; }
    cx /= front.length; cz /= front.length;
    const sec = sectorOf(cx, cz);
    const wb = compassName(bearing(Math.sin(((v.fire.wind.fromDeg + 180) * Math.PI) / 180), -Math.cos(((v.fire.wind.fromDeg + 180) * Math.PI) / 180)));
    out.push({
      id: 'MAP_FIRE', kind: 'MONITOR', sector: sec, x: cx, z: cz, arrivalSec: 0,
      slots: [slot('MONITOR', 'SCOUT', 'FIRE MAPPING', { x: cx, z: cz })],
      facts: `Map the fire front (${(front.length * FIRE_CELL / 1000).toFixed(1)} km active, spreading ${wb}) so predictions stay current.`,
      boost: 0,
    });
  }

  // Search sectors.
  const searchAll = dir?.intent === 'SEARCH_AREA';
  const cands = [] as { sec: string; prior: number; searched: number; arr: number; nb: number }[];
  for (let r = 0; r < 8; r++) for (let c = 1; c <= 8; c++) {
    const sec = `${'ABCDEFGH'[r]}${c}`;
    const searched = v.sensors.sectorSearched(sec);
    if (searched > 0.6) continue;
    const cc = sectorCenter(sec);
    const nb = BUILDINGS.filter((b) => sectorOf(b.x, b.z) === sec).length;
    const arr = arrivalNear(v, cc.x, cc.z, 120);
    const prior = nb * 0.35 + (arr < 600 ? 1 : 0) + (1 - searched) + (focus.has(sec) ? 2 : 0) - dist2(cc.x, cc.z, VILLAGE.x, VILLAGE.z) / 900;
    cands.push({ sec, prior, searched, arr, nb });
  }
  cands.sort((a, b) => b.prior - a.prior);
  for (const c of cands.slice(0, searchAll ? 10 : 8)) {
    out.push({
      id: `SRCH_${c.sec}`, kind: 'SEARCH', sector: c.sec, ...sectorCenter(c.sec), arrivalSec: c.arr,
      slots: [slot('SEARCH', 'SCOUT', `SEARCH ${c.sec}`, sectorCenter(c.sec), searchPattern(c.sec))],
      facts: `Unsearched sector ${c.sec} (${Math.round(c.searched * 100)}% covered, ${c.nb} buildings). Fire arrival: ${fmtMin(c.arr)}.`,
      boost: areaBoost(c.sec) + (focus.has(c.sec) && searchAll ? 0.6 : 0),
    });
  }

  // Comms relays for important work beyond command-post radio range.
  const relays = new Map<string, Objective>();
  for (const o of out) {
    if (o.kind === 'SEARCH' || o.kind === 'MONITOR') continue;
    const rp = relayPointFor(o);
    if (!rp) continue;
    const sec = sectorOf(rp.x, rp.z);
    if (relays.has(sec) || relays.size >= 3) continue;
    relays.set(sec, {
      id: `RLY_${sec}`, kind: 'RELAY', sector: sec, x: rp.x, z: rp.z, arrivalSec: o.arrivalSec,
      slots: [slot('RELAY', 'RELAY', `RELAY ${sec}`, rp)],
      facts: `Drones working in ${o.sector} are ${Math.round(dist2(o.x, o.z, BASE_POS.x, BASE_POS.z))} m from the command post, beyond its radio range; a relay in ${sec} keeps them linked.`,
      boost: 0,
    });
  }
  out.push(...relays.values());
  return out;
}
