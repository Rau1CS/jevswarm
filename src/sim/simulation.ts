/**
 * Simulation hub: owns world state, steps it at a fixed rate, bridges drone hooks,
 * sensor events and the JevCoordinator, and exposes events for rendering/UI.
 */
import { BASE_POS, DRONE, SIM_STEP } from '../config';
import { Rng, dist2, fmtClock, sectorOf } from '../core/math';
import { JevCoordinator } from '../jev/coordinator';
import type { CoordView } from '../jev/objectives';
import { BASE_COMM_RANGE, RELAY_COMM_RANGE } from '../jev/planner';
import type { LogEntry, Objective, PlanChange, Judgment } from '../jev/types';
import { spawnCivilians, startGuided, updateCivilian, type Civilian } from './civilians';
import { Drone, type DroneHooks, type Role } from './drone';
import { FireModel } from './fire';
import { Sensors, type Detection } from './sensors';
import { spawnVehicles, updateVehicle, type Vehicle } from './vehicles';
import { heightAt, type Pt } from '../world/layout';

export interface FxEvent {
  type: 'drop' | 'deliver' | 'confirm' | 'detect' | 'failure';
  x: number; y: number; z: number;
  droneId?: string;
  amount?: number;
}
export interface SimListeners {
  log(e: LogEntry): void;
  banner(title: string, lines: string[], level: 'warn' | 'crit' | 'info'): void;
  priority(title: string, lines: string[], o: Objective): void;
  fx(e: FxEvent): void;
  replan(changes: PlanChange[], j: Judgment): void;
}

export interface ScenarioOpts {
  seed: number;
  drones: number;
  civilians: number;
  hero: boolean;
  fireOrigin: Pt;
  wind: { fromDeg: number; speed: number };
  sensorQuality: number;
}

export interface Package { x: number; y: number; z: number; vy: number; landed: boolean }

export function roleFor(i: number, n: number): Role {
  // 24-drone layout: D01–D12 scouts, D13–D18 suppression, D19–D20 logistics, D21–D24 relay.
  const f = i / n;
  if (f < 0.5) return 'SCOUT';
  if (f < 0.75) return 'SUPPRESSION';
  if (f < 0.84) return 'LOGISTICS';
  return 'RELAY';
}

export class Simulation {
  rng: Rng;
  fire: FireModel;
  sensors: Sensors;
  drones: Drone[] = [];
  civilians: Civilian[] = [];
  vehicles: Vehicle[] = [];
  packages: Package[] = [];
  roadBlocks: Pt[] = [];
  coordinator: JevCoordinator;
  t = 0;
  timeScale = 1;
  paused = false;
  log: LogEntry[] = [];
  arrival: Float64Array;
  stats = { drops: 0, dronesLost: 0, falsePositives: 0, confirmed: 0 };
  private acc = 0;
  private commAcc = 0;
  private listeners: SimListeners[] = [];
  private lastWindFrom = 0;

  constructor(public opts: ScenarioOpts) {
    this.rng = new Rng(opts.seed);
    this.fire = new FireModel(new Rng(opts.seed + 1));
    this.sensors = new Sensors(new Rng(opts.seed + 2));
    this.sensors.quality = opts.sensorQuality;
    this.arrival = new Float64Array(this.fire.n * this.fire.n).fill(Infinity);
    this.fire.setWind(opts.wind, true);
    this.lastWindFrom = opts.wind.fromDeg;
    this.fire.ignite(opts.fireOrigin.x, opts.fireOrigin.z, 30);
    // Pre-burn so the opening shot already shows an established fire.
    for (let i = 0; i < 150; i++) this.fire.update(0.2);
    this.civilians = spawnCivilians(new Rng(opts.seed + 3), opts.civilians, opts.hero);
    this.vehicles = spawnVehicles();
    const cols = Math.max(5, Math.ceil(Math.sqrt(opts.drones)));
    for (let i = 0; i < opts.drones; i++) {
      const pad = { x: BASE_POS.x - 60 + (i % cols) * 12, z: BASE_POS.z - 40 + Math.floor(i / cols) * 12 };
      this.drones.push(new Drone(`D${String(i + 1).padStart(2, '0')}`, i, roleFor(i, opts.drones), pad));
    }
    this.coordinator = new JevCoordinator({
      log: (e) => this.emitLog(e),
      replanned: (c, j) => this.listeners.forEach((l) => l.replan(c, j)),
      priorityChange: (title, lines, o) => this.listeners.forEach((l) => l.priority(title, lines, o)),
    });
  }

