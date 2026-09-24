/**
 * Flight-path visuals: replan animation (old path fades, new path draws in), projected
 * path of the selected drone, JEV VIEW assignment lines, and safe-corridor ribbons.
 */
import * as THREE from 'three';
import { heightAt, type Pt } from '../world/layout';
import type { Drone, TaskKind } from '../sim/drone';
import type { PlanChange } from '../jev/types';
import type { CorridorState } from '../jev/objectives';

export const TASK_COLOR: Record<TaskKind, number> = {
  VERIFY: 0xffb347, SUPPRESS: 0xff6a3d, CORRIDOR: 0x7fe0c8, GUIDE: 0x7fe0c8, SEARCH: 0x8fc7ff,
  RELAY: 0xa9b8ff, DELIVER: 0xffd166, MONITOR: 0xd6d6d6, PATROL: 0x9fd18b, RTB: 0x8a9099,
  RESERVE: 0x8a9099, IDLE: 0x6a7079, SWAP: 0xc0c6cc,
};

const SEG = 40;

function arc(from: THREE.Vector3, to: Pt, toAGL: number, out: Float32Array): void {
  const ty = heightAt(to.x, to.z) + toAGL;
  const mx = (from.x + to.x) / 2, mz = (from.z + to.z) / 2;
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  const my = Math.max(from.y, ty) + d * 0.08;
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
    out[i * 3] = a * from.x + b * mx + c * to.x;
    out[i * 3 + 1] = a * from.y + b * my + c * ty;
    out[i * 3 + 2] = a * from.z + b * mz + c * to.z;
  }
}

interface Anim { line: THREE.Line; drone: Drone; target: Pt; age: number; kind: 'old' | 'new'; hold: number }

const aglFor = (k: TaskKind) => (k === 'SUPPRESS' ? 25 : k === 'VERIFY' ? 40 : k === 'RELAY' ? 120 : k === 'RTB' || k === 'RESERVE' || k === 'SWAP' ? 5 : 70);

