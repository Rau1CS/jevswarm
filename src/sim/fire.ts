/**
 * Simplified cellular wildfire model (SIM abstraction, not a validated fire-behaviour model).
 * Spread probability per neighbour ∝ fuel · wind alignment · slope · source intensity · (1 − wetness).
 * See docs/SIMULATION.md for parameters.
 */
import { FIRE_CELL, FIRE_N, HALF } from '../config';
import { Rng, clamp, windToward } from '../core/math';
import { heightAt, vegetationAt } from '../world/layout';

export const UNBURNED = 0, BURNING = 1, BURNT = 2;

export interface Wind { fromDeg: number; speed: number }

const NB: [number, number, number][] = [];
for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (dx || dz) NB.push([dx, dz, Math.hypot(dx, dz)]);

export class FireModel {
  readonly n = FIRE_N;
  readonly fuel0 = new Float32Array(FIRE_N * FIRE_N);
  readonly fuel = new Float32Array(FIRE_N * FIRE_N);
  readonly intensity = new Float32Array(FIRE_N * FIRE_N);
  readonly wet = new Float32Array(FIRE_N * FIRE_N);
  readonly state = new Uint8Array(FIRE_N * FIRE_N);
  readonly height = new Float32Array(FIRE_N * FIRE_N);
  /** RGBA texture data: R intensity, G char, B wet, A heat. */
  readonly tex = new Uint8Array(FIRE_N * FIRE_N * 4);
  burning: number[] = [];
  wind: Wind = { fromDeg: 210, speed: 6 };
  private windTarget: Wind = { fromDeg: 210, speed: 6 };
  private acc = 0;
  peakBurning = 0;
  totalSuppressedCells = 0;
  version = 0;
  /** Static slope factor per cell and neighbour direction (terrain never changes). */
  private slopeF = new Float32Array(FIRE_N * FIRE_N * 8);

  constructor(private rng: Rng) {
    for (let j = 0; j < FIRE_N; j++) {
      for (let i = 0; i < FIRE_N; i++) {
        const { x, z } = this.cellCenter(i, j);
        const k = j * FIRE_N + i;
        const v = vegetationAt(x, z);
        this.fuel0[k] = v;
        this.fuel[k] = v;
        this.height[k] = heightAt(x, z);
      }
    }
    for (let k = 0; k < FIRE_N * FIRE_N; k++) {
      const i = k % FIRE_N, j = (k / FIRE_N) | 0;
      NB.forEach(([dx, dz, len], d) => {
        const ni = i + dx, nj = j + dz;
        if (ni < 0 || nj < 0 || ni >= FIRE_N || nj >= FIRE_N) return;
        const slope = (this.height[nj * FIRE_N + ni] - this.height[k]) / (FIRE_CELL * len);
        this.slopeF[k * 8 + d] = Math.exp(clamp(slope, -0.6, 0.8) * 2.2);
      });
    }
  }

  cellCenter(i: number, j: number) {
    return { x: -HALF + (i + 0.5) * FIRE_CELL, z: -HALF + (j + 0.5) * FIRE_CELL };
  }
  cellOf(x: number, z: number): number {
    const i = clamp(Math.floor((x + HALF) / FIRE_CELL), 0, FIRE_N - 1);
    const j = clamp(Math.floor((z + HALF) / FIRE_CELL), 0, FIRE_N - 1);
    return j * FIRE_N + i;
  }

