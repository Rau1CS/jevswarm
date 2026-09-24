/** Instanced forest. Trees darken while burning and collapse to charred snags when burnt. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HALF } from '../config';
import { Rng, fbm } from '../core/math';
import { BUILDINGS, distToRoad, heightAt, isForest, vegetationAt } from '../world/layout';
import { BURNING, BURNT, type FireModel } from '../sim/fire';
import { applyThermal } from './thermal';

interface Tree { cell: number; x: number; y: number; z: number; s: number; rot: number; kind: 0 | 1; base: THREE.Color; state: number }

export class Forest {
  readonly group = new THREE.Group();
  private trees: Tree[] = [];
  private conifer: THREE.InstancedMesh;
  private broad: THREE.InstancedMesh;
  private trunks: THREE.InstancedMesh;
  private idxC: number[] = [];
  private idxB: number[] = [];
  private lastVersion = -1;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();

  constructor(fire: FireModel, density: number) {
    const rng = new Rng(99);
    const spacing = 13 / Math.sqrt(density);
    for (let z = -HALF + 5; z < HALF - 5; z += spacing) {
      for (let x = -HALF + 5; x < HALF - 5; x += spacing) {
        const px = x + rng.range(-spacing, spacing) * 0.45, pz = z + rng.range(-spacing, spacing) * 0.45;
        const forest = isForest(px, pz);
        // Sparse broadleaf trees along field edges and gardens.
        const scattered = !forest && vegetationAt(px, pz) > 0.25 && rng.chance(0.07) && distToRoad(px, pz) > 10 && !BUILDINGS.some((b) => Math.hypot(b.x - px, b.z - pz) < 16);
        if (!forest && !scattered) continue;
        if (forest && rng.chance(0.18)) continue;
        const n = fbm(px / 60, pz / 60, 2, 7);
        const kind: 0 | 1 = forest ? (n > 0.62 ? 1 : 0) : 1;
        const base = kind === 0
          ? new THREE.Color().setRGB(0.07 + n * 0.05, 0.14 + n * 0.07, 0.07, THREE.SRGBColorSpace)
          : new THREE.Color().setRGB(0.16 + n * 0.08, 0.22 + n * 0.08, 0.08, THREE.SRGBColorSpace);
        this.trees.push({ cell: fire.cellOf(px, pz), x: px, y: heightAt(px, pz), z: pz, s: rng.range(0.75, 1.35) * (kind ? 0.9 : 1), rot: rng.range(0, 6.28), kind, base, state: 0 });
      }
    }
    const cg1 = new THREE.ConeGeometry(4.2, 11, 7);
    cg1.translate(0, 9.5, 0);
    const cg2 = new THREE.ConeGeometry(3.1, 8, 7);
    cg2.translate(0, 14.5, 0);
    const coniferGeo = mergeGeometries([cg1, cg2])!;
    const broadGeo = new THREE.IcosahedronGeometry(5.2, 1);
    broadGeo.scale(1, 0.85, 1);
    broadGeo.translate(0, 9, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.55, 8, 5);
    trunkGeo.translate(0, 4, 0);
    const foliage = applyThermal(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), 0.014);
    const trunkMat = applyThermal(new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 1 }), 0.014);
    const nc = this.trees.filter((t) => t.kind === 0).length;
    const nb = this.trees.length - nc;
    this.conifer = new THREE.InstancedMesh(coniferGeo, foliage, nc);
    this.broad = new THREE.InstancedMesh(broadGeo, foliage, nb);
    this.trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, this.trees.length);
    for (const im of [this.conifer, this.broad, this.trunks]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
    }
    let ic = 0, ib = 0;
    this.trees.forEach((t, i) => {
      this.setMatrix(t, 1);
      if (t.kind === 0) {
        this.idxC[i] = ic;
        this.conifer.setMatrixAt(ic, this.m);
        this.conifer.setColorAt(ic++, t.base);
      } else {
        this.idxB[i] = ib;
        this.broad.setMatrixAt(ib, this.m);
        this.broad.setColorAt(ib++, t.base);
      }
      this.trunks.setMatrixAt(i, this.m);
    });
    this.trunks.castShadow = false;
    this.group.add(this.conifer, this.broad, this.trunks);
  }

  get count(): number {
    return this.trees.length;
  }

  private setMatrix(t: Tree, crown: number): void {
    this.q.setFromAxisAngle(this.v.set(0, 1, 0), t.rot);
    this.sc.set(t.s * crown, t.s * (0.4 + 0.6 * crown), t.s * crown);
    this.m.compose(this.v.set(t.x, t.y - 0.5, t.z), this.q, this.sc);
  }

  update(fire: FireModel): void {
    if (fire.version === this.lastVersion) return;
    this.lastVersion = fire.version;
    const burnCol = new THREE.Color(0x2a1408);
    const charCol = new THREE.Color(0x0b0a09);
    const c = new THREE.Color();
    let dirtyM = false;
    this.trees.forEach((t, i) => {
      const st = fire.state[t.cell];
      const I = fire.intensity[t.cell];
      const charred = fire.fuel0[t.cell] > 0 ? 1 - fire.fuel[t.cell] / fire.fuel0[t.cell] : 0;
      if (st === BURNING) c.copy(t.base).lerp(burnCol, Math.min(1, 0.4 + I * 0.6 + charred));
      else if (st === BURNT || charred > 0.5) c.copy(charCol);
      else if (fire.wet[t.cell] > 0.2) c.copy(t.base).multiplyScalar(0.75);
      else c.copy(t.base);
      const mesh = t.kind === 0 ? this.conifer : this.broad;
      const k = t.kind === 0 ? this.idxC[i] : this.idxB[i];
      mesh.setColorAt(k, c);
      const newState = st === BURNT ? 2 : 0;
      if (newState !== t.state) {
        t.state = newState;
        this.setMatrix(t, newState === 2 ? 0.35 : 1);
        mesh.setMatrixAt(k, this.m);
        dirtyM = true;
      }
    });
    this.conifer.instanceColor!.needsUpdate = true;
    this.broad.instanceColor!.needsUpdate = true;
    if (dirtyM) {
      this.conifer.instanceMatrix.needsUpdate = true;
      this.broad.instanceMatrix.needsUpdate = true;
    }
  }

  setShadows(on: boolean): void {
    this.conifer.castShadow = this.broad.castShadow = on;
  }
}
