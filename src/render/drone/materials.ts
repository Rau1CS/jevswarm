/**
 * PBR material set for the drone models. Material names match the `material` token in the
 * GLB object names (KIT__part__material__lod). Every material is thermal-patched with a
 * heat level so THERMAL view keeps working (motors/battery warm, water tank cold).
 */
import * as THREE from 'three';
import { applyThermal } from '../thermal';
import { carbonTextures, decalAtlas, grainTexture } from './textures';

export type DroneMatName =
  | 'carbon' | 'paint' | 'anod' | 'alu' | 'steel' | 'copper' | 'plastic_dark' | 'plastic_light' | 'rubber'
  | 'glass' | 'germanium' | 'prop' | 'battery' | 'tank' | 'decal' | 'wire_red' | 'pcb' | 'led';

/** Materials that take the per-drone role colour (instance colour, or `tint` when not instanced). */
export const TINTED: ReadonlySet<string> = new Set(['paint', 'anod']);

/** THERMAL view heat per material (0 cold .. 1 hot). */
const HEAT: Record<DroneMatName, number> = {
  carbon: 0.24, paint: 0.24, anod: 0.34, alu: 0.36, steel: 0.4, copper: 0.62, plastic_dark: 0.28,
  plastic_light: 0.24, rubber: 0.22, glass: 0.18, germanium: 0.18, prop: 0.14, battery: 0.46,
  tank: 0.08, decal: 0.22, wire_red: 0.4, pcb: 0.5, led: 0.3,
};

export interface DroneMaterialOptions {
  /** Explicit env map (field view). Omit to inherit scene.environment (tech page). */
  envMap?: THREE.Texture | null;
  envMapIntensity?: number;
  /** Role colour for non-instanced use (tech page). Instanced meshes use instanceColor instead. */
  tint?: number;
  /** Cheaper shading for the fleet view (no clearcoat). */
  lite?: boolean;
}

export type DroneMaterials = Record<DroneMatName, THREE.MeshStandardMaterial>;

export function createDroneMaterials(o: DroneMaterialOptions = {}): DroneMaterials {
  const carbon = carbonTextures();
  const grain = grainTexture();
  const tint = o.tint ?? 0xffffff;
  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
  const phys = (p: THREE.MeshPhysicalMaterialParameters) => (o.lite ? new THREE.MeshStandardMaterial(stripPhysical(p)) : new THREE.MeshPhysicalMaterial(p));
  const m: DroneMaterials = {
    carbon: phys({
      color: 0xffffff, map: carbon.map, normalMap: carbon.normalMap, normalScale: new THREE.Vector2(0.55, 0.55),
      roughnessMap: carbon.roughnessMap, roughness: 1, metalness: 0.1, clearcoat: 0.45, clearcoatRoughness: 0.3,
    }),
    paint: phys({ color: new THREE.Color(tint).multiplyScalar(0.92), roughness: 0.42, roughnessMap: grain, metalness: 0.0, clearcoat: 0.55, clearcoatRoughness: 0.25 }),
    anod: std({ color: new THREE.Color(tint).multiplyScalar(0.7), roughness: 0.32, roughnessMap: grain, metalness: 0.85 }),
    alu: std({ color: 0x34373b, roughness: 0.38, roughnessMap: grain, metalness: 0.9 }),
    steel: std({ color: 0xc4c8cc, roughness: 0.22, metalness: 1.0 }),
    copper: std({ color: 0xb8703a, roughness: 0.34, metalness: 1.0 }),
    plastic_dark: std({ color: 0x1b1d20, roughness: 0.62, roughnessMap: grain, metalness: 0.0 }),
    plastic_light: std({ color: 0xe4e4df, roughness: 0.5, roughnessMap: grain, metalness: 0.0 }),
    rubber: std({ color: 0x121213, roughness: 0.92, metalness: 0.0 }),
    glass: phys({ color: 0x0b1020, roughness: 0.04, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 0.6, iridescenceIOR: 1.6 }),
    germanium: phys({ color: 0x3a3440, roughness: 0.12, metalness: 0.75, clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 0.8 }),
    prop: phys({ color: 0x151618, roughness: 0.38, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.2 }),
    battery: std({ color: 0x1f2a36, roughness: 0.45, metalness: 0.05 }),
    tank: phys({ color: 0xe9e7df, roughness: 0.58, roughnessMap: grain, metalness: 0.0, sheen: 0.4, sheenRoughness: 0.6, sheenColor: 0xffffff }),
    decal: std({ map: decalAtlas(), transparent: false, alphaTest: 0.45, roughness: 0.5, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    wire_red: std({ color: 0x9a1810, roughness: 0.55, metalness: 0 }),
    pcb: std({ color: 0x1d4a34, roughness: 0.5, metalness: 0.2 }),
    led: std({ color: 0x2a3a2e, emissive: 0x40ff78, emissiveIntensity: 2.2, roughness: 0.3 }),
  };
  for (const [name, mat] of Object.entries(m) as [DroneMatName, THREE.MeshStandardMaterial][]) {
    if (o.envMap !== undefined) mat.envMap = o.envMap;
    mat.envMapIntensity = (o.envMapIntensity ?? 1) * (name === 'carbon' ? 0.55 : 1);
    mat.name = `drone-${name}`;
    applyThermal(mat, HEAT[name]);
  }
  return m;
}

function stripPhysical(p: THREE.MeshPhysicalMaterialParameters): THREE.MeshStandardMaterialParameters {
  const { clearcoat, clearcoatRoughness, iridescence, iridescenceIOR, sheen, sheenRoughness, sheenColor, ...rest } = p;
  void clearcoat; void clearcoatRoughness; void iridescence; void iridescenceIOR; void sheen; void sheenRoughness; void sheenColor;
  return rest as THREE.MeshStandardMaterialParameters;
}
