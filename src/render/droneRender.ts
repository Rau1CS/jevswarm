/**
 * Instanced fleet rendering with Blender-authored, PBR-textured airframes
 * (see tools/blender/, src/render/drone/). Scaled by DRONE_VISUAL_SCALE.
 *
 * - Every (kit, material, LOD) is one InstancedMesh; meshes of a kit share one instance
 *   matrix / colour buffer and draw only the instances written this frame (`count`).
 * - LOD0 (full detail) near the camera, LOD1 beyond LOD_NEAR; props hidden beyond PROP_FAR.
 * - Role identity: canopy paint + anodised clamps take ROLE_COLOR via instance colour,
 *   plus role payload modules and decals.
 * - SUPPRESSION-role aircraft can fly the LIGHT quad (X500-class + 1.5 L module) or the
 *   HEAVY coaxial X8 (≈1.9 m, 20 L tank): `setSuppressionAirframe('LIGHT' | 'HEAVY')`.
 */
import * as THREE from 'three';
import { DRONE_VISUAL_SCALE } from '../config';
import type { Drone } from '../sim/drone';
import { ROLE_COLOR, ROLE_MARK } from './drone/palette';
import { AIRFRAMES, currentDroneModels, loadDroneModels, payloadKit, type Airframe, type AirframeSpec, type DroneModels, type GeoByMat } from './drone/models';
import { createDroneMaterials, TINTED, type DroneMaterials } from './drone/materials';
import { fieldEnvironment, rotorBlurTexture } from './drone/textures';

export { ROLE_COLOR, ROLE_MARK };
export { AIRFRAMES, type Airframe, type AirframeSpec };
export { buildDroneAssembly } from './drone/assembly';

/** Camera distance (world m) under which the full-detail LOD is drawn, per airframe. */
const LOD_NEAR: Record<Airframe, number> = { LIGHT: 170, HEAVY: 420 };
const PROP_FAR = 900;

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

/** All material meshes of one kit at one LOD, sharing a per-frame instance buffer. */
class KitBatch {
  readonly meshes: THREE.InstancedMesh[] = [];
  private mtx: THREE.InstancedBufferAttribute;
  private col: THREE.InstancedBufferAttribute | null = null;
  n = 0;

  constructor(geos: GeoByMat, mats: Record<string, THREE.Material>, readonly cap: number, parent: THREE.Object3D, shadow: boolean) {
    this.mtx = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16).setUsage(THREE.DynamicDrawUsage);
    for (const [name, geo] of geos) {
      const im = new THREE.InstancedMesh(geo, mats[name] ?? mats.plastic_dark, cap);
      im.instanceMatrix = this.mtx;
      if (TINTED.has(name)) {
        this.col ??= new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
        im.instanceColor = this.col;
      }
      im.frustumCulled = false;
      im.castShadow = shadow;
      im.count = 0;
      im.visible = false;
      parent.add(im);
      this.meshes.push(im);
    }
  }

  push(m: THREE.Matrix4, c?: THREE.Color): void {
    if (this.n >= this.cap) return;
    m.toArray(this.mtx.array as Float32Array, this.n * 16);
    if (this.col && c) c.toArray(this.col.array as Float32Array, this.n * 3);
    this.n++;
  }

  commit(): void {
    for (const im of this.meshes) {
      im.count = this.n;
      im.visible = this.n > 0;
    }
    if (this.n === 0) return;
    this.mtx.clearUpdateRanges();
    this.mtx.addUpdateRange(0, this.n * 16);
    this.mtx.needsUpdate = true;
    if (this.col) {
      this.col.clearUpdateRanges();
      this.col.addUpdateRange(0, this.n * 3);
      this.col.needsUpdate = true;
    }
  }
}

export class DroneRender {
  readonly group = new THREE.Group();
  private n = 0;
  private fleet = new THREE.Group();
  private batches = new Map<string, KitBatch>();
  private discs = {} as Record<Airframe, KitBatch>;
  private models: DroneModels = currentDroneModels();
  private mats: DroneMaterials;
  private suppression: Airframe = 'LIGHT';
  private marks!: THREE.Points;
  private lights!: THREE.Points;
  private dummy = new THREE.Object3D();
  private m = new THREE.Matrix4();
  private pm = new THREE.Matrix4();
  private tmp = new THREE.Matrix4();
  private flip = new THREE.Matrix4().makeRotationX(Math.PI);
  readonly selRing: THREE.Mesh;
  readonly selLine: THREE.Line;
  selected: Drone | null = null;
  hovered: Drone | null = null;

