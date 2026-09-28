/**
 * Non-instanced, part-by-part drone assembly for close-up views (TECH page): every GLB
 * part becomes a labelled group with an explode offset, at real-world scale (metres).
 */
import * as THREE from 'three';
import type { Role } from '../../sim/drone';
import { AIRFRAMES, payloadKit, type Airframe, type DroneModels } from './models';
import type { DroneMaterials, DroneMatName } from './materials';

export interface AssemblyPart {
  name: string;
  /** Label shown on the exploded view (empty = unlabelled). */
  label: string;
  object: THREE.Object3D;
  /** Offset at full explosion (m). */
  explode: THREE.Vector3;
  /** Label anchor in assembly space before explosion. */
  anchor: THREE.Vector3;
}

export interface DroneAssembly {
  group: THREE.Group;
  parts: AssemblyPart[];
  /** Bounding radius of the assembled aircraft (m), for camera framing. */
  radius: number;
}

type PartInfo = [label: string, explode: [number, number, number], anchor?: [number, number, number]];

const LIGHT_PARTS: Record<string, PartInfo> = {
  frame: ['FRAME · CARBON PLATES, 16 MM FOLDING ARMS', [0, 0, 0], [0.13, 0.009, -0.13]],
  canopy: ['CANOPY', [0, 0.17, 0], [0, 0.07, 0.02]],
  fc: ['FLIGHT CONTROLLER (PIXHAWK-CLASS)', [0, 0.1, 0.06]],
  companion: ['COMPANION COMPUTER', [0, 0.1, -0.1]],
  gnss: ['GNSS + COMPASS (FOLDING MAST)', [0, 0.24, -0.05], [0, 0.18, -0.06]],
  radio: ['TELEMETRY RADIO', [0, -0.03, -0.09], [0.12, -0.03, -0.11]],
  depth: ['STEREO DEPTH SENSOR', [0, 0, 0.13]],
  battery: ['BATTERY · 4S LIPO + STRAPS', [0, -0.05, -0.22]],
  wiring: ['', [0, -0.05, -0.22]],
  gear: ['LANDING GEAR · FOAM FEET', [0, -0.1, 0], [0.12, -0.252, 0.12]],
  motors: ['MOTORS · 2216 KV920 ×4', [0, 0.07, 0], [0.177, 0.04, 0.177]],
  props: ['PROPELLERS · 10 × 4.5 IN', [0, 0.15, 0], [-0.24, 0.054, 0.12]],
};
const PAYLOAD_LABEL: Record<Role, string> = {
  SCOUT: 'GIMBAL · THERMAL + RGB',
  SUPPRESSION: 'SUPPRESSION · 1.5 L TANK, PUMP, NOZZLE',
  LOGISTICS: 'CARGO POD + RELEASE HOOK',
  RELAY: 'MESH RELAY RADIO',
};
const HEAVY_PARTS: Record<string, PartInfo> = {
  frame: ['CENTRE FRAME · CARBON', [0, 0, 0], [0.18, 0.035, -0.2]],
  canopy: ['FUSELAGE SHELL', [0, 0.42, 0], [0, 0.2, 0.15]],
  fc: ['FLIGHT CONTROLLER + COMPANION', [0, 0.26, 0.05]],
  battery: ['SMART BATTERY 14S 30 AH', [0, 0.72, -0.15]],
  gnss: ['DUAL RTK GNSS (HEADING)', [0, 0.52, 0.05], [0.2, 0.35, 0.12]],
  radar: ['TERRAIN + OBSTACLE RADAR', [0, 0.05, 0.45], [0, 0.03, 0.3]],
  arms: ['FOLDING ARMS · 40 MM CF + ESC', [0, 0, 0], [0.5, 0.035, 0.5]],
  motors: ['COAXIAL MOTORS ×8', [0, 0, 0], [-0.67, 0.12, 0.67]],
  props_up: ['PROPELLERS 30 IN · UPPER', [0, 0.32, 0], [0.67, 0.18, -0.67]],
  props_lo: ['LOWER (COUNTER-ROTATING)', [0, -0.36, 0], [-0.67, -0.11, -0.67]],
  tank: ['20 L SUPPRESSANT TANK', [0, -0.5, 0], [0.17, -0.17, 0]],
  pump: ['PUMP', [0, -0.72, -0.28], [-0.06, -0.3, -0.12]],
  nozzle: ['DIRECTED NOZZLE (PAN / TILT)', [0, -0.66, 0.42], [0, -0.33, 0.28]],
  gear: ['SKID GEAR + DAMPERS', [0, -0.2, 0], [0.37, -0.52, 0.3]],
};

