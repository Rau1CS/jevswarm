/**
 * Sensor simulation (SIM abstraction): thermal detection of civilians, false positives,
 * search coverage. Produces uncertain Detections — the only civilian info Jev receives.
 */
import { COVER_CELL, COVER_N, HALF } from '../config';
import { Rng, clamp, dist2, sectorOf } from '../core/math';
import type { Civilian } from './civilians';
import type { Drone } from './drone';
import type { FireModel } from './fire';

export type DetStatus = 'POSSIBLE' | 'CONFIRMED' | 'DISMISSED';

export interface Detection {
  id: string;
  x: number; z: number; // estimated position (noisy)
  conf: number;
  status: DetStatus;
  sector: string;
  firstT: number;
  lastT: number;
  by: string; // drone id that first saw it
  /** Ground truth link — hidden from the coordinator/Jev. */
  truthCivId: string | null;
  verifier: string | null;
  /** Demo curation: verification stays inconclusive until this sim time. */
  holdUntil: number;
}

export interface SensorEvents {
  onNewDetection(d: Detection, by: string): void;
}

export class Sensors {
  readonly coverage = new Uint8Array(COVER_N * COVER_N);
  detections: Detection[] = [];
  private acc = 0;
  private nextId = 1;
  /** Lower = noisier sensors (free-simulation randomization). */
  quality = 1;

  constructor(private rng: Rng) {}

  footprint(d: Drone): number {
    // SIM: effective thermal detection radius including oblique viewing (≈ 0.9 × AGL).
    return clamp(d.agl * 0.9, 20, 95);
  }

  update(dt: number, t: number, drones: Drone[], civs: Civilian[], fire: FireModel, ev: SensorEvents): void {
    this.acc += dt;
    if (this.acc < 0.5) return;
    const step = this.acc;
    this.acc = 0;
    for (const d of drones) {
      if (!d.airborne || !d.thermalOK) continue;
      const scanning = d.role === 'SCOUT' || d.task.kind === 'VERIFY' || d.task.kind === 'CORRIDOR';
      const r = this.footprint(d);
      if (scanning) this.markCoverage(d.x, d.z, r);
      if (!scanning) continue;
      for (const c of civs) {
        if (c.behavior === 'SAFE') continue;
        const dd = dist2(d.x, d.z, c.x, c.z);
        if (dd > r) continue;
        const smoke = clamp(fire.intensityAt(c.x, c.z) * 1.5, 0, 0.8);
        const p = 0.4 * (1 - (dd / r) * 0.6) * (c.indoor ? 0.45 : 1) * (1 - smoke) * this.quality;
        if (this.rng.next() < p * step * 2) this.hit(c, d, t, ev);
      }
      // Occasional false positives near hot ground (SIM).
      if (d.role === 'SCOUT' && this.rng.next() < 0.0035 * step * (2 - this.quality)) {
        const a = this.rng.range(0, 6.28), rr = this.rng.range(0, r);
        const x = d.x + Math.cos(a) * rr, z = d.z + Math.sin(a) * rr;
        if (!this.detections.some((q) => q.status !== 'DISMISSED' && dist2(q.x, q.z, x, z) < 60)) {
          this.create(x, z, this.rng.range(0.32, 0.55), null, d.id, t, ev);
        }
      }
    }
  }

  private hit(c: Civilian, d: Drone, t: number, ev: SensorEvents): void {
    const ex = c.x + this.rng.range(-6, 6), ez = c.z + this.rng.range(-6, 6);
    const existing = this.detections.find((q) => q.truthCivId === c.id && q.status !== 'DISMISSED');
    if (existing) {
      existing.x = ex;
      existing.z = ez;
      existing.sector = sectorOf(ex, ez);
      existing.lastT = t;
      if (existing.status === 'POSSIBLE') existing.conf = Math.min(0.82, existing.conf + (1 - existing.conf) * 0.12);
      return;
    }
    this.create(ex, ez, this.rng.range(0.52, 0.68), c.id, d.id, t, ev);
  }

  create(x: number, z: number, conf: number, civId: string | null, by: string, t: number, ev: SensorEvents): Detection {
    const det: Detection = {
      id: `T${String(this.nextId++).padStart(2, '0')}`,
      x, z, conf, status: 'POSSIBLE', sector: sectorOf(x, z),
      firstT: t, lastT: t, by, truthCivId: civId, verifier: null, holdUntil: 0,
    };
    this.detections.push(det);
    ev.onNewDetection(det, by);
    return det;
  }

  /** A verifying drone completed a low orbit: resolve against ground truth. */
  verify(detId: string, t: number): Detection | null {
    const det = this.detections.find((q) => q.id === detId);
    if (!det || det.status !== 'POSSIBLE' || t < det.holdUntil) return null;
    det.lastT = t;
    if (det.truthCivId) {
      det.status = 'CONFIRMED';
      det.conf = 0.97;
    } else {
      det.status = 'DISMISSED';
      det.conf = 0.04;
    }
    return det;
  }

  markCoverage(x: number, z: number, r: number): void {
    const ci = Math.floor((x + HALF) / COVER_CELL), cj = Math.floor((z + HALF) / COVER_CELL);
    const rc = Math.ceil(r / COVER_CELL);
    for (let j = cj - rc; j <= cj + rc; j++) {
      for (let i = ci - rc; i <= ci + rc; i++) {
        if (i < 0 || j < 0 || i >= COVER_N || j >= COVER_N) continue;
        const cx = -HALF + (i + 0.5) * COVER_CELL, cz = -HALF + (j + 0.5) * COVER_CELL;
        if (dist2(cx, cz, x, z) <= r) this.coverage[j * COVER_N + i] = 255;
      }
    }
  }

  searchedKm2(): number {
    let n = 0;
    for (let k = 0; k < this.coverage.length; k++) if (this.coverage[k]) n++;
    return (n * COVER_CELL * COVER_CELL) / 1e6;
  }

  /** Fraction of a sector's coverage cells that have been searched. */
  sectorSearched(label: string): number {
    const r = 'ABCDEFGH'.indexOf(label[0]);
    const c = Number(label.slice(1)) - 1;
    const per = COVER_N / 8;
    let n = 0;
    for (let j = r * per; j < (r + 1) * per; j++) for (let i = c * per; i < (c + 1) * per; i++) if (this.coverage[j * COVER_N + i]) n++;
    return n / (per * per);
  }
}
