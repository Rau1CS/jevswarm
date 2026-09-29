/**
 * Simulation hub: owns world state, steps it at a fixed rate, bridges drone hooks,
 * sensor events and the JevCoordinator, and exposes events for rendering/UI.
 */
import { BASE_POS, SIM_STEP } from '../config';
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
import { AGENTS, capacity, isAbstract, loadout, type AgentId, type Loadout, type PlatformId } from './loadout/catalogue';
import { Ledger } from './ledger';
import { Logistics } from './logistics';
import { applyAgent, hottestCell } from './suppression';
import { CallCenter } from '../calls/callCenter';
import { CallGenerator } from '../calls/generator';
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
  /** Suppression platform + agent. Default: the legacy 120 L concept with the abstract effect. */
  loadout?: { platform: PlatformId; agent: AgentId };
  /** How suppression drones are tasked: coordinator (Jev/fallback), nearest-fire rule, or none. */
  policy?: Policy;
  /** Seconds of fire growth before the mission starts (default 30). */
  preburnSec?: number;
  ignitionRadius?: number;
  /** Later ignitions (spot fires), mission time in seconds. */
  spotFires?: { t: number; x: number; z: number }[];
  /** SIM fuel dryness multiplier on spread rate (default 1). */
  spreadMult?: number;
  /** Optional forward refill truck position. */
  forwardStation?: Pt | null;
  /** Fleet role mix as fractions [scout, suppression, logistics, relay]; default 0.5/0.25/0.09/0.16. */
  mix?: [number, number, number, number];
  /** Common random numbers in the fire model (paired policy comparisons). */
  crn?: boolean;
  /** SIM knockdown application density for plain water at full intensity (L/m², default 1). */
  knockdownDensity?: number;
  name?: string;
}

export type Policy = 'COORDINATOR' | 'NEAREST' | 'NONE';

export interface Package { x: number; y: number; z: number; vy: number; landed: boolean }

