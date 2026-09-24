/** Civilians, vehicles, supply packages and detection markers. */
import * as THREE from 'three';
import { heightAt } from '../world/layout';
import type { Civilian } from '../sim/civilians';
import type { Detection } from '../sim/sensors';
import type { Vehicle } from '../sim/vehicles';
import type { Package } from '../sim/simulation';
import { applyThermal } from './thermal';

const CIV_SCALE = 2.6;
const CLOTHES = [0x3a5a8a, 0x8a3a32, 0x4f6b3a, 0xb58a3a, 0x5a4a6a, 0x2f3033, 0xa0a4a8];

export class Actors {
  readonly group = new THREE.Group();
  private civ = new Map<string, THREE.Group>();
  private civMark = new Map<string, THREE.Group>();
  private veh = new Map<string, { g: THREE.Group; lights: THREE.Mesh[] }>();
  private pkgs: THREE.Group[] = [];
  private dets = new Map<string, THREE.Mesh>();
  private skin = applyThermal(new THREE.MeshStandardMaterial({ color: 0xc89a7a, roughness: 0.7 }), 1.0);
  private detMatP = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
  private detMatC = new THREE.MeshBasicMaterial({ color: 0x7fe0c8, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });

  private makeCiv(i: number): THREE.Group {
    const g = new THREE.Group();
    const cloth = applyThermal(new THREE.MeshStandardMaterial({ color: CLOTHES[i % CLOTHES.length], roughness: 0.8 }), 0.92);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.85, 4, 8), cloth);
    body.position.y = 0.72;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), this.skin);
    head.position.y = 1.52;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), cloth);
    legL.position.set(0.1, 0.25, 0);
    const legR = legL.clone();
    legR.position.x = -0.1;
    legL.name = 'legL';
    legR.name = 'legR';
    g.add(body, head, legL, legR);
    g.scale.setScalar(CIV_SCALE);
    g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    this.group.add(g);
    return g;
  }

  private makeMark(): THREE.Group {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(6, 7.2, 40).rotateX(-Math.PI / 2), this.detMatC);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 26, 6, 1, true), new THREE.MeshBasicMaterial({ color: 0x7fe0c8, transparent: true, opacity: 0.35, depthWrite: false }));
    beam.position.y = 13;
    const cap = new THREE.Mesh(new THREE.OctahedronGeometry(1.6), new THREE.MeshBasicMaterial({ color: 0x9ff0dc }));
    cap.position.y = 28;
    cap.name = 'cap';
    g.add(ring, beam, cap);
    this.group.add(g);
    return g;
  }

  private makeVehicle(v: Vehicle): { g: THREE.Group; lights: THREE.Mesh[] } {
    const g = new THREE.Group();
    const colors = { ENGINE: 0xb02a1e, AMBULANCE: 0xe8e6e0, COMMAND: 0xdad8d2 };
    const mat = applyThermal(new THREE.MeshStandardMaterial({ color: colors[v.kind], roughness: 0.5, metalness: 0.2 }), 0.3);
    const body = new THREE.Mesh(new THREE.BoxGeometry(8, 2.8, 2.6), mat);
    body.position.set(-0.6, 1.9, 0);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.5), mat);
    cab.position.set(3.9, 1.7, 0);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 2.2), new THREE.MeshStandardMaterial({ color: 0x1a2530, roughness: 0.1 }));
    glass.position.set(5.12, 2.2, 0);
    const lights: THREE.Mesh[] = [];
    for (const [z, c] of [[-0.6, 0xff2020], [0.6, 0x2060ff]] as const) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.5), new THREE.MeshBasicMaterial({ color: c }));
      l.position.set(4, 3.05, z);
      lights.push(l);
      g.add(l);
    }
    g.add(body, cab, glass);
    g.scale.setScalar(1.5);
    g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    this.group.add(g);
    return { g, lights };
  }

  update(t: number, civs: Civilian[], dets: Detection[], vehicles: Vehicle[], pkgs: Package[]): void {
    civs.forEach((c, i) => {
      let g = this.civ.get(c.id);
      if (!g) {
        g = this.makeCiv(i);
        this.civ.set(c.id, g);
      }
      g.visible = !c.indoor && c.behavior !== 'SAFE';
      g.position.set(c.x, heightAt(c.x, c.z), c.z);
      g.rotation.y = -c.heading + Math.PI / 2;
      const moving = c.behavior === 'EVACUATE' || c.behavior === 'GUIDED' || c.behavior === 'WANDER';
      const sw = moving ? Math.sin(c.walkPhase * 2) * 0.5 : c.behavior === 'TRAPPED' ? Math.sin(c.walkPhase * 3) * 0.08 : 0;
      g.getObjectByName('legL')!.rotation.x = sw;
      g.getObjectByName('legR')!.rotation.x = -sw;
      let m = this.civMark.get(c.id);
      if (c.confirmed && c.behavior !== 'SAFE') {
        if (!m) {
          m = this.makeMark();
          this.civMark.set(c.id, m);
        }
        m.visible = true;
        m.position.copy(g.position);
        m.getObjectByName('cap')!.rotation.y = t * 1.5;
      } else if (m) m.visible = false;
    });
    for (const d of dets) {
      let r = this.dets.get(d.id);
      if (!r) {
        r = new THREE.Mesh(new THREE.RingGeometry(1, 1.12, 48).rotateX(-Math.PI / 2), this.detMatP);
        this.dets.set(d.id, r);
        this.group.add(r);
      }
      r.visible = d.status === 'POSSIBLE';
      const pulse = 1 + 0.12 * Math.sin(t * 5 + d.x);
      const rad = (14 + (1 - d.conf) * 22) * pulse;
      r.scale.set(rad, 1, rad);
      r.position.set(d.x, heightAt(d.x, d.z) + 1, d.z);
    }
    for (const v of vehicles) {
      let e = this.veh.get(v.id);
      if (!e) {
        e = this.makeVehicle(v);
        this.veh.set(v.id, e);
      }
      e.g.position.set(v.x, heightAt(v.x, v.z) + 0.3, v.z);
      e.g.rotation.y = -v.ang;
      const on = Math.sin(t * 10) > 0;
      e.lights[0].visible = on;
      e.lights[1].visible = !on;
    }
    while (this.pkgs.length < pkgs.length) {
      const g = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 1.6), applyThermal(new THREE.MeshStandardMaterial({ color: 0xe0782a }), 0.3));
      const chute = new THREE.Mesh(new THREE.SphereGeometry(3.2, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xf2f0ea, side: THREE.DoubleSide }));
      chute.position.y = 6;
      chute.name = 'chute';
      g.add(box, chute);
      this.group.add(g);
      this.pkgs.push(g);
    }
    pkgs.forEach((p, i) => {
      this.pkgs[i].position.set(p.x, p.y, p.z);
      this.pkgs[i].getObjectByName('chute')!.visible = !p.landed;
    });
  }
}
