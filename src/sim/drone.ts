/**
 * Drone agent: deterministic flight controller + task state machine.
 * Jev never flies drones; it assigns tasks. Everything here is plain code.
 */
import { DRONE, LAKE } from '../config';
import { angleLerp, clamp } from '../core/math';
import { heightAt } from '../world/layout';
import type { Pt } from '../world/layout';

export type Role = 'SCOUT' | 'SUPPRESSION' | 'LOGISTICS' | 'RELAY';
export type TaskKind =
  | 'IDLE' | 'SEARCH' | 'VERIFY' | 'SUPPRESS' | 'DELIVER' | 'CORRIDOR' | 'GUIDE'
  | 'RELAY' | 'RTB' | 'RESERVE' | 'MONITOR' | 'PATROL' | 'SWAP';
export type Status = 'LANDED' | 'AIRBORNE' | 'CHARGING' | 'LINK_LOST' | 'FAILED';

export interface Task {
  kind: TaskKind;
  objectiveId?: string;
  target: Pt;
  label: string; // e.g. "VERIFY C7"
  waypoints?: Pt[];
  detectionId?: string;
  civilianId?: string;
  swapTo?: Role;
  then?: Task;
}

export interface DroneHooks {
  onDrop(d: Drone, x: number, z: number): void;
  onDeliver(d: Drone, x: number, z: number): void;
  /** Returns false if the look was inconclusive (drone keeps orbiting and retries). */
  onVerifyComplete(d: Drone, detectionId: string): boolean;
  onCorridorFlown(d: Drone, civilianId: string): void;
  onSearchComplete(d: Drone, objectiveId: string): void;
  onLanded(d: Drone): void;
  guideTarget(civilianId: string): Pt | null;
}

export const ROLE_SENSORS: Record<Role, string> = {
  SCOUT: 'RGB + THERMAL',
  SUPPRESSION: 'RGB + THERMAL (NAV)',
  LOGISTICS: 'RGB + DEPTH',
  RELAY: 'RGB + MESH RADIO',
};

const G = 9.81;

export class Drone {
  x: number; y: number; z: number;
  vx = 0; vy = 0; vz = 0;
  yaw = 0; roll = 0; pitch = 0;
  rotor = Math.random() * 10;
  battery = 1;
  payload = 1; // 0..1 of role payload
  status: Status = 'LANDED';
  task: Task;
  phase = 0;
  phaseT = 0;
  thermalOK = true;
  linkOK = true;
  linkLostT = 0;
  launchAt = Infinity;
  prevLabel = 'STANDBY';
  sepX = 0; sepY = 0; sepZ = 0;
  totalDist = 0;
  private orbitA = Math.random() * Math.PI * 2;
  private wp = 0;

