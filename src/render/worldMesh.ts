/**
 * Static world geometry: terrain (fire-reactive shader), roads, lake, buildings,
 * command post and safe zone.
 */
import * as THREE from 'three';
import { BASE_POS, FIRE_N, HALF, LAKE, SAFE_ZONE, WORLD_SIZE } from '../config';
import { clamp, fbm, smoothstep } from '../core/math';
import { BUILDINGS, ROADS, WATER_LEVEL, heightAt, vegetationAt } from '../world/layout';
import { GLOBAL, applyThermal } from './thermal';

export class WorldMesh {
  readonly group = new THREE.Group();
  readonly fireTex: THREE.DataTexture;
  terrain!: THREE.Mesh;
  terrainGeo!: THREE.BufferGeometry;
  readonly buildingMeshes: { walls: THREE.Mesh; roof: THREE.Mesh; id: string }[] = [];
  private beacons: THREE.Mesh[] = [];

  constructor(fireData: Uint8Array) {
    this.fireTex = new THREE.DataTexture(fireData, FIRE_N, FIRE_N, THREE.RGBAFormat);
    this.fireTex.magFilter = THREE.LinearFilter;
    this.fireTex.minFilter = THREE.LinearFilter;
    this.fireTex.needsUpdate = true;
    this.buildTerrain();
    this.buildRoads();
    this.buildWater();
    this.buildBuildings();
    this.buildBase();
    this.buildSafeZone();
  }