  on(l: SimListeners): void {
    this.listeners.push(l);
  }
  emitLog(e: LogEntry): void {
    this.log.push(e);
    if (this.log.length > 400) this.log.shift();
    this.listeners.forEach((l) => l.log(e));
  }
  banner(title: string, lines: string[], level: 'warn' | 'crit' | 'info' = 'warn'): void {
    this.listeners.forEach((l) => l.banner(title, lines, level));
  }
  fx(e: FxEvent): void {
    this.listeners.forEach((l) => l.fx(e));
  }

  /** Sequential launch: drones lift off one after another. */
  launchAll(start: number, interval = 0.35): void {
    this.drones.forEach((d, i) => (d.launchAt = start + i * interval));
    this.coordinator.enabled = true;
    this.coordinator.trigger('swarm launch');
  }

  view(): CoordView {
    return {
      t: this.t, fire: this.fire, arrival: this.arrival, sensors: this.sensors, drones: this.drones,
      directive: this.coordinator.directive, corridors: this.coordinator.corridors,
      confirmedCiv: (detId) => {
        const det = this.sensors.detections.find((d) => d.id === detId);
        return det?.status === 'CONFIRMED' && det.truthCivId ? this.civilians.find((c) => c.id === det.truthCivId) : undefined;
      },
    };
  }

  /** Advance by real-time dt (seconds), scaled, in fixed steps. */
  advance(realDt: number): void {
    if (this.paused) return;
    this.acc += Math.min(realDt, 0.1) * this.timeScale;
    let n = 0;
    while (this.acc >= SIM_STEP && n++ < 20) {
      this.acc -= SIM_STEP;
      this.step(SIM_STEP);
    }
  }

