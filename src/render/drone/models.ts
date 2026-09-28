/**
 * Drone model catalogue: airframe specs (real-world dimensions) and the Blender-authored
 * GLB (public/models/jev_drones.glb, built by tools/blender/build_drones.py).
 *
 * GLB objects are named KIT__part__material__lod. Kits:
 *   LIGHT, HEAVY                      airframes (HEAVY includes its 20 L suppression system)
 *   PAY_SCOUT|SUPPRESSION|LOGISTICS|RELAY   role payload modules for the LIGHT airframe
 *   PROP_L_CCW/CW, PROP_H_CCW/CW       single propellers at origin (hub on +Y axis)
 * Until the GLB has loaded (or if it fails) a coarse procedural fallback is served.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Role } from '../../sim/drone';

export type Airframe = 'LIGHT' | 'HEAVY';

export interface RotorSpec {
  x: number; y: number; z: number;
  /** Counter-clockwise seen from above (positive rotation about +Y). */
  ccw: boolean;
  /** Prop mounted upside-down (lower rotor of a coaxial pair). */
  inverted: boolean;
}

export interface AirframeSpec {
  id: Airframe;
  label: string;
  /** Motor-to-motor diagonal (m), prop diameter (m) — real-world scale. */
  wheelbase: number;
  propDiameter: number;
  /** Overall span including props (m). */
  span: number;
  frameKit: string;
  propKit: { ccw: string; cw: string };
  rotors: RotorSpec[];
  /** Depth of the landing-gear foot below the model origin (m). */
  footDepth: number;
  /** Nav lights [x, y, z, colour, strobe] in model space. */
  navLights: [number, number, number, number, boolean][];
  /** Visual prop spin multiplier (big props turn slower). */
  spin: number;
}

const r45 = (r: number) => r / Math.SQRT2;
const quad = (r: number, y: number, inverted: boolean, flip: boolean): RotorSpec[] =>
  // PX4 quad-X: front-right & rear-left CCW; front-left & rear-right CW (+X is port / left).
  [[1, 1, false], [-1, 1, true], [-1, -1, false], [1, -1, true]].map(([sx, sz, ccw]) => ({
    x: (sx as number) * r45(r), y, z: (sz as number) * r45(r), ccw: flip ? !ccw : (ccw as boolean), inverted,
  }));

export const AIRFRAMES: Record<Airframe, AirframeSpec> = {
  LIGHT: {
    id: 'LIGHT', label: 'X500-CLASS QUAD', wheelbase: 0.5, propDiameter: 0.254, span: 0.61,
    frameKit: 'LIGHT', propKit: { ccw: 'PROP_L_CCW', cw: 'PROP_L_CW' },
    rotors: quad(0.25, 0.054, false, false), footDepth: 0.263, spin: 1,
    navLights: [[0.19, 0.014, 0.19, 0xff2a20, false], [-0.19, 0.014, 0.19, 0x30ff60, false], [0, 0.03, -0.1, 0xffffff, true]],
  },
  HEAVY: {
    id: 'HEAVY', label: 'HL-8 COAXIAL X8 HEAVY-LIFT', wheelbase: 1.9, propDiameter: 0.762, span: 2.66,
    frameKit: 'HEAVY', propKit: { ccw: 'PROP_H_CCW', cw: 'PROP_H_CW' },
    rotors: [...quad(0.95, 0.1806, false, false), ...quad(0.95, -0.1106, true, true)], footDepth: 0.544, spin: 0.55,
    navLights: [[0.7, 0.04, 0.7, 0xff2a20, false], [-0.7, 0.04, 0.7, 0x30ff60, false], [0, 0.32, -0.25, 0xffffff, true]],
  },
};

/** Payload kit for a role on the LIGHT airframe (HEAVY carries its own suppression system). */
export const payloadKit = (role: Role): string => `PAY_${role}`;

export type GeoByMat = Map<string, THREE.BufferGeometry>;

export interface DroneModels {
  /** True once the detailed GLB is loaded (false = procedural fallback). */
  readonly detailed: boolean;
  /** Geometry merged per material for a kit at a LOD (0 close-up, 1 distance). */
  kit(kit: string, lod: number): GeoByMat;
  /** LOD0 geometry per part, per material (for exploded views). */
  parts(kit: string): Map<string, GeoByMat>;
}

class Catalogue implements DroneModels {
  private merged = new Map<string, GeoByMat>();
  constructor(readonly detailed: boolean, private raw: Map<string, Map<string, Map<string, THREE.BufferGeometry[]>>>) {}

  /** raw key: `${kit}|${lod}` -> part -> mat -> geometries */
  kit(kit: string, lod: number): GeoByMat {
    const key = `${kit}|${lod}`;
    let out = this.merged.get(key);
    if (out) return out;
    const parts = this.raw.get(key) ?? this.raw.get(`${kit}|0`);
    const byMat = new Map<string, THREE.BufferGeometry[]>();
    parts?.forEach((mats) => mats.forEach((geos, mat) => byMat.set(mat, [...(byMat.get(mat) ?? []), ...geos])));
    out = new Map();
    for (const [mat, geos] of byMat) {
      const g = geos.length === 1 ? geos[0] : mergeGeometries(geos);
      if (g) out.set(mat, g);
    }
    this.merged.set(key, out);
    return out;
  }

