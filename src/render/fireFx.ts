/** Fire visuals: flames, smoke columns, embers, suppression water and steam; fire glow lights. */
import * as THREE from 'three';
import { FIRE_CELL, FIRE_N } from '../config';
import { windToward } from '../core/math';
import { heightAt } from '../world/layout';
import type { FireModel } from '../sim/fire';
import { ParticlePool } from './particles';
import type { Quality } from './stage';

interface Drop { x: number; y: number; z: number; t: number; vx: number; vz: number }

export class FireFx {
  readonly group = new THREE.Group();
  flames: ParticlePool;
  smoke: ParticlePool;
  embers: ParticlePool;
  water: ParticlePool;
  steam: ParticlePool;
  private drops: Drop[] = [];
  private front: number[] = [];
  private frontVersion = -1;

  constructor(quality: Quality) {
    const q = quality === 'HIGH' ? 1 : quality === 'MEDIUM' ? 0.6 : 0.35;
    this.flames = new ParticlePool(Math.round(4500 * q), 'flame');
    this.smoke = new ParticlePool(Math.round(1700 * q), 'smoke');
    this.embers = new ParticlePool(Math.round(1600 * q), 'ember');
    this.water = new ParticlePool(900, 'water');
    this.steam = new ParticlePool(700, 'steam');
    this.flames.mat.uniforms.uMaxPx.value = 170;
    this.smoke.mat.uniforms.uMaxPx.value = 340;
    this.flames.drag = 0.8;
    this.smoke.drag = 0.12;
    this.embers.drag = 0.6;
    this.embers.gravity = -1.2;
    this.water.gravity = -9.8;
    this.steam.drag = 0.3;
    this.group.add(this.smoke.points, this.steam.points, this.water.points, this.flames.points, this.embers.points);
  }

  setScale(px: number): void {
    for (const p of [this.flames, this.smoke, this.embers, this.water, this.steam]) p.mat.uniforms.uScale.value = px;
  }

  /** Visual suppressant release from a drone. */
  drop(x: number, y: number, z: number, vx: number, vz: number): void {
    this.drops.push({ x, y, z, t: 0, vx, vz });
  }

  private pickCell(fire: FireModel, list: number[]): number {
    for (let tries = 0; tries < 6; tries++) {
      const k = list[(Math.random() * list.length) | 0];
      const I = fire.intensity[k];
      if (Math.random() < I * I * I * 1.6 + 0.02) return k;
    }
    return list[(Math.random() * list.length) | 0];
  }

  update(dt: number, fire: FireModel, lights: THREE.PointLight[]): void {
    const w = windToward(fire.wind.fromDeg);
    const ws = fire.wind.speed;
    const wx = w.x * ws, wz = w.z * ws;
    const burning = fire.burning;
    if (fire.version !== this.frontVersion) {
      this.frontVersion = fire.version;
      this.front = fire.frontCells();
    }
    if (burning.length) {
      // Flames: rate scales with burning cells, capped by budget.
      const nFl = Math.floor((this.flames.cap / 1.15) * Math.min(1, burning.length / 50) * dt + Math.random());
      for (let i = 0; i < nFl; i++) {
        const k = this.pickCell(fire, burning);
        const I = fire.intensity[k];
        const c = fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0);
        const x = c.x + (Math.random() - 0.5) * FIRE_CELL, z = c.z + (Math.random() - 0.5) * FIRE_CELL;
        const crown = fire.fuel0[k] > 0.55 ? 16 : 3;
        const y = heightAt(x, z) + Math.random() * crown * I;
        this.flames.emit(x, y, z, wx * 0.3, 4 + Math.random() * 6 * I, wz * 0.3, 0.6 + Math.random() * 0.9, (5 + Math.random() * 9) * (0.6 + I), 2 + Math.random() * 3);
      }
      const nSm = Math.floor((this.smoke.cap / 28) * Math.min(1, burning.length / 30) * dt + Math.random());
      for (let i = 0; i < nSm; i++) {
        const k = this.pickCell(fire, burning);
        const c = fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0);
        const x = c.x + (Math.random() - 0.5) * FIRE_CELL * 2, z = c.z + (Math.random() - 0.5) * FIRE_CELL * 2;
        this.smoke.emit(x, heightAt(x, z) + 14 + Math.random() * 12, z, wx * 0.5, 9 + Math.random() * 6, wz * 0.5, 26 + Math.random() * 14, 24 + Math.random() * 14, 170 + Math.random() * 150);
      }
      if (this.front.length) {
        const nEm = Math.floor((this.embers.cap / 3.3) * Math.min(1, this.front.length / 30) * dt + Math.random());
        for (let i = 0; i < nEm; i++) {
          const k = this.front[(Math.random() * this.front.length) | 0];
          const c = fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0);
          this.embers.emit(c.x + (Math.random() - 0.5) * FIRE_CELL, heightAt(c.x, c.z) + 4 + Math.random() * 10, c.z + (Math.random() - 0.5) * FIRE_CELL,
            wx * 0.6 + (Math.random() - 0.5) * 3, 5 + Math.random() * 8, wz * 0.6 + (Math.random() - 0.5) * 3, 2 + Math.random() * 2.5, 0.9 + Math.random() * 0.6, 0.5);
        }
      }
    }
    // Suppressant: a 1.4 s curtain falling from the drone.
    for (const d of this.drops) {
      d.t += dt;
      const n = Math.round(260 * dt);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.28, r = Math.random() * 2.5;
        this.water.emit(d.x + Math.cos(a) * r, d.y - 3, d.z + Math.sin(a) * r, d.vx * 0.6 + (Math.random() - 0.5) * 6, -2 - Math.random() * 3, d.vz * 0.6 + (Math.random() - 0.5) * 6, 6, 1.2 + Math.random() * 1.2, 2.2);
      }
    }
    this.drops = this.drops.filter((d) => d.t < 1.4);

    this.flames.update(dt, wx, wz, 0.35);
    this.smoke.update(dt, wx, wz, 1.6);
    this.embers.update(dt, wx, wz, 1.2);
    this.water.update(dt, wx, wz, 0.1, (x, z) => heightAt(x, z) + 0.5, (x, y, z) => {
      if (Math.random() < 0.18) this.steam.emit(x, y + 2, z, 0, 2 + Math.random() * 2, 0, 6 + Math.random() * 4, 10, 45 + Math.random() * 30);
    });
    this.steam.update(dt, wx, wz, 0.5);
    this.placeLights(fire, lights);
  }

  private lightAcc = 0;
  private placeLights(fire: FireModel, lights: THREE.PointLight[]): void {
    if (this.lightAcc++ % 10 !== 0) return;
    const picks: THREE.Vector3[] = [];
    const sorted = [...fire.burning].sort((a, b) => fire.intensity[b] - fire.intensity[a]);
    for (const k of sorted) {
      const c = fire.cellCenter(k % FIRE_N, (k / FIRE_N) | 0);
      if (picks.every((p) => Math.hypot(p.x - c.x, p.z - c.z) > 260)) picks.push(new THREE.Vector3(c.x, heightAt(c.x, c.z) + 30, c.z));
      if (picks.length >= lights.length) break;
    }
    lights.forEach((l, i) => {
      const p = picks[i];
      if (p) {
        l.position.copy(p);
        l.intensity = 220;
      } else l.intensity = 0;
    });
  }
}