  private buildTerrain(): void {
    const seg = 256;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = heightAt(x, z);
      pos.setY(i, h);
      const v = vegetationAt(x, z);
      const n = fbm(x / 40, z / 40, 3, 5);
      const slope = Math.abs(heightAt(x + 6, z) - h) + Math.abs(heightAt(x, z + 6) - h);
      // Biome palette (linear-ish sRGB values, converted below).
      if (h < WATER_LEVEL + 1.5) c.setRGB(0.42, 0.38, 0.3);
      else if (v > 0.55) c.setRGB(0.1 + n * 0.05, 0.13 + n * 0.06, 0.07);
      else if (v > 0.26) c.setRGB(0.24 + n * 0.08, 0.27 + n * 0.06, 0.13);
      else if (v > 0.12) c.setRGB(0.4 + n * 0.1, 0.36 + n * 0.08, 0.21);
      else c.setRGB(0.36 + n * 0.05, 0.34 + n * 0.05, 0.29);
      if (slope > 5) c.lerp(new THREE.Color(0.33, 0.31, 0.29), smoothstep(5, 10, slope));
      c.convertSRGBToLinear();
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.terrainGeo = geo;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
    const fireTex = this.fireTex;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFire = { value: fireTex };
      shader.uniforms.uTime = GLOBAL.uTime;
      shader.uniforms.uThermal = GLOBAL.uThermal;
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec2 vWXZ;\nvoid main() {')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vWXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          `uniform sampler2D uFire; uniform float uTime; uniform float uThermal; varying vec2 vWXZ;
           float hsh(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5); }
           float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
             return mix(mix(hsh(i),hsh(i+vec2(1,0)),f.x), mix(hsh(i+vec2(0,1)),hsh(i+vec2(1,1)),f.x), f.y); }
           void main() {`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           vec2 fuv = (vWXZ + ${HALF.toFixed(1)}) / ${WORLD_SIZE.toFixed(1)};
           vec4 fs = texture2D(uFire, fuv);
           float ch = smoothstep(0.05, 0.9, fs.g);
           float nn = vnoise(vWXZ * 0.12);
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.018, 0.016, 0.014) + nn * 0.012, ch * 0.92);
           diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.62, 0.7), fs.b * 0.7);`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           float flick = 0.75 + 0.25 * vnoise(vWXZ * 0.08 + uTime * 1.7);
           float I = fs.r;
           totalEmissiveRadiance += vec3(1.0, 0.33, 0.06) * pow(I, 1.3) * 1.5 * flick;
           float smoulder = ch * (1.0 - smoothstep(0.0, 0.2, I)) * step(0.62, vnoise(vWXZ * 0.35 + uTime * 0.2));
           totalEmissiveRadiance += vec3(0.9, 0.2, 0.03) * smoulder * 0.25 * (1.0 - fs.b);`,
        )
        .replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
           if (uThermal > 0.5) {
             float heat = 0.018 + nn * 0.012 + fs.a * 0.95 + ch * 0.05 - fs.b * 0.01;
             gl_FragColor.rgb = vec3(heat);
           }`,
        );
    };
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.group.add(this.terrain);
    this.buildOuterLand();
  }

  /** Coarse landscape continuing to the horizon so the 2 km sim area has no visible edge. */
  private buildOuterLand(): void {
    const size = 16000, seg = 160;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const inside = Math.abs(x) < HALF - 20 && Math.abs(z) < HALF - 20;
      const far = Math.max(Math.abs(x), Math.abs(z));
      // Rolling hills that grow into distant ridges.
      const h = heightAt(clamp(x, -HALF, HALF), clamp(z, -HALF, HALF)) * (1 - smoothstep(HALF, HALF + 1500, far))
        + (fbm(x / 1400 + 3, z / 1400 - 2, 4, 11) - 0.4) * 260 * smoothstep(HALF + 200, HALF + 3000, far)
        + fbm(x / 300, z / 300, 3, 4) * 25 * smoothstep(HALF, HALF + 400, far);
      pos.setY(i, inside ? heightAt(x, z) - 6 : h);
      const n = fbm(x / 500, z / 500, 3, 8);
      const forest = smoothstep(0.4, 0.55, fbm(x / 260 + 3, z / 260 - 7, 4, 21));
      c.setRGB(0.1 + n * 0.05, 0.13 + n * 0.06, 0.07).lerp(new THREE.Color(0.4 + n * 0.1, 0.36 + n * 0.08, 0.21), 1 - forest).convertSRGBToLinear();
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const outer = new THREE.Mesh(geo, applyThermal(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }), 0.015));
    outer.receiveShadow = true;
    this.group.add(outer);
  }

  private buildRoads(): void {
    const mat = applyThermal(new THREE.MeshStandardMaterial({ color: 0x2b2a28, roughness: 0.9 }), 0.035);
    for (const r of ROADS) {
      const verts: number[] = [];
      const idx: number[] = [];
      let n = 0;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        const L = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.max(2, Math.ceil(L / 8));
        const nx = -(b.z - a.z) / L, nz = (b.x - a.x) / L;
        for (let s = 0; s <= steps; s++) {
          if (i > 0 && s === 0) continue;
          const t = s / steps;
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          for (const side of [-1, 1]) {
            const px = x + nx * side * r.width / 2, pz = z + nz * side * r.width / 2;
            verts.push(px, heightAt(px, pz) + 0.35, pz);
          }
          if (n > 0) idx.push(n * 2 - 2, n * 2 - 1, n * 2, n * 2 - 1, n * 2 + 1, n * 2);
          n++;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      this.group.add(m);
    }
  }

  private buildWater(): void {
    const g = new THREE.CircleGeometry(LAKE.r * 1.6, 64);
    g.rotateX(-Math.PI / 2);
    const mat = applyThermal(new THREE.MeshPhongMaterial({ color: 0x33474f, emissive: 0x2a3036, specular: 0xb0a090, shininess: 120, transparent: true, opacity: 0.94 }), 0.008);
    const m = new THREE.Mesh(g, mat);
    m.position.set(LAKE.x, WATER_LEVEL, LAKE.z);
    this.group.add(m);
  }

  private buildBuildings(): void {
    const walls = [0xc9c0b0, 0xb8b2a6, 0xd6cdbb, 0x9e958a];
    const roofs = [0x6b2e24, 0x3c3f45, 0x5a4331, 0x33403a];
    for (const b of BUILDINGS) {
      const h0 = Math.min(heightAt(b.x - b.w / 2, b.z - b.d / 2), heightAt(b.x + b.w / 2, b.z + b.d / 2), heightAt(b.x, b.z));
      const wm = applyThermal(new THREE.MeshStandardMaterial({ color: walls[b.roof % 4], roughness: 0.85 }), 0.06);
      const w = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h + 2, b.d), wm);
      w.position.set(b.x, h0 + (b.h + 2) / 2 - 1, b.z);
      w.rotation.y = b.rot;
      w.castShadow = w.receiveShadow = true;
      const rg = new THREE.ConeGeometry(1, 1, 4, 1);
      rg.rotateY(Math.PI / 4);
      const rm = applyThermal(new THREE.MeshStandardMaterial({ color: roofs[b.roof], roughness: 0.7 }), 0.05);
      const r = new THREE.Mesh(rg, rm);
      r.scale.set((b.w / 2) * 1.5, 4.5, (b.d / 2) * 1.5);
      r.position.set(b.x, h0 + b.h + 1 + 2.25, b.z);
      r.rotation.y = b.rot;
      r.castShadow = true;
      this.group.add(w, r);
      this.buildingMeshes.push({ walls: w, roof: r, id: b.id });
    }
  }

  private buildBase(): void {
    const h = heightAt(BASE_POS.x, BASE_POS.z);
    const concrete = applyThermal(new THREE.MeshStandardMaterial({ color: 0x5b5a57, roughness: 0.95 }), 0.05);
    const pad = new THREE.Mesh(new THREE.BoxGeometry(170, 0.6, 140), concrete);
    pad.position.set(BASE_POS.x - 10, h + 0.1, BASE_POS.z);
    pad.receiveShadow = true;
    this.group.add(pad);
    const white = applyThermal(new THREE.MeshStandardMaterial({ color: 0xd8d6d0, roughness: 0.8 }), 0.12);
    const tent = applyThermal(new THREE.MeshStandardMaterial({ color: 0x4e5a48, roughness: 0.9 }), 0.1);
    const boxes: [number, number, number, number, number, THREE.Material][] = [
      [BASE_POS.x + 45, BASE_POS.z - 35, 14, 6, 6, white], [BASE_POS.x + 45, BASE_POS.z - 22, 14, 6, 6, white],
      [BASE_POS.x + 55, BASE_POS.z + 10, 20, 7, 14, tent], [BASE_POS.x + 30, BASE_POS.z + 40, 12, 5, 8, white],
    ];
    for (const [x, z, w, hh, d, m] of boxes) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), m);
      b.position.set(x, h + hh / 2, z);
      b.castShadow = b.receiveShadow = true;
      this.group.add(b);
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.2, 34, 6), white);
    mast.position.set(BASE_POS.x + 62, h + 17, BASE_POS.z - 42);
    this.group.add(mast);
    const bm = new THREE.Mesh(new THREE.SphereGeometry(1.4, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    bm.position.set(mast.position.x, h + 34.5, mast.position.z);
    this.beacons.push(bm);
    this.group.add(bm);
    // Landing pad markings.
    const mark = new THREE.MeshBasicMaterial({ color: 0x6f6d67, transparent: true, opacity: 0.6 });
    for (let i = 0; i < 25; i++) {
      const cols = 5;
      const m = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.8, 20), mark);
      m.rotation.x = -Math.PI / 2;
      m.position.set(BASE_POS.x - 60 + (i % cols) * 12, h + 0.45, BASE_POS.z - 40 + Math.floor(i / cols) * 12);
      this.group.add(m);
    }
  }

  private buildSafeZone(): void {
    const h = heightAt(SAFE_ZONE.x, SAFE_ZONE.z);
    const ring = new THREE.Mesh(new THREE.RingGeometry(SAFE_ZONE.r - 2.5, SAFE_ZONE.r, 96), new THREE.MeshBasicMaterial({ color: 0x9ad1b8, transparent: true, opacity: 0.55 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(SAFE_ZONE.x, h + 0.6, SAFE_ZONE.z);
    this.group.add(ring);
    const tentMat = applyThermal(new THREE.MeshStandardMaterial({ color: 0xe6e2da, roughness: 0.8 }), 0.12);
    for (let i = 0; i < 6; i++) {
      const g = new THREE.ConeGeometry(7, 6, 4);
      const t = new THREE.Mesh(g, tentMat);
      const a = (i / 6) * Math.PI * 2;
      t.position.set(SAFE_ZONE.x + Math.cos(a) * 40, h + 3, SAFE_ZONE.z + Math.sin(a) * 40);
      t.rotation.y = a;
      t.castShadow = true;
      this.group.add(t);
    }
  }

  update(t: number, fire: { intensityAt(x: number, z: number): number; version: number }, texVersion: number): void {
    if (texVersion !== this.lastTexVersion) {
      this.fireTex.needsUpdate = true;
      this.lastTexVersion = texVersion;
      // Buildings char when fire reaches them.
      for (const b of this.buildingMeshes) {
        const I = fire.intensityAt(b.walls.position.x, b.walls.position.z);
        if (I > 0.2) {
          (b.walls.material as THREE.MeshStandardMaterial).color.lerp(new THREE.Color(0x201c18), 0.02);
          (b.roof.material as THREE.MeshStandardMaterial).color.lerp(new THREE.Color(0x151210), 0.02);
        }
      }
    }
    for (const b of this.beacons) b.visible = Math.sin(t * 4) > 0.3;
  }
  private lastTexVersion = -1;
}

export function terrainY(x: number, z: number): number {
  return heightAt(clamp(x, -HALF, HALF), clamp(z, -HALF, HALF));
}
