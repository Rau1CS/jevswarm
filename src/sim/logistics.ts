/**
 * Refill logistics (SIM): a finite number of refill slots per station, FIFO queues, and
 * per-drone cycle bookkeeping. Water can be drawn at the lake; mixed agents (foam, gel,
 * retardant, dry chemical) need a mixing station.
 */
import { BASE_POS, LAKE } from '../config';
import { dist2 } from '../core/math';
import type { Pt } from '../world/layout';
import type { Loadout } from './loadout/catalogue';

export interface Station {
  id: string;
  name: string;
  x: number; z: number;
  slots: number;
  mixes: boolean; // can supply mixed agents (not just water)
  busy: Set<string>;
  queue: string[];
  /** Low hover (lake dip) vs landing on a pad. */
  dip: boolean;
}

const station = (id: string, name: string, p: Pt, slots: number, mixes: boolean, dip: boolean): Station =>
  ({ id, name, x: p.x, z: p.z, slots, mixes, dip, busy: new Set(), queue: [] });

export class Logistics {
  readonly stations: Station[];

  constructor(forward: Pt | null) {
    this.stations = [
      station('LAKE', 'Lake dip point', { x: LAKE.x, z: LAKE.z }, 3, false, true), // SIM: 3 simultaneous dip slots
      station('BASE', 'Command-post refill station', { x: BASE_POS.x + 70, z: BASE_POS.z - 70 }, 4, true, false), // SIM: 4 pumps
    ];
    if (forward) this.stations.push(station('FWD', 'Forward refill truck', forward, 2, true, false)); // SIM: 2 hoses
  }

  /** Nearest station able to supply the loadout's agent, accounting for its queue (SIM ETA heuristic). */
  pick(l: Loadout, from: Pt, speed: number, refillSec: number): Station {
    let best: Station | null = null, bestT = Infinity;
    for (const s of this.stations) {
      if (!s.mixes && l.agent.refill === 'STATION') continue;
      const waiting = Math.max(0, s.busy.size + s.queue.length - s.slots + 1);
      const t = dist2(from.x, from.z, s.x, s.z) / speed + (waiting * refillSec) / s.slots;
      if (t < bestT) { bestT = t; best = s; }
    }
    return best ?? this.stations[1];
  }

  get(id: string): Station | undefined {
    return this.stations.find((s) => s.id === id);
  }

  /** Try to take a slot. Joins the FIFO queue on first refusal. */
  request(id: string, droneId: string): boolean {
    const s = this.get(id);
    if (!s) return true;
    if (s.busy.has(droneId)) return true;
    if (!s.queue.includes(droneId)) s.queue.push(droneId);
    if (s.busy.size < s.slots && s.queue[0] === droneId) {
      s.queue.shift();
      s.busy.add(droneId);
      return true;
    }
    return false;
  }

  release(droneId: string): void {
    for (const s of this.stations) {
      s.busy.delete(droneId);
      const i = s.queue.indexOf(droneId);
      if (i >= 0) s.queue.splice(i, 1);
    }
  }

  /** Slot position around a station so refilling drones don't stack. */
  slotPos(id: string, droneId: string): Pt {
    const s = this.get(id) ?? this.stations[1];
    const i = [...s.busy].indexOf(droneId);
    const a = (Math.max(0, i) / Math.max(1, s.slots)) * Math.PI * 2;
    const r = s.dip ? 30 : 14;
    return { x: s.x + Math.cos(a) * r, z: s.z + Math.sin(a) * r };
  }
}
