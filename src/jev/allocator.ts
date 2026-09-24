/**
 * Deterministic task allocation. Jev supplies urgency/priority judgments; this code turns
 * them into drone assignments with capability, distance, battery and stickiness costs.
 */
import { dist2 } from '../core/math';
import type { Drone, Role, TaskKind } from '../sim/drone';
import type { Directive, Judgment, Objective, Slot } from './types';

const SWAP = -1;
/** Extra cost (s) for a role performing a task; SWAP = needs payload change at base. */
const CAP: Record<Role, Partial<Record<TaskKind, number>>> = {
  SCOUT: { SEARCH: 0, VERIFY: 0, CORRIDOR: 0, GUIDE: 0, MONITOR: 0, PATROL: 0, RELAY: 15, SUPPRESS: SWAP, DELIVER: SWAP },
  SUPPRESSION: { SUPPRESS: 0, VERIFY: 25, PATROL: 10, MONITOR: 20, SEARCH: 40, CORRIDOR: 30, GUIDE: 25, RELAY: 20, DELIVER: SWAP },
  LOGISTICS: { DELIVER: 0, GUIDE: 10, RELAY: 10, CORRIDOR: 20, PATROL: 15, SEARCH: 40, VERIFY: 40, MONITOR: 30, SUPPRESS: SWAP },
  RELAY: { RELAY: 0, PATROL: 15, GUIDE: 20, CORRIDOR: 35, SEARCH: 45, VERIFY: 45, MONITOR: 35, SUPPRESS: SWAP, DELIVER: SWAP },
};
const SWAP_ROLE: Partial<Record<TaskKind, Role>> = { SUPPRESS: 'SUPPRESSION', DELIVER: 'LOGISTICS' };
const THERMAL_TASKS = new Set<TaskKind>(['SEARCH', 'VERIFY', 'CORRIDOR', 'MONITOR']);
const SWAPPABLE_FROM = new Set<TaskKind>(['IDLE', 'SEARCH', 'MONITOR', 'RESERVE', 'PATROL']);

export interface Alloc {
  drone: Drone;
  objectiveId: string;
  slot: Slot;
  swapTo?: Role;
  weight: number;
}

export interface AllocResult {
  allocs: Alloc[];
  reserve: Drone[];
  idle: Drone[];
  weights: Record<string, number>;
}

export function objectiveWeight(o: Objective, j: Judgment): number {
  return (j.urgency[o.id] ?? 1) + o.boost + (j.priorityId === o.id ? 0.8 : 0);
}

export function allocate(objs: Objective[], j: Judgment, drones: Drone[], dir: Directive | null): AllocResult {
  const weights: Record<string, number> = {};
  for (const o of objs) weights[o.id] = objectiveWeight(o, j);
  const pool = drones.filter((d) => d.available && d.status !== 'LINK_LOST' && d.task.kind !== 'RTB');
  // Drones already swapping payload for an objective stay committed to it.
  const committed = pool.filter((d) => d.task.kind === 'SWAP' && d.task.objectiveId && weights[d.task.objectiveId] !== undefined);
  let free = pool.filter((d) => !committed.includes(d));

  const reserve: Drone[] = [];
  const reserveN = dir?.intent === 'RESERVE' ? Math.min(dir.count, free.length) : 0;
  if (reserveN > 0) {
    free.sort((a, b) => baseDist(a) - baseDist(b));
    reserve.push(...free.slice(0, reserveN));
    free = free.slice(reserveN);
  }

  const allocs: Alloc[] = [];
  const sorted = [...objs].sort((a, b) => weights[b.id] - weights[a.id]);
  for (const o of sorted) {
    const w = weights[o.id];
    o.slots.forEach((slot, si) => {
      // Slot already covered by a committed swapping drone?
      const c = committed.find((d) => d.task.objectiveId === o.id && d.task.then?.kind === slot.task && !allocs.some((a) => a.drone === d));
      if (c) {
        allocs.push({ drone: c, objectiveId: o.id, slot, swapTo: c.task.swapTo, weight: w });
        return;
      }
      let best: { d: Drone; cost: number; swap?: Role } | null = null;
      for (const d of free) {
        const cap = CAP[d.role][slot.task];
        if (cap === undefined) continue;
        if (!d.thermalOK && THERMAL_TASKS.has(slot.task)) continue;
        const travel = dist2(d.x, d.z, slot.target.x, slot.target.z) / 15;
        let cost = travel;
        let swap: Role | undefined;
        if (cap === SWAP) {
          if (w < 2.2) continue; // not worth a base trip
          // Only re-role aircraft doing low-value work (or already home); never strip a loaded suppressor.
          const lowValue = SWAPPABLE_FROM.has(d.task.kind) || baseDist(d) < 300;
          if (!lowValue || (d.role === 'SUPPRESSION' && d.payload > 0.3)) continue;
          swap = SWAP_ROLE[slot.task];
          cost = (baseDist(d) + dist2(d.pad.x, d.pad.z, slot.target.x, slot.target.z)) / 15 + 40;
        } else cost += cap;
        if (d.task.objectiveId === o.id && (d.task.kind === slot.task || d.task.then?.kind === slot.task)) cost -= 70 + si;
        if (d.battery < 0.4) cost += 90;
        if (d.role === slot.prefer) cost -= 5;
        if (!best || cost < best.cost) best = { d, cost, swap };
      }
      if (best) {
        allocs.push({ drone: best.d, objectiveId: o.id, slot, swapTo: best.swap, weight: w });
        free = free.filter((d) => d !== best!.d);
      }
    });
  }
  // Second pass: spare capable drones double up on the most important searches.
  for (const o of sorted.filter((q) => q.kind === 'SEARCH')) {
    const idx = free.findIndex((d) => (CAP[d.role].SEARCH ?? 99) <= 15 && d.thermalOK);
    if (idx < 0) break;
    const s = o.slots[0];
    allocs.push({ drone: free[idx], objectiveId: o.id, slot: { ...s, waypoints: s.waypoints ? [...s.waypoints].reverse() : undefined }, weight: weights[o.id] });
    free.splice(idx, 1);
  }
  return { allocs, reserve, idle: free, weights };
}

function baseDist(d: Drone): number {
  return dist2(d.x, d.z, d.pad.x, d.pad.z);
}