  constructor(public id: string, public index: number, public role: Role, public pad: Pt) {
    this.x = pad.x;
    this.z = pad.z;
    this.y = heightAt(pad.x, pad.z) + 0.6;
    this.task = { kind: 'IDLE', target: { ...pad }, label: 'STANDBY' };
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vz, this.vy);
  }
  get agl(): number {
    return this.y - heightAt(this.x, this.z);
  }
  get airborne(): boolean {
    return this.status === 'AIRBORNE' || this.status === 'LINK_LOST';
  }
  get available(): boolean {
    return (this.status === 'AIRBORNE' || this.status === 'LANDED') && this.battery > 0.28 && this.launchAt !== Infinity;
  }

  assign(task: Task): void {
    this.prevLabel = this.task.label;
    this.task = task;
    this.phase = 0;
    this.phaseT = 0;
    this.wp = 0;
  }

  /** One fixed simulation step. */
  update(dt: number, t: number, hooks: DroneHooks): void {
    this.rotor += dt * (this.status === 'LANDED' || this.status === 'CHARGING' ? 0 : 60);
    if (this.status === 'FAILED') return this.fall(dt);
    if (this.status === 'CHARGING') {
      this.phaseT += dt;
      this.battery = Math.min(1, this.battery + dt / DRONE.batterySwapSec);
      if (this.phaseT >= DRONE.batterySwapSec) {
        this.status = 'LANDED';
        this.battery = 1;
        if (this.task.kind === 'SWAP' && this.task.swapTo) {
          this.role = this.task.swapTo;
          this.payload = 1;
          if (this.task.then) this.assign(this.task.then);
          else this.assign({ kind: 'IDLE', target: { ...this.pad }, label: 'STANDBY' });
        } else {
          this.payload = 1;
          this.assign({ kind: 'IDLE', target: { ...this.pad }, label: 'STANDBY' });
        }
      }
      return;
    }
    if (this.status === 'LANDED') {
      const atPad = Math.hypot(this.task.target.x - this.pad.x, this.task.target.z - this.pad.z) < 30;
      if (t < this.launchAt || this.task.kind === 'RESERVE' || (this.task.kind === 'IDLE' && atPad)) return;
      this.status = 'AIRBORNE';
    }
    if (this.status === 'LINK_LOST') {
      this.linkLostT -= dt;
      if (this.linkLostT <= 0) this.status = 'AIRBORNE';
    }
    // Battery (SIM): drain scaled by speed and payload.
    const load = 1 + this.speed / 60 + (this.role === 'SUPPRESSION' ? this.payload * 0.18 : 0);
    this.battery = Math.max(0, this.battery - (dt / (DRONE.enduranceMin * 60)) * load);
    if (this.battery < 0.18 && this.task.kind !== 'RTB' && this.task.kind !== 'SWAP') {
      this.assign({ kind: 'RTB', target: { ...this.pad }, label: 'RTB · BATTERY' });
    }
    if (this.battery <= 0) {
      this.status = 'FAILED';
      return;
    }
    this.runTask(dt, hooks);
  }

  private runTask(dt: number, hooks: DroneHooks): void {
    const tk = this.task;
    this.phaseT += dt;
    switch (tk.kind) {
      case 'IDLE':
        // Unassigned airborne drones loiter where they were released, awaiting the next plan.
        return this.orbit(tk.target.x, tk.target.z, 55, DRONE.cruiseAGL, dt, 9);
      case 'RESERVE':
      case 'RTB':
      case 'SWAP':
        return this.flyTo(this.pad.x, this.pad.z, 45, dt, DRONE.maxSpeed, () => this.land(hooks));
      case 'SEARCH': {
        const wps = tk.waypoints ?? [tk.target];
        const p = wps[Math.min(this.wp, wps.length - 1)];
        this.flyTo(p.x, p.z, DRONE.searchAGL, dt, 14, () => {
          if (this.wp < wps.length - 1) this.wp++;
          else if (this.phase === 0) {
            this.phase = 1;
            hooks.onSearchComplete(this, tk.objectiveId ?? '');
          }
        }, 18);
        if (this.phase === 1) this.orbit(tk.target.x, tk.target.z, 90, DRONE.searchAGL, dt, 10);
        return;
      }
      case 'VERIFY':
        if (this.phase === 0) {
          this.flyTo(tk.target.x, tk.target.z, DRONE.cruiseAGL, dt, DRONE.maxSpeed, () => this.next(), 70);
        } else {
          this.orbit(tk.target.x, tk.target.z, 32, DRONE.verifyAGL, dt, 7);
          if (this.phase === 1 && this.phaseT > 6.5 && this.thermalOK) {
            if (hooks.onVerifyComplete(this, tk.detectionId ?? '')) this.phase = 2;
            else this.phaseT = 4;
          }
        }
        return;
      case 'SUPPRESS':
        return this.suppress(dt, hooks);
      case 'DELIVER':
        if (this.phase === 0) this.flyTo(tk.target.x + 14, tk.target.z, 30, dt, DRONE.maxSpeed, () => this.next(), 10);
        else if (this.phase === 1) {
          this.hover(tk.target.x + 14, tk.target.z, 14, dt);
          if (this.phaseT > 2.2) {
            hooks.onDeliver(this, tk.target.x + 8, tk.target.z);
            this.payload = 0;
            this.next();
          }
        } else this.orbit(tk.target.x, tk.target.z, 40, 45, dt, 8);
        return;
      case 'CORRIDOR': {
        const wps = tk.waypoints ?? [tk.target];
        const p = wps[Math.min(this.wp, wps.length - 1)];
        if (this.phase === 0) {
          this.flyTo(p.x, p.z, 42, dt, 15, () => {
            if (this.wp < wps.length - 1) this.wp++;
            else {
              this.phase = 1;
              hooks.onCorridorFlown(this, tk.civilianId ?? '');
            }
          }, 20);
        } else this.orbit(p.x, p.z, 45, 50, dt, 8);
        return;
      }
      case 'GUIDE': {
        const g = hooks.guideTarget(tk.civilianId ?? '');
        if (g) this.flyTo(g.x, g.z, 28, dt, 9, () => {}, 6);
        else this.orbit(tk.target.x, tk.target.z, 40, 50, dt, 8);
        return;
      }
      case 'RELAY':
        return this.phase === 0
          ? this.flyTo(tk.target.x, tk.target.z, DRONE.relayAGL, dt, DRONE.maxSpeed, () => this.next(), 25)
          : this.orbit(tk.target.x, tk.target.z, 18, DRONE.relayAGL, dt, 3);
      case 'MONITOR':
        return this.phase === 0
          ? this.flyTo(tk.target.x, tk.target.z, 110, dt, DRONE.maxSpeed, () => this.next(), 170)
          : this.orbit(tk.target.x, tk.target.z, 160, 110, dt, 13);
      case 'PATROL': {
        const wps = tk.waypoints ?? [tk.target];
        const p = wps[this.wp % wps.length];
        return this.flyTo(p.x, p.z, 60, dt, 13, () => (this.wp = (this.wp + 1) % wps.length), 25);
      }
    }
  }

  private suppress(dt: number, hooks: DroneHooks): void {
    const tk = this.task;
    const ph = this.phase;
    if (this.payload <= 0.01 && ph < 4) {
      this.phase = 4;
      this.phaseT = 0;
    }
    if (ph === 0) {
      // Approach from the upwind side at cruise altitude.
      const a = this.approachPoint(tk.target);
      this.flyTo(a.x, a.z, 60, dt, DRONE.maxSpeed, () => this.next(), 20);
    } else if (ph === 1) {
      this.hover(this.approachPoint(tk.target).x, this.approachPoint(tk.target).z, DRONE.suppressAGL, dt);
      if (this.agl < DRONE.suppressAGL + 6) this.next();
    } else if (ph === 2) {
      this.flyTo(tk.target.x, tk.target.z, DRONE.suppressAGL, dt, 9, () => {
        hooks.onDrop(this, tk.target.x, tk.target.z);
        this.payload = 0;
        this.next();
      }, 8);
    } else if (ph === 3) {
      this.flyTo(tk.target.x, tk.target.z, 70, dt, 8, () => {}, 10);
      if (this.phaseT > 3) this.next();
    } else if (ph === 4) {
      // Refill at the water source (SIM: hover-dip refill).
      this.flyTo(LAKE.x, LAKE.z, 8, dt, DRONE.maxSpeed, () => this.next(), 12);
    } else if (ph === 5) {
      this.hover(LAKE.x, LAKE.z, 5, dt);
      this.payload = Math.min(1, this.payload + dt / 8);
      if (this.payload >= 1) {
        this.phase = 0;
        this.phaseT = 0;
      }
    }
  }

  approachPoint(t: Pt): Pt {
    const dx = this.x - t.x, dz = this.z - t.z;
    const L = Math.hypot(dx, dz) || 1;
    return { x: t.x + (dx / L) * 90, z: t.z + (dz / L) * 90 };
  }

  private next(): void {
    this.phase++;
    this.phaseT = 0;
  }

  private land(hooks: DroneHooks): void {
    this.hover(this.pad.x, this.pad.z, 0.6, this.lastDt);
    if (this.agl < 1.2 && this.speed < 1.5) {
      this.status = 'CHARGING';
      this.phaseT = this.battery > 0.9 && this.task.kind !== 'SWAP' ? DRONE.batterySwapSec : 0;
      this.vx = this.vy = this.vz = 0;
      this.y = heightAt(this.pad.x, this.pad.z) + 0.6;
      hooks.onLanded(this);
    }
  }

  private lastDt = 1 / 30;

  /** Arrive-steering toward (x,z) at an AGL; calls done() inside radius. */
  private flyTo(x: number, z: number, agl: number, dt: number, vmax: number, done: () => void, radius = 4): void {
    this.lastDt = dt;
    const dx = x - this.x, dz = z - this.z;
    const d = Math.hypot(dx, dz);
    const sp = Math.min(vmax, d * 0.35 + 0.5);
    const dvx = d > 0.01 ? (dx / d) * sp : 0;
    const dvz = d > 0.01 ? (dz / d) * sp : 0;
    this.integrate(dvx, dvz, this.targetY(agl), dt);
    if (d < radius) done();
  }
  private hover(x: number, z: number, agl: number, dt: number): void {
    const dx = x - this.x, dz = z - this.z;
    this.integrate(dx * 0.6, dz * 0.6, heightAt(x, z) + agl, dt, agl < 3);
  }
  private orbit(cx: number, cz: number, r: number, agl: number, dt: number, speed: number): void {
    const a = Math.atan2(this.z - cz, this.x - cx);
    const d = Math.hypot(this.x - cx, this.z - cz);
    const w = speed / r;
    this.orbitA = a + w * dt * 6;
    const tx = cx + Math.cos(this.orbitA) * r, tz = cz + Math.sin(this.orbitA) * r;
    const radial = (r - d) * 0.5;
    const ex = tx - this.x, ez = tz - this.z;
    const L = Math.hypot(ex, ez) || 1;
    this.integrate((ex / L) * speed + Math.cos(a) * radial, (ez / L) * speed + Math.sin(a) * radial, this.targetY(agl), dt);
  }

  private targetY(agl: number): number {
    // Terrain following with look-ahead so drones climb before ridges.
    const la = 5;
    const h = Math.max(heightAt(this.x, this.z), heightAt(this.x + this.vx * la, this.z + this.vz * la));
    return h + agl;
  }

  private integrate(dvx: number, dvz: number, ty: number, dt: number, allowLow = false): void {
    const dvy = clamp((ty - this.y) * 0.9, -DRONE.maxClimb, DRONE.maxClimb);
    let ax = (dvx - this.vx) * 1.7 + this.sepX;
    let az = (dvz - this.vz) * 1.7 + this.sepZ;
    const ay = (dvy - this.vy) * 2.2 + this.sepY;
    const am = Math.hypot(ax, az);
    if (am > DRONE.maxAccel) {
      ax *= DRONE.maxAccel / am;
      az *= DRONE.maxAccel / am;
    }
    this.vx += ax * dt;
    this.vz += az * dt;
    this.vy += clamp(ay, -6, 6) * dt;
    const sp = Math.hypot(this.vx, this.vz);
    if (sp > DRONE.maxSpeed) {
      this.vx *= DRONE.maxSpeed / sp;
      this.vz *= DRONE.maxSpeed / sp;
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y += this.vy * dt;
    this.totalDist += sp * dt;
    const floor = heightAt(this.x, this.z) + (allowLow ? 0.5 : 8);
    if (this.y < floor) {
      this.y = floor;
      this.vy = Math.max(0, this.vy);
    }
    // Attitude: multirotors tilt into acceleration and into airspeed (drag).
    if (sp > 1.5) this.yaw = angleLerp(this.yaw, Math.atan2(this.vx, this.vz), Math.min(1, dt * 2.2));
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const aFwd = ax * fx + az * fz;
    const aLat = ax * fz - az * fx;
    const tp = clamp(Math.atan2(aFwd, G) + sp * 0.014, -0.45, 0.45);
    const tr = clamp(Math.atan2(-aLat, G) * 1.6, -0.55, 0.55);
    this.pitch += (tp - this.pitch) * Math.min(1, dt * 5);
    this.roll += (tr - this.roll) * Math.min(1, dt * 5);
  }

  private fall(dt: number): void {
    const floor = heightAt(this.x, this.z) + 0.4;
    if (this.y > floor) {
      this.vy -= G * dt * 0.6;
      this.x += this.vx * dt;
      this.z += this.vz * dt;
      this.y = Math.max(floor, this.y + this.vy * dt);
      this.vx *= 0.99;
      this.vz *= 0.99;
      this.roll += dt * 2;
    }
  }
}
