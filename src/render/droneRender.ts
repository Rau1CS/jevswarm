/**
 * Instanced quadcopter rendering (X500-class proportions, scaled by DRONE_VISUAL_SCALE).
 * Parts: body (role colour), carbon frame + motors + skids, spinning props, blur discs,
 * role payload modules, nav lights, and constant-size map markers.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRONE_VISUAL_SCALE } from '../config';
import type { Drone, Role } from '../sim/drone';
import { applyThermal } from './thermal';

export const ROLE_COLOR: Record<Role, number> = {
  SCOUT: 0xd4d8db,
  SUPPRESSION: 0xc4452c,
  LOGISTICS: 0xdaa52a,
  RELAY: 0x6f7c88,
};
export const ROLE_MARK: Record<Role, number> = {
  SCOUT: 0xe8eef2,
  SUPPRESSION: 0xff7048,
  LOGISTICS: 0xffc240,
  RELAY: 0x8fb5d8,
};
const ROLES: Role[] = ['SCOUT', 'SUPPRESSION', 'LOGISTICS', 'RELAY'];
const MOTORS: [number, number][] = [[0.177, 0.177], [-0.177, 0.177], [-0.177, -0.177], [0.177, -0.177]];

export function buildDroneParts() {
  const body = mergeGeometries([
    new THREE.BoxGeometry(0.2, 0.07, 0.28).translate(0, 0, 0),
    new THREE.BoxGeometry(0.14, 0.04, 0.18).translate(0, 0.05, -0.02),
  ])!;
  const arm = (a: number) => new THREE.BoxGeometry(0.5, 0.022, 0.026).rotateY(a);
  const parts: THREE.BufferGeometry[] = [arm(Math.PI / 4), arm(-Math.PI / 4)];
  for (const [x, z] of MOTORS) parts.push(new THREE.CylinderGeometry(0.028, 0.03, 0.04, 10).translate(x, 0.02, z));
  for (const s of [-1, 1]) {
    parts.push(new THREE.BoxGeometry(0.012, 0.012, 0.3).translate(s * 0.11, -0.16, 0));
    parts.push(new THREE.BoxGeometry(0.01, 0.13, 0.01).rotateZ(s * 0.3).translate(s * 0.085, -0.095, 0.08));
    parts.push(new THREE.BoxGeometry(0.01, 0.13, 0.01).rotateZ(s * 0.3).translate(s * 0.085, -0.095, -0.08));
  }
  parts.push(new THREE.CylinderGeometry(0.004, 0.004, 0.08, 4).translate(0, 0.1, -0.08));
  parts.push(new THREE.CylinderGeometry(0.03, 0.03, 0.012, 12).translate(0, 0.145, -0.08));
  const frame = mergeGeometries(parts)!;
  const prop = new THREE.BoxGeometry(0.254, 0.004, 0.022);
  const disc = new THREE.CircleGeometry(0.13, 20).rotateX(-Math.PI / 2);
  const payload: Record<Role, THREE.BufferGeometry> = {
    SCOUT: mergeGeometries([
      new THREE.SphereGeometry(0.045, 12, 10).translate(0, -0.075, 0.1),
      new THREE.CylinderGeometry(0.018, 0.018, 0.03, 10).rotateX(Math.PI / 2).translate(0, -0.075, 0.145),
      new THREE.BoxGeometry(0.02, 0.04, 0.02).translate(0, -0.04, 0.1),
    ])!,
    SUPPRESSION: mergeGeometries([
      new THREE.CylinderGeometry(0.085, 0.085, 0.2, 14).rotateX(Math.PI / 2).translate(0, -0.12, 0),
      new THREE.CylinderGeometry(0.012, 0.02, 0.08, 8).translate(0, -0.23, 0.02),
    ])!,
    LOGISTICS: mergeGeometries([
      new THREE.BoxGeometry(0.17, 0.1, 0.17).translate(0, -0.12, 0),
      new THREE.BoxGeometry(0.19, 0.012, 0.19).translate(0, -0.07, 0),
    ])!,
    RELAY: mergeGeometries([
      new THREE.CylinderGeometry(0.006, 0.008, 0.34, 6).translate(0, 0.22, 0.03),
      new THREE.CylinderGeometry(0.004, 0.004, 0.22, 4).rotateZ(Math.PI / 2).translate(0, 0.3, 0.03),
      new THREE.SphereGeometry(0.02, 8, 6).translate(0, 0.4, 0.03),
      new THREE.BoxGeometry(0.1, 0.05, 0.08).translate(0, -0.06, 0),
    ])!,
  };
  return { body, frame, prop, disc, payload, motors: MOTORS };
}

const MARK_VS = /* glsl */ `
  attribute vec3 aColor; attribute float aSize; varying vec3 vColor; varying float vFade;
  uniform float uNear; uniform float uFar;
  void main(){
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    vFade = uFar > 0.0 ? smoothstep(uNear, uFar, -mv.z) : 1.0;
    gl_PointSize = aSize;
  }`;