  parts(kit: string): Map<string, GeoByMat> {
    const out = new Map<string, GeoByMat>();
    this.raw.get(`${kit}|0`)?.forEach((mats, part) => {
      const pm: GeoByMat = new Map();
      mats.forEach((geos, mat) => {
        const g = geos.length === 1 ? geos[0] : mergeGeometries(geos);
        if (g) pm.set(mat, g);
      });
      out.set(part, pm);
    });
    return out;
  }
}

type Raw = Map<string, Map<string, Map<string, THREE.BufferGeometry[]>>>;
function addRaw(raw: Raw, kit: string, lod: number, part: string, mat: string, g: THREE.BufferGeometry): void {
  const k = `${kit}|${lod}`;
  if (!raw.has(k)) raw.set(k, new Map());
  const parts = raw.get(k)!;
  if (!parts.has(part)) parts.set(part, new Map());
  const mats = parts.get(part)!;
  mats.set(mat, [...(mats.get(mat) ?? []), g]);
}

/** Coarse stand-in built from primitives (shown before the GLB arrives, or if it fails). */
function fallback(): DroneModels {
  const raw: Raw = new Map();
  const arm = (a: number, r: number, s: number) => new THREE.CylinderGeometry(0.008 * s, 0.008 * s, r * 2, 8).rotateZ(Math.PI / 2).rotateY(a);
  for (const [kit, s] of [['LIGHT', 1], ['HEAVY', 3.8]] as const) {
    addRaw(raw, kit, 0, 'canopy', 'paint', new THREE.BoxGeometry(0.13, 0.05, 0.18).scale(s, s, s).translate(0, 0.05 * s, 0));
    addRaw(raw, kit, 0, 'frame', 'carbon', mergeGeometries([arm(Math.PI / 4, 0.25, s), arm(-Math.PI / 4, 0.25, s)].map((g) => g.scale(s, 1, 1).translate(0, 0.01 * s, 0)))!);
    addRaw(raw, kit, 0, 'gear', 'carbon', new THREE.BoxGeometry(0.26, 0.01, 0.3).scale(s, s, s).translate(0, -0.25 * s, 0));
  }
  addRaw(raw, 'HEAVY', 0, 'tank', 'tank', new THREE.BoxGeometry(0.34, 0.26, 0.32).translate(0, -0.17, 0));
  for (const [kit, g] of [
    ['PAY_SCOUT', new THREE.SphereGeometry(0.04, 12, 8).translate(0, -0.1, 0.11)],
    ['PAY_SUPPRESSION', new THREE.CylinderGeometry(0.052, 0.052, 0.19, 14).rotateX(Math.PI / 2).translate(0, -0.14, 0)],
    ['PAY_LOGISTICS', new THREE.BoxGeometry(0.12, 0.074, 0.18).translate(0, -0.128, 0)],
    ['PAY_RELAY', new THREE.CylinderGeometry(0.005, 0.005, 0.33, 6).translate(0, 0.24, 0.02)],
  ] as const) addRaw(raw, kit, 0, 'payload', 'plastic_dark', g);
  for (const [kit, r] of [['PROP_L_CCW', 0.127], ['PROP_L_CW', 0.127], ['PROP_H_CCW', 0.381], ['PROP_H_CW', 0.381]] as const) {
    addRaw(raw, kit, 0, 'prop', 'prop', new THREE.BoxGeometry(r * 2, 0.004 * (r / 0.127), 0.022 * (r / 0.127)));
  }
  return new Catalogue(false, raw);
}

let fallbackModels: DroneModels | null = null;
let loaded: DroneModels | null = null;
let pending: Promise<DroneModels> | null = null;

/** Currently available models (detailed if loaded, else fallback). Never blocks. */
export function currentDroneModels(): DroneModels {
  return loaded ?? (fallbackModels ??= fallback());
}

/** Load the detailed GLB once; resolves to the fallback if loading fails. */
export function loadDroneModels(): Promise<DroneModels> {
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  const base = import.meta.env.BASE_URL ?? '/';
  const draco = new DRACOLoader().setDecoderPath(`${base}models/draco/`);
  const loader = new GLTFLoader().setDRACOLoader(draco);
  pending = loader.loadAsync(`${base}models/jev_drones.glb`).then(
    (gltf) => {
      const raw: Raw = new Map();
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const [kit, part, mat, lod] = mesh.name.split('__');
        if (!kit || !part || !mat || lod === undefined) return;
        const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
        if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
        addRaw(raw, kit, Number(lod), part, mat, g);
      });
      draco.dispose();
      loaded = new Catalogue(true, raw);
      return loaded;
    },
    (err) => {
      console.warn('[drones] detailed models unavailable, using fallback', err);
      draco.dispose();
      pending = null;
      return currentDroneModels();
    },
  );
  return pending;
}