  ignite(x: number, z: number, radius = 20): void {
    const r = Math.ceil(radius / FIRE_CELL);
    const c = this.cellOf(x, z);
    const ci = c % FIRE_N, cj = (c / FIRE_N) | 0;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= FIRE_N || j >= FIRE_N || Math.hypot(di, dj) > r) continue;
        const k = j * FIRE_N + i;
        if (this.state[k] === UNBURNED && this.fuel[k] > 0.08) {
          this.state[k] = BURNING;
          this.intensity[k] = Math.max(this.intensity[k], 0.5);
          this.burning.push(k);
        }
      }
    }
  }

  setWind(w: Wind, immediate = false): void {
    this.windTarget = { ...w };
    if (immediate) this.wind = { ...w };
  }

  /** Advance in fixed 0.2 s fire ticks. */
  update(dt: number): void {
    // Wind eases toward target (a shift plays out over a few seconds).
    let d = this.windTarget.fromDeg - this.wind.fromDeg;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    this.wind.fromDeg = (this.wind.fromDeg + d * Math.min(1, dt * 0.6) + 360) % 360;
    this.wind.speed += (this.windTarget.speed - this.wind.speed) * Math.min(1, dt * 0.6);
    this.acc += dt;
    while (this.acc >= 0.2) {
      this.acc -= 0.2;
      this.tick(0.2);
    }
  }

  /** Wind multiplier per neighbour direction for the current wind. */
  private windFactors(): Float64Array {
    const wv = windToward(this.wind.fromDeg);
    const out = new Float64Array(8);
    NB.forEach(([dx, dz, len], d) => (out[d] = Math.exp((0.24 * this.wind.speed * (dx * wv.x + dz * wv.z)) / len)));
    return out;
  }

  private tick(dt: number): void {
    const N = FIRE_N;
    const wv = windToward(this.wind.fromDeg);
    const newly: number[] = [];
    const wf = this.windFactors();
    for (const k of this.burning) {
      const I = this.intensity[k];
      const i = k % N, j = (k / N) | 0;
      for (let d = 0; d < 8; d++) {
        const [dx, dz, len] = NB[d];
        const ni = i + dx, nj = j + dz;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const nk = nj * N + ni;
        if (this.state[nk] !== UNBURNED) continue;
        const f = this.fuel[nk];
        if (f < 0.08) continue;
        const rate = (0.022 * (0.35 + 0.65 * f) * wf[d] * this.slopeF[k * 8 + d] * I * (1 - this.wet[nk])) / len;
        if (this.rng.next() < 1 - Math.exp(-rate * dt)) newly.push(nk);
      }
      // Ember spotting downwind from intense cells.
      if (I > 0.75 && this.rng.next() < 0.0009 * this.wind.speed * dt) {
        const dist = this.rng.range(4, 11);
        const si = Math.round(i + wv.x * dist + this.rng.range(-2, 2));
        const sj = Math.round(j + wv.z * dist + this.rng.range(-2, 2));
        if (si >= 0 && sj >= 0 && si < N && sj < N) {
          const sk = sj * N + si;
          if (this.state[sk] === UNBURNED && this.fuel[sk] > 0.4 && this.wet[sk] < 0.3) newly.push(sk);
        }
      }
    }
    for (const nk of newly) {
      if (this.state[nk] === UNBURNED) {
        this.state[nk] = BURNING;
        this.intensity[nk] = 0.15;
      }
    }
    // Burn down fuel; wetness evaporates slowly.
    const next: number[] = [];
    for (let k = 0; k < N * N; k++) {
      if (this.wet[k] > 0) this.wet[k] = Math.max(0, this.wet[k] - dt * 0.004);
      if (this.state[k] !== BURNING) continue;
      const f = this.fuel[k];
      const peak = 0.35 + 0.65 * this.fuel0[k];
      // Flaming front: intensity peaks early, then decays to smouldering as fuel is consumed.
      const remain = this.fuel0[k] > 0 ? f / this.fuel0[k] : 0;
      const target = f > 0.1 ? peak * Math.min(1, 0.25 + remain * remain * 1.1) : 0;
      this.intensity[k] += (target - this.intensity[k]) * dt * 0.7;
      this.intensity[k] *= 1 - this.wet[k] * dt * 1.5;
      this.fuel[k] = Math.max(0, f - dt * 0.0065 * (0.4 + this.intensity[k]));
      if (this.intensity[k] < 0.06) {
        this.state[k] = this.fuel[k] < 0.15 ? BURNT : UNBURNED;
        this.intensity[k] = 0;
      } else next.push(k);
    }
    this.burning = next;
    this.peakBurning = Math.max(this.peakBurning, next.length);
    this.writeTexture();
  }

  /** Apply a suppressant drop. Returns fractional intensity reduction inside the footprint. */
  suppress(x: number, z: number, radius: number, strength: number): number {
    const r = Math.ceil(radius / FIRE_CELL) + 1;
    const c = this.cellOf(x, z);
    const ci = c % FIRE_N, cj = (c / FIRE_N) | 0;
    let before = 0, after = 0;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= FIRE_N || j >= FIRE_N) continue;
        const dd = Math.hypot(di, dj) * FIRE_CELL;
        if (dd > radius * 1.3) continue;
        const k = j * FIRE_N + i;
        const fall = clamp(1 - dd / (radius * 1.3), 0, 1);
        before += this.intensity[k];
        this.wet[k] = Math.min(1, this.wet[k] + strength * fall);
        if (this.state[k] === BURNING) {
          this.intensity[k] *= 1 - strength * fall * 0.85;
          if (this.intensity[k] < 0.07) {
            this.state[k] = UNBURNED;
            this.intensity[k] = 0;
            this.totalSuppressedCells++;
          }
        }
        after += this.intensity[k];
      }
    }
    this.burning = this.burning.filter((k) => this.state[k] === BURNING);
    this.writeTexture();
    return before > 0 ? 1 - after / before : 0;
  }

  /**
   * Predicted fire arrival time (seconds) per fire cell via Dijkstra over the grid,
   * seeded from currently burning cells. Infinity where unreachable within horizon.
   */
  predictArrival(horizonSec = 900): Float64Array {
    const N = FIRE_N;
    const t = new Float64Array(N * N).fill(Infinity);
    const wf = this.windFactors();
    const heap = new MinHeap();
    for (const k of this.burning) {
      t[k] = 0;
      heap.push(k, 0);
    }
    while (heap.size) {
      const k = heap.pop();
      const tk = heap.lastVal;
      if (tk > t[k] || tk > horizonSec) continue;
      const i = k % N, j = (k / N) | 0;
      for (let d = 0; d < 8; d++) {
        const [dx, dz, len] = NB[d];
        const ni = i + dx, nj = j + dz;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const nk = nj * N + ni;
        if (this.state[nk] === BURNT || this.fuel[nk] < 0.08) continue;
        // Spread-rate estimate (m/s), calibrated against the CA in tests/fire.test.ts.
        const v = 1.35 * (0.35 + 0.65 * this.fuel[nk]) * (0.35 + 0.65 * this.fuel0[nk]) * wf[d] * this.slopeF[k * 8 + d] * (1 - this.wet[nk]);
        if (v < 0.01) continue;
        const nt = tk + (FIRE_CELL * len) / v;
        if (nt < t[nk]) {
          t[nk] = nt;
          heap.push(nk, nt);
        }
      }
    }
    return t;
  }

  /** Burning cells adjacent to unburned fuel, i.e. the active front. */
  frontCells(): number[] {
    const N = FIRE_N;
    return this.burning.filter((k) => {
      const i = k % N, j = (k / N) | 0;
      for (const [dx, dz] of NB) {
        const ni = i + dx, nj = j + dz;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const nk = nj * N + ni;
        if (this.state[nk] === UNBURNED && this.fuel[nk] > 0.08 && this.wet[nk] < 0.5) return true;
      }
      return false;
    });
  }

  stats() {
    const front = this.frontCells().length;
    let burnt = 0;
    for (let k = 0; k < this.state.length; k++) if (this.state[k] === BURNT) burnt++;
    const affected = burnt + this.burning.length;
    // Containment (SIM metric): share of the fire perimeter that is no longer advancing.
    const perimeter = this.burning.length;
    const containment = perimeter === 0 ? (affected > 0 ? 1 : 0) : clamp(1 - front / Math.max(perimeter, 1), 0, 1);
    return {
      burningCells: this.burning.length,
      frontKm: (front * FIRE_CELL) / 1000,
      areaHa: (affected * FIRE_CELL * FIRE_CELL) / 10000,
      containment,
    };
  }

  intensityAt(x: number, z: number): number {
    return this.intensity[this.cellOf(x, z)];
  }

  private writeTexture(): void {
    const d = this.tex;
    for (let k = 0; k < this.state.length; k++) {
      const I = this.intensity[k];
      const f0 = this.fuel0[k];
      const charr = this.state[k] === BURNT ? 1 : f0 > 0 ? clamp(1 - this.fuel[k] / f0, 0, 1) * 1.6 : 0;
      d[k * 4] = I * 255;
      d[k * 4 + 1] = clamp(charr, 0, 1) * 255;
      d[k * 4 + 2] = this.wet[k] * 255;
      d[k * 4 + 3] = clamp(I * 1.2 + (this.state[k] === BURNT ? 0.12 : 0), 0, 1) * 255;
    }
    this.version++;
  }

  /** Replay support: compact snapshot of per-cell state. */
  snapshot(): Uint8Array {
    const s = new Uint8Array(this.state.length * 3);
    for (let k = 0; k < this.state.length; k++) {
      s[k * 3] = this.state[k];
      s[k * 3 + 1] = this.intensity[k] * 255;
      s[k * 3 + 2] = this.fuel0[k] > 0 ? (this.fuel[k] / this.fuel0[k]) * 255 : 0;
    }
    return s;
  }
  restore(s: Uint8Array): void {
    this.burning = [];
    for (let k = 0; k < this.state.length; k++) {
      this.state[k] = s[k * 3];
      this.intensity[k] = s[k * 3 + 1] / 255;
      this.fuel[k] = (s[k * 3 + 2] / 255) * this.fuel0[k];
      this.wet[k] = 0;
      if (this.state[k] === BURNING) this.burning.push(k);
    }
    this.writeTexture();
  }
}

/** Binary min-heap; pop() returns the key and leaves its priority in lastVal (no allocation). */
class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  lastVal = 0;
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= val) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v;
    const top = k[0];
    this.lastVal = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = -1, mv = lv;
        if (l < n && v[l] < mv) { m = l; mv = v[l]; }
        if (r < n && v[r] < mv) { m = r; mv = v[r]; }
        if (m < 0) break;
        k[i] = k[m];
        v[i] = v[m];
        i = m;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}