  readonly hooks: DroneHooks = {
    onDrop: (d, x, z) => {
      const red = this.fire.suppress(x, z, 40, 0.95);
      this.stats.drops++;
      this.fx({ type: 'drop', x: d.x, y: d.y, z: d.z, droneId: d.id, amount: red });
      const effect = red > 0.05 ? `fire intensity −${Math.round(red * 100)}%` : 'pre-wetting fuel ahead of front';
      this.emitLog({ t: this.t, title: 'SUPPRESSION DROP', lines: [d.id, `${DRONE.suppressantLitres} L equivalent (SIM)`, effect], level: 'ok' });
      this.coordinator.trigger('suppression drop');
    },
    onDeliver: (d, x, z) => {
      this.packages.push({ x, y: d.y - 2, z, vy: 0, landed: false });
      const civ = this.civilians.find((c) => c.id === d.task.civilianId);
      if (civ) civ.supplied = true;
      this.fx({ type: 'deliver', x, y: d.y, z, droneId: d.id });
      this.emitLog({ t: this.t, title: 'SUPPLY DROP', lines: [`${d.id} → ${sectorOf(x, z)}`, 'water · mask · radio beacon'], level: 'ok' });
      this.coordinator.trigger('supplies delivered');
    },
    onVerifyComplete: (d, detId) => {
      const pending = this.sensors.detections.find((q) => q.id === detId);
      if (pending && pending.status === 'POSSIBLE' && this.t < pending.holdUntil) return false;
      const det = this.sensors.verify(detId, this.t);
      if (!det) return true;
      if (det.status === 'CONFIRMED') {
        const civ = this.civilians.find((c) => c.id === det.truthCivId);
        if (civ && !civ.confirmed) {
          civ.confirmed = true;
          civ.confirmedAt = this.t;
          this.stats.confirmed++;
        }
        this.fx({ type: 'confirm', x: det.x, y: 0, z: det.z, droneId: d.id });
        this.emitLog({ t: this.t, title: 'HUMAN CONFIRMED', lines: [`${det.id} · sector ${det.sector}`, `verified by ${d.id} (RGB + thermal)`], level: 'ok' });
        this.banner('HUMAN CONFIRMED', [`SECTOR ${det.sector}`, `VERIFIED BY ${d.id}`], 'info');
        const cor = this.coordinator.corridors.get(det.id);
        if (civ && cor?.flown && cor.route) {
          startGuided(civ, cor.route);
          cor.guided = true;
        }
      } else {
        this.stats.falsePositives++;
        this.emitLog({ t: this.t, title: 'THERMAL FALSE POSITIVE', lines: [`${det.id} dismissed by ${d.id}`, 'hot ground / debris'], level: 'warn' });
      }
      this.coordinator.trigger('verification result');
      return true;
    },
    onCorridorFlown: (d, id) => {
      const det = this.sensors.detections.find((q) => q.id === d.task.detectionId);
      const cor = det ? this.coordinator.corridors.get(det.id) : undefined;
      if (!det || !cor || cor.flown) return;
      if (!cor.route) {
        this.emitLog({ t: this.t, title: 'NO SAFE CORRIDOR', lines: [`${det.sector} · every route crosses predicted fire`, 'advise shelter in place · supplies prioritised'], level: 'warn' });
        cor.flown = true; // searched; no GUIDE slot is created without a route
        return;
      }
      cor.flown = true;
      const len = cor.route ? cor.route.reduce((L, p, i, a) => (i ? L + dist2(p.x, p.z, a[i - 1].x, a[i - 1].z) : 0), 0) : 0;
      this.emitLog({ t: this.t, title: 'SAFE CORRIDOR IDENTIFIED', lines: [`${d.id} · ${det.sector} → safe zone`, `${(len / 1000).toFixed(2)} km, clear of predicted fire`], level: 'ok' });
      this.banner('SAFE CORRIDOR IDENTIFIED', [`${det.sector} → SAFE ZONE`, `${(len / 1000).toFixed(2)} KM`], 'info');
      const civ = this.civilians.find((c) => c.id === id || c.id === det.truthCivId);
      if (civ && det.status === 'CONFIRMED' && cor.route) {
        startGuided(civ, cor.route);
        cor.guided = true;
      }
      this.coordinator.trigger('corridor found');
    },
    onSearchComplete: (d, oid) => {
      this.emitLog({ t: this.t, title: 'SECTOR SEARCHED', lines: [`${oid.replace('SRCH_', '')} · ${d.id}`], level: 'info' });
      this.coordinator.trigger('sector searched');
    },
    onLanded: () => {},
    guideTarget: (civId) => {
      const c = this.civilians.find((q) => q.id === civId);
      if (!c || c.behavior !== 'GUIDED') return null;
      const p = c.path[Math.min(c.pathI, c.path.length - 1)];
      const dx = p.x - c.x, dz = p.z - c.z, L = Math.hypot(dx, dz) || 1;
      return { x: c.x + (dx / L) * 22, z: c.z + (dz / L) * 22 };
    },
  };

  readonly sensorEvents = {
    onNewDetection: (det: Detection, by: string) => {
      this.fx({ type: 'detect', x: det.x, y: 0, z: det.z, droneId: by });
      const call = by === 'CALL';
      this.emitLog({ t: this.t, title: call ? 'CIVILIAN REPORTED' : 'THERMAL ANOMALY', lines: [`sector ${det.sector} · ${call ? 'emergency call' : by}`, `confidence ${det.conf.toFixed(2)}`], level: 'warn' });
      this.coordinator.trigger('thermal detection');
    },
  };