  constructor() {
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(9, 10.5, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.8, depthWrite: false }));
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]);
    this.selLine = new THREE.Line(lg, new THREE.LineDashedMaterial({ color: 0xbfe8ff, dashSize: 3, gapSize: 3, transparent: true, opacity: 0.6 }));
    this.selRing.visible = this.selLine.visible = false;
    this.group.add(this.selRing, this.selLine, this.fleet);
    this.mats = createDroneMaterials({ envMap: fieldEnvironment(), envMapIntensity: 0.85 });
    void loadDroneModels().then((m) => {
      this.models = m;
      this.n = -1; // rebuild instanced meshes on next update
    });
  }

  /**
   * Choose the airframe flown by SUPPRESSION-role drones: 'LIGHT' = X500-class quad with a
   * 1.5 L module; 'HEAVY' = coaxial X8 heavy-lift (≈1.9 m wheelbase, 30 in props, 20 L tank).
   * Takes effect on the next update(); other roles always fly the LIGHT airframe.
   */
  setSuppressionAirframe(a: Airframe): void {
    this.suppression = a;
  }

  get suppressionAirframe(): Airframe {
    return this.suppression;
  }

  /** Airframe used to draw a given drone. */
  airframeFor(d: Drone): Airframe {
    return d.role === 'SUPPRESSION' ? this.suppression : 'LIGHT';
  }

  build(count: number): void {
    for (const c of [...this.fleet.children]) this.fleet.remove(c);
    for (const c of [...this.group.children]) if (c !== this.selRing && c !== this.selLine && c !== this.fleet) this.group.remove(c);
    this.batches.clear();
    this.n = count;
    const mats = this.mats as unknown as Record<string, THREE.Material>;
    const kits = ['LIGHT', 'HEAVY', 'PAY_SCOUT', 'PAY_SUPPRESSION', 'PAY_LOGISTICS', 'PAY_RELAY'];
    const props = ['PROP_L_CCW', 'PROP_L_CW', 'PROP_H_CCW', 'PROP_H_CW'];
    for (const lod of [0, 1]) {
      for (const k of kits) this.batches.set(`${k}|${lod}`, new KitBatch(this.models.kit(k, lod), mats, count, this.fleet, true));
      for (const k of props) this.batches.set(`${k}|${lod}`, new KitBatch(this.models.kit(k, lod), mats, count * 4, this.fleet, lod === 0));
    }
    const discMat = new THREE.MeshBasicMaterial({ map: rotorBlurTexture(), color: 0xc8ccd0, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
    for (const af of ['LIGHT', 'HEAVY'] as Airframe[]) {
      const disc = new THREE.CircleGeometry(AIRFRAMES[af].propDiameter / 2, 40).rotateX(-Math.PI / 2);
      this.discs[af] = new KitBatch(new Map([['disc', disc]]), { disc: discMat, plastic_dark: discMat }, count * 8, this.fleet, false);
    }

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
    const tint = new THREE.Color();
    const mPos = this.marks.geometry.attributes.position as THREE.BufferAttribute;
    const mCol = this.marks.geometry.attributes.aColor as THREE.BufferAttribute;
    const mSize = this.marks.geometry.attributes.aSize as THREE.BufferAttribute;
    const lPos = this.lights.geometry.attributes.position as THREE.BufferAttribute;
    const lCol = this.lights.geometry.attributes.aColor as THREE.BufferAttribute;
    const lSize = this.lights.geometry.attributes.aSize as THREE.BufferAttribute;
    const camPos = cam.position;
    const v = new THREE.Vector3();
    const dpr = window.devicePixelRatio || 1;
    for (const b of this.batches.values()) b.n = 0;
    this.discs.LIGHT.n = this.discs.HEAVY.n = 0;
    drones.forEach((d, i) => {
      const spec = AIRFRAMES[this.airframeFor(d)];
      // Keep the landing gear on the ground at the exaggerated visual scale.
      const y = Math.max(d.y, d.y - d.agl + spec.footDepth * S);
      this.dummy.position.set(d.x, y, d.z);
      this.dummy.rotation.set(d.pitch, d.yaw, d.roll, 'YXZ');
      this.dummy.scale.setScalar(S);
      this.dummy.updateMatrix();
      this.m.copy(this.dummy.matrix);
      const dist = camPos.distanceTo(this.dummy.position);
      const lod = dist < LOD_NEAR[spec.id] ? 0 : 1;
      tint.setHex(ROLE_COLOR[d.role]);
      this.batches.get(`${spec.frameKit}|${lod}`)!.push(this.m, tint);
      if (spec.id === 'LIGHT') this.batches.get(`${payloadKit(d.role)}|${lod}`)!.push(this.m, tint);
      const spinning = d.status !== 'LANDED' && d.status !== 'CHARGING' && d.status !== 'FAILED';
      if (dist < PROP_FAR) {
        spec.rotors.forEach((r, k) => {
          const dir = r.ccw ? 1 : -1;
          const ang = spinning ? d.rotor * spec.spin * dir + k : k * 0.7;
          this.pm.makeTranslation(r.x, r.y, r.z).premultiply(this.m);
          if (r.inverted) this.pm.multiply(this.flip);
          this.pm.multiply(this.tmp.makeRotationY(r.inverted ? -ang : ang));
          const handedCCW = r.inverted ? !r.ccw : r.ccw;
          this.batches.get(`${handedCCW ? spec.propKit.ccw : spec.propKit.cw}|${lod}`)!.push(this.pm);
          if (spinning) this.discs[spec.id].push(this.pm);
        });
      }
      // Constant-size marker (visible from overview).
      mPos.setXYZ(i, d.x, y + (spec.id === 'HEAVY' ? 8 : 4), d.z);
      const lost = d.status === 'LINK_LOST' || d.status === 'FAILED';
      col.setHex(lost ? (Math.sin(t * 8) > 0 ? 0xffb020 : 0x555555) : ROLE_MARK[d.role]);
      if (mode === 'THERMAL') col.setRGB(1, 1, 1);
      mCol.setXYZ(i, col.r, col.g, col.b);
      mSize.setX(i, (d === this.selected ? 13 : d === this.hovered ? 11 : 7) * dpr);
      // Nav lights: port red, starboard green, white tail strobe.
      spec.navLights.forEach(([lx, ly, lz, c, strobe], k) => {
        v.set(lx, ly, lz).applyMatrix4(this.m);
        lPos.setXYZ(i * 3 + k, v.x, v.y, v.z);
        col.setHex(c);
        lCol.setXYZ(i * 3 + k, col.r, col.g, col.b);
        const sz = strobe ? (Math.sin(t * 9 + i) > 0.85 ? 6 : 0) : 3;
        lSize.setX(i * 3 + k, spinning ? sz * dpr : 0);
      });
    });
    for (const b of this.batches.values()) b.commit();
    this.discs.LIGHT.commit();
    this.discs.HEAVY.commit();
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