const MARK_FS = /* glsl */ `
  varying vec3 vColor; varying float vFade; uniform float uShape;
  void main(){
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d = uShape > 0.5 ? abs(p.x) + abs(p.y) : length(p);
    float a = smoothstep(1.0, 0.55, d);
    float core = smoothstep(0.55, 0.0, d);
    a *= vFade;
    if (a < 0.02) discard;
    gl_FragColor = vec4(vColor * (0.9 + core * 0.6), a);
  }`;

export class DroneRender {
  readonly group = new THREE.Group();
  private n = 0;
  private body!: THREE.InstancedMesh;
  private frame!: THREE.InstancedMesh;
  private props!: THREE.InstancedMesh;
  private discs!: THREE.InstancedMesh;
  private payload = {} as Record<Role, THREE.InstancedMesh>;
  private marks!: THREE.Points;
  private lights!: THREE.Points;
  private dummy = new THREE.Object3D();
  private m = new THREE.Matrix4();
  private local = new THREE.Matrix4();
  private rot = new THREE.Matrix4();
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  readonly selRing: THREE.Mesh;
  readonly selLine: THREE.Line;
  selected: Drone | null = null;
  hovered: Drone | null = null;

  constructor() {
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(9, 10.5, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.8, depthWrite: false }));
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]);
    this.selLine = new THREE.Line(lg, new THREE.LineDashedMaterial({ color: 0xbfe8ff, dashSize: 3, gapSize: 3, transparent: true, opacity: 0.6 }));
    this.selRing.visible = this.selLine.visible = false;
    this.group.add(this.selRing, this.selLine);
  }

  build(count: number): void {
    for (const c of [...this.group.children]) if (c !== this.selRing && c !== this.selLine) this.group.remove(c);
    this.n = count;
    const g = buildDroneParts();
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
      const im = new THREE.InstancedMesh(geo, mat, n);
      im.frustumCulled = false;
      im.castShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(im);
      return im;
    };
    this.body = mk(g.body, applyThermal(new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 }), 0.22), count);
    this.frame = mk(g.frame, applyThermal(new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.5, metalness: 0.3 }), 0.3), count);
    this.props = mk(g.prop, applyThermal(new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.6 }), 0.12), count * 4);
    this.discs = mk(g.disc, new THREE.MeshBasicMaterial({ color: 0x202428, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }), count * 4);
    this.discs.castShadow = false;
    const pc: Record<Role, number> = { SCOUT: 0x24272b, SUPPRESSION: 0xa8321f, LOGISTICS: 0x2b2a26, RELAY: 0x9aa6b0 };
    for (const r of ROLES) this.payload[r] = mk(g.payload[r], applyThermal(new THREE.MeshStandardMaterial({ color: pc[r], roughness: 0.5, metalness: 0.2 }), 0.18), count);

    const pts = (n: number, near: number, far: number, shape: number, blending: THREE.Blending) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
      const p = new THREE.Points(geo, new THREE.ShaderMaterial({
        vertexShader: MARK_VS, fragmentShader: MARK_FS, transparent: true, depthWrite: false, blending,
        uniforms: { uNear: { value: near }, uFar: { value: far }, uShape: { value: shape } },
      }));
      p.frustumCulled = false;
      p.renderOrder = 5;
      this.group.add(p);
      return p;
    };
    this.marks = pts(count, 180, 420, 1, THREE.NormalBlending);
    this.lights = pts(count * 3, 0, 0, 0, THREE.AdditiveBlending);
  }

  update(drones: Drone[], t: number, cam: THREE.Camera, mode: string): void {
    if (drones.length !== this.n) this.build(drones.length);
    const S = DRONE_VISUAL_SCALE;
    const col = new THREE.Color();
    const mPos = this.marks.geometry.attributes.position as THREE.BufferAttribute;
    const mCol = this.marks.geometry.attributes.aColor as THREE.BufferAttribute;
    const mSize = this.marks.geometry.attributes.aSize as THREE.BufferAttribute;
    const lPos = this.lights.geometry.attributes.position as THREE.BufferAttribute;
    const lCol = this.lights.geometry.attributes.aColor as THREE.BufferAttribute;
    const lSize = this.lights.geometry.attributes.aSize as THREE.BufferAttribute;
    const camPos = cam.position;
    const v = new THREE.Vector3();
    drones.forEach((d, i) => {
      this.dummy.position.set(d.x, d.y, d.z);
      this.dummy.rotation.set(d.pitch, d.yaw, d.roll, 'YXZ');
      this.dummy.scale.setScalar(S);
      this.dummy.updateMatrix();
      this.m.copy(this.dummy.matrix);
      this.body.setMatrixAt(i, this.m);
      this.body.setColorAt(i, col.setHex(ROLE_COLOR[d.role]));
      this.frame.setMatrixAt(i, this.m);
      for (const r of ROLES) this.payload[r].setMatrixAt(i, r === d.role ? this.m : this.zero);
      const far = camPos.distanceTo(this.dummy.position) > 900;
      const spinning = d.status !== 'LANDED' && d.status !== 'CHARGING' && d.status !== 'FAILED';
      MOTORS.forEach(([mx, mz], k) => {
        this.local.makeTranslation(mx, 0.045, mz);
        const ang = spinning ? d.rotor * (k % 2 ? 1 : -1) + k : k * 0.7;
        this.rot.makeRotationY(ang);
        const mm = new THREE.Matrix4().multiplyMatrices(this.m, this.local).multiply(this.rot);
        this.props.setMatrixAt(i * 4 + k, far ? this.zero : mm);
        this.discs.setMatrixAt(i * 4 + k, spinning && !far ? mm : this.zero);
      });
      // Constant-size marker (visible from overview).
      mPos.setXYZ(i, d.x, d.y + 4, d.z);
      const lost = d.status === 'LINK_LOST' || d.status === 'FAILED';
      col.setHex(lost ? (Math.sin(t * 8) > 0 ? 0xffb020 : 0x555555) : ROLE_MARK[d.role]);
      if (mode === 'THERMAL') col.setRGB(1, 1, 1);
      mCol.setXYZ(i, col.r, col.g, col.b);
      mSize.setX(i, (d === this.selected ? 13 : d === this.hovered ? 11 : 7) * (window.devicePixelRatio || 1));
      // Nav lights: port red, starboard green, white tail strobe.
      const navs: [number, number, number, number][] = [[0.2, 0.2, 0xff2a20, 3], [-0.2, 0.2, 0x30ff60, 3], [0, -0.16, 0xffffff, Math.sin(t * 9 + i) > 0.85 ? 6 : 0]];
      navs.forEach(([lx, lz, c, sz], k) => {
        v.set(lx, 0.02, lz).applyMatrix4(this.m);
        lPos.setXYZ(i * 3 + k, v.x, v.y, v.z);
        col.setHex(c);
        lCol.setXYZ(i * 3 + k, col.r, col.g, col.b);
        lSize.setX(i * 3 + k, spinning ? sz * (window.devicePixelRatio || 1) : 0);
      });
    });
    for (const im of [this.body, this.frame, this.props, this.discs, ...Object.values(this.payload)]) im.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    mPos.needsUpdate = mCol.needsUpdate = mSize.needsUpdate = true;
    lPos.needsUpdate = lCol.needsUpdate = lSize.needsUpdate = true;
    const s = this.selected;
    this.selRing.visible = this.selLine.visible = !!s && s.status !== 'FAILED';
    if (s) {
      const gy = s.y - s.agl;
      this.selRing.position.set(s.x, gy + 0.8, s.z);
      this.selRing.rotation.y = t;
      this.selLine.position.set(s.x, s.y, s.z);
      this.selLine.scale.set(1, Math.max(1, s.agl), 1);
      this.selLine.computeLineDistances();
    }
  }

  /** Screen-space pick of the nearest drone to a pointer (pixels). */
  pick(drones: Drone[], cam: THREE.Camera, px: number, py: number, w: number, h: number): Drone | null {
    let best: Drone | null = null, bd = 22;
    const v = new THREE.Vector3();
    for (const d of drones) {
      v.set(d.x, d.y, d.z).project(cam);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      const dd = Math.hypot(sx - px, sy - py);
      if (dd < bd) {
        bd = dd;
        best = d;
      }
    }
    return best;
  }
}