  step(dt: number): void {
    this.t += dt;
    this.fire.update(dt);
    for (const d of this.drones) d.update(dt, this.t, this.hooks);
    this.separation();
    this.sensors.update(dt, this.t, this.drones, this.civilians, this.fire, this.sensorEvents);
    for (const c of this.civilians) {
      const was = c.behavior;
      updateCivilian(c, dt, this.fire, this.rng);
      if (was !== 'SAFE' && c.behavior === 'SAFE' && c.confirmed) {
        this.emitLog({ t: this.t, title: 'CIVILIAN SAFE', lines: [`${c.id} reached the safe zone`], level: 'ok' });
      }
    }
    for (const v of this.vehicles) updateVehicle(v, dt, this.fire, this.roadBlocks);
    for (const p of this.packages) {
      if (p.landed) continue;
      p.vy = Math.max(p.vy - 9.81 * dt, -6); // small parachute
      p.y += p.vy * dt;
      const g = heightAt(p.x, p.z) + 0.8;
      if (p.y <= g) { p.y = g; p.landed = true; }
    }
    this.commAcc += dt;
    if (this.commAcc > 0.5) {
      this.commAcc = 0;
      this.updateComms();
      this.checkWind();
      for (const d of this.drones) {
        if (d.status === 'FAILED' && !d.task.label.startsWith('LOST')) {
          d.task = { ...d.task, label: 'LOST' };
          this.stats.dronesLost++;
          this.emitLog({ t: this.t, title: 'DRONE LOST', lines: [`${d.id} forced landing ${sectorOf(d.x, d.z)}`], level: 'crit' });
          this.coordinator.trigger('drone lost');
        }
      }
    }
    this.coordinator.tick(this.view());
  }

  private separation(): void {
    const R = 22;
    const ds = this.drones.filter((d) => d.airborne);
    for (const d of this.drones) d.sepX = d.sepY = d.sepZ = 0;
    for (let i = 0; i < ds.length; i++) {
      const a = ds[i];
      for (let j = i + 1; j < ds.length; j++) {
        const b = ds[j];
        const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > R * R || d2 < 1e-4) continue;
        const d = Math.sqrt(d2);
        const f = ((R - d) / R) * 6;
        a.sepX += (dx / d) * f; a.sepY += (dy / d) * f * 0.6; a.sepZ += (dz / d) * f;
        b.sepX -= (dx / d) * f; b.sepY -= (dy / d) * f * 0.6; b.sepZ -= (dz / d) * f;
      }
    }
  }

  private updateComms(): void {
    const relays = this.drones.filter((d) => d.airborne && d.task.kind === 'RELAY' && d.phase >= 1);
    const linked = new Set<Drone>();
    const frontier = relays.filter((r) => dist2(r.x, r.z, BASE_POS.x, BASE_POS.z) < BASE_COMM_RANGE);
    frontier.forEach((r) => linked.add(r));
    while (frontier.length) {
      const r = frontier.pop()!;
      for (const o of relays) if (!linked.has(o) && dist2(o.x, o.z, r.x, r.z) < RELAY_COMM_RANGE * 1.4) { linked.add(o); frontier.push(o); }
    }
    for (const d of this.drones) {
      d.linkOK = d.status !== 'LINK_LOST' && (dist2(d.x, d.z, BASE_POS.x, BASE_POS.z) < BASE_COMM_RANGE || [...linked].some((r) => dist2(d.x, d.z, r.x, r.z) < RELAY_COMM_RANGE));
    }
  }

  private checkWind(): void {
    const w = this.fire.wind.fromDeg;
    let d = w - this.lastWindFrom;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    if (Math.abs(d) > 25) {
      this.coordinator.windNote = `wind shifted from ${Math.round(this.lastWindFrom)}° to ${Math.round(w)}° at ${fmtClock(this.t)}`;
      this.lastWindFrom = w;
    }
  }

  /** Mission metrics for the results screen. */
  results() {
    const found = this.civilians.filter((c) => c.confirmed || this.sensors.detections.some((d) => d.truthCivId === c.id && d.status !== 'DISMISSED'));
    const times = this.civilians
      .map((c) => this.sensors.detections.find((d) => d.truthCivId === c.id)?.firstT)
      .filter((x): x is number => x !== undefined);
    return {
      located: found.length,
      total: this.civilians.length,
      confirmed: this.civilians.filter((c) => c.confirmed).length,
      safe: this.civilians.filter((c) => c.behavior === 'SAFE').length,
      avgDetection: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
      searchedKm2: this.sensors.searchedKm2(),
      containment: this.fire.stats().containment,
      dronesLost: this.stats.dronesLost,
      replans: this.coordinator.replans,
      decisions: this.coordinator.decisions,
      jevCalls: this.coordinator.jevCalls,
      drops: this.stats.drops,
      falsePositives: this.stats.falsePositives,
    };
  }
}