export function roleFor(i: number, n: number, mix: [number, number, number, number] = [0.5, 0.25, 0.09, 0.16]): Role {
  // Default 24-drone layout: D01–D12 scouts, D13–D18 suppression, D19–D20 logistics, D21–D24 relay.
  const f = i / n;
  const [a, b, c] = mix;
  if (f < a) return 'SCOUT';
  if (f < a + b) return 'SUPPRESSION';
  if (f < a + b + c) return 'LOGISTICS';
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
  readonly lo: Loadout;
  readonly policy: Policy;
  readonly ledger: Ledger;
  readonly logistics: Logistics;
  private spots: { t: number; x: number; z: number }[];
  readonly calls: CallCenter;
  readonly callGen: CallGenerator;
  /** Free simulation: random emergency calls arrive (the demo scripts its own). */
  autoCalls = false;
  private nextCallT = 20;
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
    this.lo = loadout(opts.loadout?.platform ?? 'CONCEPT120', opts.loadout?.agent ?? 'ABSTRACT');
    this.policy = opts.policy ?? 'COORDINATOR';
    this.ledger = new Ledger(this.lo);
    this.logistics = new Logistics(opts.forwardStation ?? null);
    this.spots = [...(opts.spotFires ?? [])].sort((a, b) => a.t - b.t);
    this.fire.spreadMult = opts.spreadMult ?? 1;
    if (opts.crn) this.fire.crnSeed = (opts.seed * 2654435761) >>> 0;
    this.fire.ignite(opts.fireOrigin.x, opts.fireOrigin.z, opts.ignitionRadius ?? 30);
    // Pre-burn so the opening shot already shows an established fire.
    for (let i = 0; i < (opts.preburnSec ?? 30) / 0.2; i++) this.fire.update(0.2);
    this.civilians = spawnCivilians(new Rng(opts.seed + 3), opts.civilians, opts.hero);
    this.vehicles = spawnVehicles();
    const cols = Math.max(5, Math.ceil(Math.sqrt(opts.drones)));
    // Heavy-lift airframes (≈1.9 m, drawn at 5×) need wider pad spacing than quads.
    const gap = this.lo.platform.airframe === 'HEAVY' ? 22 : 12;
    for (let i = 0; i < opts.drones; i++) {
      const pad = { x: BASE_POS.x - 60 + (i % cols) * gap, z: BASE_POS.z - 40 + Math.floor(i / cols) * gap };
      this.drones.push(new Drone(`D${String(i + 1).padStart(2, '0')}`, i, roleFor(i, opts.drones, opts.mix), pad));
    }
    const pf = this.lo.platform, cap = capacity(this.lo);
    for (const d of this.drones) {
      d.spec = { capacity: cap, maxSpeed: pf.maxSpeed.v, enduranceMin: pf.enduranceMin.v, dischargeSec: cap / pf.dischargeLps.v, pumpLps: pf.pumpLps.v };
      d.releaseHook = (q) => this.logistics.release(q.id);
    }
    this.callGen = new CallGenerator(new Rng(opts.seed + 5));
    this.calls = new CallCenter({
      t: () => this.t,
      client: () => (this.coordinator.mode === 'JEV' ? this.coordinator.client : null),
      log: (title, lines, level, by) => this.emitLog({ t: this.t, title, lines, level, by }),
      banner: (title, lines, level) => this.banner(title, lines, level),
      createIncident: (p, conf, civId) => this.sensors.create(p.x, p.z, conf, civId, 'CALL', this.t, this.sensorEvents).id,
      replan: (reason) => this.coordinator.trigger(reason),
      detectionOpen: (detId) => {
        const det = this.sensors.detections.find((d) => d.id === detId);
        if (!det || det.status === 'DISMISSED') return false;
        const civ = det.truthCivId && det.status === 'CONFIRMED' ? this.civilians.find((c) => c.id === det.truthCivId) : undefined;
        return civ?.behavior !== 'SAFE';
      },
    });
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
      loadout: this.lo, policy: this.policy,
      callInfo: (detId) => this.calls.callInfo(detId),
      fireReports: this.calls.activeFireReports(this.t),
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
      this.stats.drops++;
      if (isAbstract(this.lo)) {
        const red = this.fire.suppress(x, z, 40, 0.95);
        this.fx({ type: 'drop', x: d.x, y: d.y, z: d.z, droneId: d.id, amount: red });
        const effect = red > 0.05 ? `fire intensity −${Math.round(red * 100)}%` : 'pre-wetting fuel ahead of front';
        this.emitLog({ t: this.t, title: 'SUPPRESSION DROP', lines: [d.id, '120 L equivalent (abstract effect)', effect], level: 'ok' });
        this.coordinator.trigger('suppression drop');
        return 1.2;
      }
      const litres = d.payload * capacity(this.lo);
      const app = applyAgent(this.fire, this.lo, x, z, litres, this.opts.knockdownDensity);
      this.ledger.record(app, this.t, d.id);
      this.fx({ type: 'drop', x: d.x, y: d.y, z: d.z, droneId: d.id, amount: app.knocked ? 1 : app.effective / Math.max(1, litres) });
      const u = this.lo.agent.unit;
      const pre = this.lo.agent.mission === 'PRETREAT';
      const what = pre
        ? (app.effective > 0 ? 'retardant on unburned fuel ahead of the fire' : 'missed: fuel already burning or burnt')
        : app.knocked ? 'hotspot knocked down' : app.effective > 0 ? `flaming cell ${Math.round((1 - app.intensityAfter / Math.max(0.01, app.intensityBefore)) * 100)}% suppressed` : 'no flame under the drop (pre-wetting)';
      this.emitLog({ t: this.t, title: pre ? 'RETARDANT DROP' : 'SUPPRESSION DROP', lines: [`${d.id} · ${litres.toFixed(1)} ${u} ${AGENTS[this.lo.agent.id].name.toLowerCase()}`, `${app.onTarget.toFixed(1)} ${u} on target (${Math.round((app.onTarget / Math.max(0.01, litres)) * 100)}%)`, what], level: 'ok' });
      this.coordinator.trigger('suppression drop');
      return Math.max(1, litres / this.lo.platform.dischargeLps.v);
    },
    refillStation: (d) => {
      const pf = this.lo.platform;
      return this.logistics.pick(this.lo, d, pf.maxSpeed.v, capacity(this.lo) / pf.pumpLps.v).id;
    },
    requestRefill: (d, st) => this.logistics.request(st, d.id),
    releaseRefill: (d, queued) => {
      this.logistics.release(d.id);
      if (!isAbstract(this.lo)) this.ledger.queued(queued);
    },
    refillPos: (d, st) => this.logistics.slotPos(st, d.id),
    aimPoint: (_d, target) => {
      if (isAbstract(this.lo) || this.lo.agent.mission !== 'DIRECT') return target;
      // SIM: the thermal camera finds flaming fuel within ~90 m of the planned point on the run-in.
      const k = hottestCell(this.fire, target.x, target.z, 90);
      return k >= 0 ? this.fire.cellCenter(k % this.fire.n, (k / this.fire.n) | 0) : target;
    },
    stationPos: (st) => {
      const s = this.logistics.get(st) ?? this.logistics.stations[1];
      return { x: s.x, z: s.z, dip: s.dip };
    },
    onDeliver: (d, x, z) => {
      this.packages.push({ x, y: d.y - 2, z, vy: 0, landed: false });
      // A supply drop can be flown to a call-reported incident before anyone is confirmed.
      const det = this.sensors.detections.find((q) => q.id === d.task.detectionId);
      const civ = this.civilians.find((c) => c.id === d.task.civilianId) ?? (det?.truthCivId ? this.civilians.find((c) => c.id === det.truthCivId && dist2(c.x, c.z, x, z) < 250) : undefined);
      if (civ) civ.supplied = true;
      const inc = det ? this.calls.callInfo(det.id)?.incident : undefined;
      if (inc) inc.supplied = true;
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
      if (by === 'CALL') { this.coordinator.trigger('call incident'); return; } // the call centre logs its own dispatch
      this.emitLog({ t: this.t, title: 'THERMAL ANOMALY', lines: [`sector ${det.sector} · ${by}`, `confidence ${det.conf.toFixed(2)}`], level: 'warn' });
      this.coordinator.trigger('thermal detection');
    },
  };

  step(dt: number): void {
    this.t += dt;
    while (this.spots.length && this.spots[0].t <= this.t) {
      const sp = this.spots.shift()!;
      this.fire.ignite(sp.x, sp.z, 14);
      this.emitLog({ t: this.t, title: 'SPOT FIRE', lines: [`new ignition ${sectorOf(sp.x, sp.z)}`, 'embers ahead of the main fire'], level: 'warn' });
      this.coordinator.trigger('spot fire');
    }
    if (this.autoCalls && this.coordinator.enabled && this.t >= this.nextCallT) {
      const front = this.fire.frontCells().slice(0, 200).map((k) => this.fire.cellCenter(k % this.fire.n, (k / this.fire.n) | 0));
      this.calls.receive(this.callGen.next(this.t, this.civilians, front));
      this.nextCallT = this.t + this.rng.range(22, 40);
    }
    this.fire.update(dt);
    for (const d of this.drones) if (d.role === 'SUPPRESSION' && d.airborne) this.ledger.flightSec += dt;
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
      areaHa: this.fire.stats().areaHa,
      suppression: this.ledger.summary(this.fire, this.drones.filter((d) => d.role === 'SUPPRESSION').length),
    };
  }
}
