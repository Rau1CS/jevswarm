/** Records mission state once per sim second for the scrubbable 3D replay. */
import type { Role, Status } from './drone';
import type { Simulation } from './simulation';

const ROLES: Role[] = ['SCOUT', 'SUPPRESSION', 'LOGISTICS', 'RELAY'];
const STATUSES: Status[] = ['LANDED', 'AIRBORNE', 'CHARGING', 'LINK_LOST', 'FAILED'];

export interface Frame {
  t: number;
  drones: Float32Array; // x y z yaw pitch roll role status rotor
  fire: Uint8Array;
  civs: Float32Array; // x z visible
  dets: { x: number; z: number; conf: number; status: string }[];
  events: string[];
}

export class Recorder {
  frames: Frame[] = [];
  private nextT = 0;
  private pendingEvents: string[] = [];

  note(title: string): void {
    this.pendingEvents.push(title);
  }

  capture(sim: Simulation): void {
    if (sim.t < this.nextT) return;
    this.nextT = sim.t + 1;
    const d = new Float32Array(sim.drones.length * 9);
    sim.drones.forEach((q, i) => {
      d.set([q.x, q.y, q.z, q.yaw, q.pitch, q.roll, ROLES.indexOf(q.role), STATUSES.indexOf(q.status), q.rotor], i * 9);
    });
    const c = new Float32Array(sim.civilians.length * 3);
    sim.civilians.forEach((q, i) => c.set([q.x, q.z, q.indoor || q.behavior === 'SAFE' ? 0 : 1], i * 3));
    this.frames.push({
      t: sim.t,
      drones: d,
      fire: sim.fire.snapshot(),
      civs: c,
      dets: sim.sensors.detections.map((q) => ({ x: q.x, z: q.z, conf: q.conf, status: q.status })),
      events: this.pendingEvents.splice(0),
    });
  }

  /** Restore frame i into the (stopped) simulation for rendering. */
  apply(sim: Simulation, i: number, frac: number): void {
    const a = this.frames[i], b = this.frames[Math.min(i + 1, this.frames.length - 1)];
    if (!a) return;
    sim.t = a.t + (b.t - a.t) * frac;
    sim.drones.forEach((q, k) => {
      const o = k * 9;
      if (o >= a.drones.length) return;
      const L = (j: number) => a.drones[o + j] + (b.drones[o + j] - a.drones[o + j]) * frac;
      q.x = L(0); q.y = L(1); q.z = L(2);
      q.yaw = a.drones[o + 3]; q.pitch = L(4); q.roll = L(5);
      q.role = ROLES[a.drones[o + 6]];
      q.status = STATUSES[a.drones[o + 7]];
      q.rotor += 0.6;
    });
    sim.civilians.forEach((q, k) => {
      q.x = a.civs[k * 3] + (b.civs[k * 3] - a.civs[k * 3]) * frac;
      q.z = a.civs[k * 3 + 1] + (b.civs[k * 3 + 1] - a.civs[k * 3 + 1]) * frac;
      q.indoor = a.civs[k * 3 + 2] < 0.5;
    });
    if (this.lastFire !== i) {
      sim.fire.restore(a.fire);
      this.lastFire = i;
    }
    sim.sensors.detections.forEach((q, k) => {
      const s = a.dets[k];
      if (!s) {
        q.status = 'DISMISSED';
        return;
      }
      q.x = s.x; q.z = s.z; q.conf = s.conf; q.status = s.status as typeof q.status;
    });
  }
  private lastFire = -1;

  get duration(): number {
    return this.frames.length ? this.frames[this.frames.length - 1].t : 0;
  }
}
