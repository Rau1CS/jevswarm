/**
 * Scenario events (failures and disruptions). Used randomly in free simulation and on
 * cue by the cinematic director. Each event changes state and lets Jev react.
 */
import { FIRE_N } from '../config';
import { Rng, sectorOf, windToward } from '../core/math';
import { ROADS, pointAlong, polyLength } from '../world/layout';
import type { Simulation } from './simulation';
import type { Drone } from './drone';

export type EventKind =
  | 'WIND_SHIFT' | 'COMM_LOST' | 'BATTERY_CRITICAL' | 'FALSE_POSITIVE' | 'SENSOR_FAILURE'
  | 'ROAD_BLOCKED' | 'NEW_CIVILIAN' | 'FIRE_JUMP' | 'DRONE_LOST';

const airborne = (sim: Simulation) => sim.drones.filter((d) => d.airborne && d.status === 'AIRBORNE');

/** Count of cells predicted to burn within 10 minutes. */
function threatCells(sim: Simulation): number {
  const a = sim.fire.predictArrival(600);
  let n = 0;
  for (let k = 0; k < a.length; k++) if (a[k] < 600) n++;
  return n;
}

export function windShift(sim: Simulation, toFrom?: number, speed?: number, sectorHint?: string): void {
  const before = threatCells(sim);
  const from0 = sim.fire.wind.fromDeg;
  const nf = toFrom ?? (from0 + (sim.rng.chance(0.5) ? 1 : -1) * sim.rng.range(45, 80) + 360) % 360;
  const ns = speed ?? Math.min(11, sim.fire.wind.speed + sim.rng.range(0.5, 2.5));
  sim.fire.setWind({ fromDeg: nf, speed: ns }, true);
  const after = threatCells(sim);
  sim.fire.setWind({ fromDeg: from0, speed: sim.fire.wind.speed }, true);
  sim.fire.setWind({ fromDeg: nf, speed: ns }); // eases in over a few seconds
  const risk = before > 0 ? Math.round(((after - before) / before) * 100) : 0;
  // Most threatened sector downwind of the front.
  let sector = sectorHint;
  if (!sector) {
    const w = windToward(nf);
    const front = sim.fire.frontCells();
    if (front.length) {
      const k = front[Math.floor(front.length / 2)];
      const c = sim.fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0);
      sector = sectorOf(c.x + w.x * 300, c.z + w.z * 300);
    }
  }
  const lines = [`${Math.round(from0)}° → ${Math.round(nf)}°`, `${risk >= 0 ? '+' : ''}${risk}% propagation risk`, sector ? `Sector ${sector} threatened` : ''].filter(Boolean);
  sim.banner('WIND SHIFT DETECTED', lines, 'warn');
  sim.emitLog({ t: sim.t, title: 'WIND MODEL UPDATE', lines, level: 'warn' });
  sim.coordinator.windNote = `wind shifted from ${Math.round(from0)}° to ${Math.round(nf)}° just now; fire spread direction changed`;
  sim.coordinator.trigger('wind shift');
}

export function commLost(sim: Simulation, d?: Drone): void {
  d ??= sim.rng.pick(airborne(sim));
  if (!d) return;
  d.status = 'LINK_LOST';
  d.linkLostT = 25;
  sim.banner('DRONE COMMUNICATION LOST', [`${d.id} · sector ${sectorOf(d.x, d.z)}`, 'continuing last task autonomously'], 'warn');
  sim.emitLog({ t: sim.t, title: 'COMMUNICATION LOST', lines: [`${d.id} · ${d.task.label.toLowerCase()}`, 'link retry 25 s'], level: 'warn' });
  sim.coordinator.trigger('comm lost');
}

export function batteryCritical(sim: Simulation, d?: Drone): void {
  d ??= sim.rng.pick(airborne(sim));
  if (!d) return;
  d.battery = Math.min(d.battery, 0.17);
  sim.banner('BATTERY CRITICAL', [`${d.id} · ${Math.round(d.battery * 100)}%`, 'returning to command post'], 'warn');
  sim.emitLog({ t: sim.t, title: 'BATTERY CRITICAL', lines: [`${d.id} cell fault · RTB`], level: 'warn' });
  sim.coordinator.trigger('battery critical');
}

export function falsePositive(sim: Simulation): void {
  const scouts = airborne(sim).filter((d) => d.role === 'SCOUT');
  const d = sim.rng.pick(scouts);
  if (!d) return;
  const a = sim.rng.range(0, 6.28);
  sim.sensors.create(d.x + Math.cos(a) * 50, d.z + Math.sin(a) * 50, sim.rng.range(0.45, 0.6), null, d.id, sim.t, sim.sensorEvents);
}

export function sensorFailure(sim: Simulation): void {
  const d = sim.rng.pick(airborne(sim).filter((q) => q.thermalOK && q.role === 'SCOUT'));
  if (!d) return;
  d.thermalOK = false;
  sim.banner('SENSOR FAILURE', [`${d.id} thermal camera offline`, 'reassigning thermal tasks'], 'warn');
  sim.emitLog({ t: sim.t, title: 'SENSOR FAILURE', lines: [`${d.id} thermal offline`, 'RGB only · no thermal tasks'], level: 'warn' });
  sim.coordinator.trigger('sensor failure');
}