export class Paths {
  readonly group = new THREE.Group();
  private anims: Anim[] = [];
  private assign = new Map<string, THREE.Line>();
  private selLine: THREE.Line;
  private corridors = new Map<string, THREE.Mesh>();
  private corridorMat: THREE.ShaderMaterial;
  showAssignments = false;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(200 * 3), 3));
    this.selLine = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xdff4ff, dashSize: 8, gapSize: 6, transparent: true, opacity: 0.85, depthWrite: false }));
    this.selLine.frustumCulled = false;
    this.selLine.visible = false;
    this.group.add(this.selLine);
    this.corridorMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `attribute float aDist; varying float vD; varying float vS; attribute float aSide;
        void main(){ vD = aDist; vS = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uTime; varying float vD; varying float vS;
        void main(){ float chev = fract((vD - abs(vS) * 6.0) / 22.0 - uTime * 0.9);
          float a = smoothstep(0.0, 0.15, chev) * (1.0 - smoothstep(0.35, 0.5, chev));
          float edge = smoothstep(1.0, 0.7, abs(vS));
          gl_FragColor = vec4(vec3(0.42, 0.88, 0.78) * 0.8, (0.12 + a * 0.5) * edge); }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
  }

  private mkLine(color: number, opacity: number): THREE.Line {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    l.frustumCulled = false;
    l.renderOrder = 6;
    this.group.add(l);
    return l;
  }

  /** Animate a replan: fade old intent, draw new one. */
  replan(changes: PlanChange[], drones: Drone[]): void {
    for (const c of changes) {
      const d = drones.find((q) => q.id === c.droneId);
      if (!d) continue;
      const old = c.fromTarget;
      if (old) this.anims.push({ line: this.mkLine(0xb0b8c0, 0.7), drone: d, target: old, age: 0, kind: 'old', hold: 0 });
      this.anims.push({ line: this.mkLine(TASK_COLOR[d.task.kind], 1), drone: d, target: d.task.target, age: 0, kind: 'new', hold: 4 + Math.random() });
    }
    // Keep the scene legible under heavy replans.
    while (this.anims.length > 90) this.dispose(this.anims.shift()!);
  }

  private dispose(a: Anim): void {
    this.group.remove(a.line);
    a.line.geometry.dispose();
    (a.line.material as THREE.Material).dispose();
  }

  update(dt: number, t: number, drones: Drone[], selected: Drone | null, corridors: Map<string, CorridorState>): void {
    this.corridorMat.uniforms.uTime.value = t;
    const from = new THREE.Vector3();
    for (const a of this.anims) {
      a.age += dt;
      const pos = a.line.geometry.attributes.position as THREE.BufferAttribute;
      from.set(a.drone.x, a.drone.y, a.drone.z);
      arc(from, a.target, aglFor(a.drone.task.kind), pos.array as Float32Array);
      pos.needsUpdate = true;
      const m = a.line.material as THREE.LineBasicMaterial;
      if (a.kind === 'old') m.opacity = Math.max(0, 0.7 - a.age / 1.6);
      else {
        a.line.geometry.setDrawRange(0, Math.min(SEG + 1, Math.floor((a.age / 1.1) * (SEG + 1)) + 1));
        m.opacity = a.age < a.hold ? 1 : Math.max(0, 1 - (a.age - a.hold) / 1.5);
      }
    }
    const dead = this.anims.filter((a) => (a.kind === 'old' ? a.age > 1.6 : a.age > a.hold + 1.5));
    dead.forEach((a) => this.dispose(a));
    this.anims = this.anims.filter((a) => !dead.includes(a));

    // JEV VIEW: persistent assignment lines.
    for (const d of drones) {
      let l = this.assign.get(d.id);
      const show = this.showAssignments && d.airborne && d.task.kind !== 'IDLE';
      if (!l && show) {
        l = this.mkLine(0xffffff, 0.35);
        this.assign.set(d.id, l);
      }
      if (!l) continue;
      l.visible = show;
      if (!show) continue;
      (l.material as THREE.LineBasicMaterial).color.setHex(TASK_COLOR[d.task.kind]);
      from.set(d.x, d.y, d.z);
      arc(from, d.task.target, aglFor(d.task.kind), (l.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array);
      l.geometry.attributes.position.needsUpdate = true;
    }

    // Selected drone: projected path (remaining waypoints or arc to target).
    this.selLine.visible = !!selected && selected.airborne;
    if (selected && selected.airborne) {
      const arr = (this.selLine.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
      const wps = selected.task.waypoints;
      let n = 0;
      arr[0] = selected.x; arr[1] = selected.y; arr[2] = selected.z;
      n = 1;
      if (wps && wps.length > 1 && (selected.task.kind === 'SEARCH' || selected.task.kind === 'CORRIDOR' || selected.task.kind === 'PATROL')) {
        const y = selected.y;
        for (const p of wps.slice(0, 60)) {
          arr[n * 3] = p.x; arr[n * 3 + 1] = Math.max(y - selected.agl + 1, heightAt(p.x, p.z)) + selected.agl; arr[n * 3 + 2] = p.z;
          n++;
        }
      } else {
        const tmp = new Float32Array((SEG + 1) * 3);
        from.set(selected.x, selected.y, selected.z);
        arc(from, selected.task.target, aglFor(selected.task.kind), tmp);
        arr.set(tmp, 0);
        n = SEG + 1;
      }
      this.selLine.geometry.setDrawRange(0, n);
      this.selLine.geometry.attributes.position.needsUpdate = true;
      this.selLine.computeLineDistances();
      (this.selLine.material as THREE.LineDashedMaterial).color.setHex(TASK_COLOR[selected.task.kind]);
    }

    // Safe corridors (identified routes).
    for (const [id, c] of corridors) {
      if (!c.flown || !c.route || this.corridors.has(id)) continue;
      const mesh = this.ribbon(c.route, 5);
      this.corridors.set(id, mesh);
      this.group.add(mesh);
    }
  }

  private ribbon(route: Pt[], width: number): THREE.Mesh {
    const pts: Pt[] = [];
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i], b = route[i + 1];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(L / 6));
      for (let s = 0; s < n; s++) pts.push({ x: a.x + ((b.x - a.x) * s) / n, z: a.z + ((b.z - a.z) * s) / n });
    }
    pts.push(route[route.length - 1]);
    const pos: number[] = [], dist: number[] = [], side: number[] = [], idx: number[] = [];
    let D = 0;
    pts.forEach((p, i) => {
      const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)];
      const dx = q.x - o.x, dz = q.z - o.z, L = Math.hypot(dx, dz) || 1;
      const nx = -dz / L, nz = dx / L;
      if (i) D += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      for (const s of [-1, 1]) {
        const x = p.x + nx * s * width / 2, z = p.z + nz * s * width / 2;
        pos.push(x, heightAt(x, z) + 1.6, z);
        dist.push(D);
        side.push(s);
      }
      if (i) idx.push(i * 2 - 2, i * 2 - 1, i * 2, i * 2 - 1, i * 2 + 1, i * 2);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aDist', new THREE.Float32BufferAttribute(dist, 1));
    g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, this.corridorMat);
    m.renderOrder = 4;
    m.frustumCulled = false;
    return m;
  }

  clear(): void {
    this.anims.forEach((a) => this.dispose(a));
    this.anims = [];
    for (const m of this.corridors.values()) this.group.remove(m);
    this.corridors.clear();
    for (const l of this.assign.values()) this.group.remove(l);
    this.assign.clear();
  }
}