function meshesFor(geos: Map<string, THREE.BufferGeometry>, mats: DroneMaterials): THREE.Group {
  const g = new THREE.Group();
  for (const [mat, geo] of geos) {
    const m = new THREE.Mesh(geo, mats[mat as DroneMatName] ?? mats.plastic_dark);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

function center(o: THREE.Object3D): THREE.Vector3 {
  return new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
}

/** Build a labelled, explodable assembly of an airframe (+ role payload for LIGHT). */
export function buildDroneAssembly(models: DroneModels, airframe: Airframe, role: Role, mats: DroneMaterials): DroneAssembly {
  const spec = AIRFRAMES[airframe];
  const info = airframe === 'HEAVY' ? HEAVY_PARTS : LIGHT_PARTS;
  const group = new THREE.Group();
  const parts: AssemblyPart[] = [];
  const add = (name: string, obj: THREE.Object3D, label: string, explode: [number, number, number], anchor?: [number, number, number]) => {
    group.add(obj);
    parts.push({ name, label, object: obj, explode: new THREE.Vector3(...explode), anchor: anchor ? new THREE.Vector3(...anchor) : center(obj) });
  };
  models.parts(spec.frameKit).forEach((geos, part) => {
    const [label, ex, an] = info[part] ?? [part.toUpperCase(), [0, 0, 0]];
    add(part, meshesFor(geos, mats), label, ex, an);
  });
  if (airframe === 'LIGHT') {
    models.parts(payloadKit(role)).forEach((geos, part) => {
      const mast = part === 'mast';
      add(`payload-${part}`, meshesFor(geos, mats), mast ? 'HIGH-GAIN MESH MAST' : PAYLOAD_LABEL[role], mast ? [0, 0.22, 0] : [0, -0.16, role === 'SCOUT' ? 0.08 : 0]);
    });
  }
  const propGeo = (kit: string) => models.kit(kit, 0);
  const upper = new THREE.Group(), lower = new THREE.Group();
  spec.rotors.forEach((r, i) => {
    const handedCCW = r.inverted ? !r.ccw : r.ccw;
    const p = meshesFor(propGeo(handedCCW ? spec.propKit.ccw : spec.propKit.cw), mats);
    p.position.set(r.x, r.y, r.z);
    if (r.inverted) p.rotation.x = Math.PI;
    p.rotateY(0.6 + i * 1.3);
    p.userData.spin = r.ccw ? 1 : -1;
    (r.inverted ? lower : upper).add(p);
  });
  if (airframe === 'HEAVY') {
    add('props_up', upper, ...(HEAVY_PARTS.props_up as [string, [number, number, number], [number, number, number]]));
    add('props_lo', lower, ...(HEAVY_PARTS.props_lo as [string, [number, number, number], [number, number, number]]));
  } else {
    add('props', upper, ...(LIGHT_PARTS.props as [string, [number, number, number], [number, number, number]]));
  }
  const sphere = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere());
  return { group, parts, radius: sphere.radius };
}

/** Dispose the per-assembly materials (geometries are shared with the model catalogue). */
export function disposeMaterials(mats: DroneMaterials): void {
  for (const m of Object.values(mats)) m.dispose();
}