export function roadBlocked(sim: Simulation): void {
  const road = sim.rng.pick(ROADS.filter((r) => r.evac));
  const p = pointAlong(road.pts, polyLength(road.pts) * sim.rng.range(0.25, 0.6));
  sim.roadBlocks.push({ x: p.x, z: p.z });
  sim.fire.ignite(p.x + 20, p.z + 10, 22); // burning debris next to the carriageway
  sim.banner('ROAD BLOCKED', [`${road.name} · sector ${sectorOf(p.x, p.z)}`, 'burning debris across carriageway'], 'warn');
  sim.emitLog({ t: sim.t, title: 'ROAD BLOCKED', lines: [`${road.name.toLowerCase()} · ${sectorOf(p.x, p.z)}`, 'vehicles rerouting'], level: 'warn' });
  sim.coordinator.trigger('road blocked');
}

export function newCivilian(sim: Simulation): void {
  const front = sim.fire.frontCells();
  if (!front.length) return;
  const k = sim.rng.pick(front);
  const c = sim.fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0);
  const w = windToward(sim.fire.wind.fromDeg);
  const x = c.x + w.x * 280 + sim.rng.range(-60, 60), z = c.z + w.z * 280 + sim.rng.range(-60, 60);
  const civ = { ...sim.civilians[0], id: `P${String(sim.civilians.length + 1).padStart(2, '0')}`, x, z, behavior: 'WANDER' as const, indoor: false, path: [], pathI: 0, confirmed: false, hero: false, supplied: false, exposed: false, spawnedAt: sim.t };
  sim.civilians.push(civ);
  sim.sensors.create(x + sim.rng.range(-25, 25), z + sim.rng.range(-25, 25), 0.5, civ.id, 'CALL', sim.t, sim.sensorEvents);
  sim.banner('NEW CIVILIAN DETECTED', [`hiker reported · sector ${sectorOf(x, z)}`, 'position uncertain ±25 m'], 'warn');
}

export function fireJump(sim: Simulation): void {
  const front = sim.fire.frontCells();
  if (!front.length) return;
  const k = sim.rng.pick(front);
  const c = sim.fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0);
  const w = windToward(sim.fire.wind.fromDeg);
  const d = sim.rng.range(160, 260);
  const x = c.x + w.x * d, z = c.z + w.z * d;
  sim.fire.ignite(x, z, 28);
  sim.banner('FIRE JUMP', [`spot fire ${Math.round(d)} m downwind`, `sector ${sectorOf(x, z)}`], 'crit');
  sim.emitLog({ t: sim.t, title: 'FIRE JUMP', lines: [`ember spotting → ${sectorOf(x, z)}`, `${Math.round(d)} m ahead of front`], level: 'crit' });
  sim.coordinator.trigger('fire jump');
}

export function droneLost(sim: Simulation): void {
  const d = sim.rng.pick(airborne(sim));
  if (!d) return;
  d.status = 'FAILED';
  sim.banner('DRONE LOST', [`${d.id} motor failure`, `forced landing · ${sectorOf(d.x, d.z)}`], 'crit');
}

export function trigger(sim: Simulation, k: EventKind): void {
  ({
    WIND_SHIFT: () => windShift(sim), COMM_LOST: () => commLost(sim), BATTERY_CRITICAL: () => batteryCritical(sim),
    FALSE_POSITIVE: () => falsePositive(sim), SENSOR_FAILURE: () => sensorFailure(sim), ROAD_BLOCKED: () => roadBlocked(sim),
    NEW_CIVILIAN: () => newCivilian(sim), FIRE_JUMP: () => fireJump(sim), DRONE_LOST: () => droneLost(sim),
  })[k]();
}

/** Random disruption scheduler for free simulation. Guarantees one dramatic wind shift. */
export class EventScheduler {
  private next: number;
  private windDone = false;
  private windAt: number;
  constructor(private rng: Rng, start: number) {
    this.next = start + rng.range(35, 55);
    this.windAt = start + rng.range(90, 150);
  }
  update(sim: Simulation): void {
    if (!this.windDone && sim.t > this.windAt) {
      this.windDone = true;
      windShift(sim);
      this.next = Math.max(this.next, sim.t + 25);
      return;
    }
    if (sim.t < this.next) return;
    this.next = sim.t + this.rng.range(28, 50);
    const pool: [EventKind, number][] = [
      ['COMM_LOST', 2], ['BATTERY_CRITICAL', 2], ['FALSE_POSITIVE', 2], ['SENSOR_FAILURE', 1.5], ['ROAD_BLOCKED', 1],
      ['NEW_CIVILIAN', 1.5], ['FIRE_JUMP', 1.5], ['DRONE_LOST', 0.6], ['WIND_SHIFT', 0.8],
    ];
    let r = this.rng.range(0, pool.reduce((a, [, w]) => a + w, 0));
    for (const [k, w] of pool) if ((r -= w) <= 0) return trigger(sim, k);
  }
}

