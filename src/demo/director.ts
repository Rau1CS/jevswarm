/**
 * Cinematic demo director. A curated ~2:40 timeline layered on a LIVE simulation:
 * the director sets up the scenario, cues camera shots, captions and a few scripted
 * beats (hero detection, wind shift); the swarm's reactions come from the coordinator.
 * Where a beat has not happened naturally by its cue, the director nudges it.
 */
import * as THREE from 'three';
import { BASE_POS } from '../config';
import { dist2 } from '../core/math';
import { heightAt } from '../world/layout';
import type { CameraRig } from '../render/cameraRig';
import type { Simulation } from '../sim/simulation';
import type { Drone } from '../sim/drone';
import { windShift } from '../sim/events';

export interface DirectorHost {
  sim: Simulation;
  rig: CameraRig;
  caption(t: string | null): void;
  title(on: boolean): void;
  hud(on: boolean): void;
  endCard(): void;
  finish(): void;
  select(d: Drone | null): void;
  callout(title: string, lines: string[]): void;
}

interface Cue { at: number; run: () => void; done?: boolean }

export class Director {
  t = 0;
  private cues: Cue[] = [];
  userCamera = false;
  private heroDet: string | null = null;
  private lastCalloutT = -1;
  finished = false;

  constructor(private h: DirectorHost) {
    const sim = h.sim;
    sim.coordinator.calloutsEnabled = false;
    const hero = () => sim.civilians.find((c) => c.hero)!;
    const heroDetObj = () => sim.sensors.detections.find((d) => d.id === this.heroDet);
    const cam = (fn: () => void) => () => { if (!this.userCamera) fn(); };
    const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const fireCentroid = () => {
      const b = sim.fire.burning;
      if (!b.length) return { x: -600, z: -200 };
      let x = 0, z = 0;
      for (const k of b) { const c = sim.fire.cellCenter(k % sim.fire.n, (k / sim.fire.n) | 0); x += c.x; z += c.z; }
      return { x: x / b.length, z: z / b.length };
    };
    const heroDrone = (task: string) => sim.drones.find((d) => d.task.objectiveId === `CIV_${this.heroDet}` && d.task.kind === task) ?? null;
    const supDrone = () => {
      const hc = hero();
      return sim.drones
        .filter((d) => d.task.kind === 'SUPPRESS' && d.airborne)
        .sort((a, b) => dist2(a.task.target.x, a.task.target.z, hc.x, hc.z) - dist2(b.task.target.x, b.task.target.z, hc.x, hc.z))[0] ?? null;
    };
    this.cues = [
      { at: 0, run: cam(() => {
        const f = fireCentroid();
        h.rig.flyTo(v3(f.x + 1300, 700, f.z + 1500), v3(f.x + 200, 40, f.z + 100), 0.01);
        h.rig.cineOrbit(v3(f.x + 250, 40, f.z + 150), 1500, 620, 0.035);
      }) },
      { at: 5, run: () => h.title(true) },
      { at: 8.5, run: cam(() => h.rig.flyTo(v3(BASE_POS.x + 170, heightAt(BASE_POS.x, BASE_POS.z) + 70, BASE_POS.z + 150), v3(BASE_POS.x - 10, heightAt(BASE_POS.x, BASE_POS.z) + 10, BASE_POS.z), 2.5)) },
      { at: 10, run: () => {
        h.title(false);
        sim.launchAll(sim.t, 0.55);
        h.caption(`${sim.drones.length} AUTONOMOUS AIRCRAFT LAUNCHING`);
      } },
      { at: 13, run: () => h.hud(true) },
      { at: 14, run: cam(() => h.rig.cineOrbit(v3(BASE_POS.x + 40, heightAt(BASE_POS.x, BASE_POS.z) + 40, BASE_POS.z - 60), 230, 90, 0.12)) },
      { at: 19, run: cam(() => {
        h.rig.flyTo(v3(-1020, 470, 1020), v3(-300, 60, 160), 4.5);
        h.caption('SWARM DISPERSES · SECTORS ASSIGNED BY JEV');
      }) },
      { at: 33, run: cam(() => {
        const f = fireCentroid();
        h.rig.frame(f.x + 80, f.z, 680, 4, 1.25);
        h.caption('FIRE FRONT MAPPING · THERMAL SEARCH UNDERWAY');
      }) },
      { at: 48, run: () => {
        // Hero beat: a scout picks up a thermal signature near the western houses.
        const hc = hero();
        let det = sim.sensors.detections.find((d) => d.truthCivId === hc.id && d.status === 'POSSIBLE');
        if (!det) {
          const scout = sim.drones.filter((d) => d.role === 'SCOUT' && d.airborne).sort((a, b) => dist2(a.x, a.z, hc.x, hc.z) - dist2(b.x, b.z, hc.x, hc.z))[0];
          det = sim.sensors.create(hc.x + 5, hc.z - 4, 0.64, hc.id, scout?.id ?? 'D12', sim.t, sim.sensorEvents);
        }
        det.conf = 0.64;
        // Curated: heavy smoke keeps verification inconclusive until ~1:53.
        det.holdUntil = sim.t + (113 - this.t) * sim.timeScale;
        this.heroDet = det.id;
        sim.coordinator.featured = `CIV_${det.id}`;
        h.callout('THERMAL SIGNATURE', [`CONFIDENCE ${Math.round(det.conf * 100)}% · SECTOR ${det.sector}`, `${det.by} → POSSIBLE HUMAN`]);
        if (!this.userCamera) h.rig.frame(hc.x, hc.z, 360, 3.2, -1.2);
        h.caption('POSSIBLE HUMAN DETECTED');
      } },
      { at: 64, run: () => {
        // Several more signatures in the village.
        const others = sim.civilians.filter((c) => !c.hero && !c.confirmed && c.behavior !== 'SAFE' && !sim.sensors.detections.some((d) => d.truthCivId === c.id))
          .sort((a, b) => dist2(a.x, a.z, 60, -60) - dist2(b.x, b.z, 60, -60)).slice(0, 3);
        for (const c of others) {
          const s = sim.drones.find((d) => d.role === 'SCOUT' && d.airborne);
          sim.sensors.create(c.x + 4, c.z + 3, 0.5 + Math.random() * 0.15, c.id, s?.id ?? 'D03', sim.t, sim.sensorEvents);
        }
        h.caption('MULTIPLE THERMAL DETECTIONS');
        if (!this.userCamera) h.rig.frame(40, -80, 820, 3.5, -2.0);
      } },
      { at: 75, run: () => {
        const hc = hero();
        sim.coordinator.calloutsEnabled = true;
        windShift(sim, 265, 7.8, heroDetObj()?.sector);
        h.caption('WIND SHIFT · FIRE NOW RUNNING EAST TOWARD THE VILLAGE');
        if (!this.userCamera) h.rig.frame((hc.x + fireCentroid().x) / 2 + 60, hc.z + 60, 1050, 2.6, 0.3);
      } },
      { at: 86, run: () => {
        if (this.lastCalloutT < 74) this.synthCallout();
      } },
      { at: 90, run: () => {
        const det = heroDetObj();
        const arr = det ? sim.arrival[sim.fire.cellOf(det.x, det.z)] : Infinity;
        h.caption(`CIVILIAN RISK CRITICAL · PREDICTED FIRE ARRIVAL ${Number.isFinite(arr) ? `${Math.floor(arr / 60)}:${String(Math.round(arr % 60)).padStart(2, '0')}` : '< 5 MIN'}`);
        const s = supDrone();
        if (s && !this.userCamera) {
          h.select(s);
          h.rig.followDrone(s, 'CHASE');
        }
      } },
      { at: 106, run: () => {
        // Nudge: make sure a suppression drop lands between fire and civilian.
        const s = supDrone();
        if (sim.stats.drops === 0 && s) {
          s.phase = 2;
          s.task.target = { ...s.task.target };
        }
        h.caption('SUPPRESSION DROP ON THE ADVANCING FRONT');
      } },
      { at: 113, run: () => {
        const v = heroDrone('VERIFY');
        if (v && !this.userCamera) {
          h.select(v);
          h.rig.followDrone(v, 'CHASE');
        }
        h.caption('VERIFYING · LOW ORBIT, RGB + THERMAL');
      } },
      { at: 118, run: () => {
        const det = heroDetObj();
        if (det && det.status === 'POSSIBLE') {
          const v = heroDrone('VERIFY') ?? sim.drones.find((d) => d.airborne)!;
          det.holdUntil = 0;
          sim.hooks.onVerifyComplete(v, det.id);
        }
      } },
      { at: 126, run: () => {
        const c = heroDrone('CORRIDOR') ?? heroDrone('GUIDE');
        if (c && !this.userCamera) {
          h.select(c);
          h.rig.followDrone(c, 'CHASE');
        }
        h.caption('SEARCHING FOR A SAFE EVACUATION CORRIDOR');
      } },
      { at: 132, run: () => {
        const det = heroDetObj();
        const cor = det ? sim.coordinator.corridors.get(det.id) : undefined;
        if (det && cor && !cor.flown) {
          const c = heroDrone('CORRIDOR') ?? sim.drones.find((d) => d.role === 'SCOUT' && d.airborne)!;
          c.task.detectionId = det.id;
          sim.hooks.onCorridorFlown(c, det.truthCivId ?? '');
        }
        const hc = hero();
        h.select(null);
        h.rig.release();
        if (!this.userCamera) h.rig.frame(hc.x + 150, hc.z + 180, 700, 3, -2.2);
        h.caption('SAFE CORRIDOR IDENTIFIED · CIVILIAN GUIDED OUT');
      } },
      { at: 143, run: () => h.caption('MISSION STATUS IMPROVING') },
      { at: 150, run: () => {
        h.caption(null);
        h.hud(false);
        if (!this.userCamera) h.rig.flyTo(v3(-1700, 1300, 1900), v3(-50, 0, 0), 6);
      } },
      { at: 154, run: () => h.endCard() },
      { at: 164, run: () => {
        this.finished = true;
        h.finish();
      } },
    ];
  }

  noteCallout(): void {
    this.lastCalloutT = this.t;
  }

  /** If Jev/fallback didn't escalate on its own, summarise the current plan honestly. */
  private synthCallout(): void {
    const sim = this.h.sim;
    const lines = sim.drones
      .filter((d) => d.task.objectiveId === `CIV_${this.heroDet}` || d.task.kind === 'SUPPRESS' || d.task.kind === 'RELAY')
      .slice(0, 4)
      .map((d) => `${d.id} → ${d.task.label}`);
    if (lines.length) this.h.callout('JEV PRIORITY CHANGE', ['CIVILIAN RISK: CRITICAL', ...lines]);
  }

  update(dt: number): void {
    this.t += dt;
    for (const c of this.cues) {
      if (!c.done && this.t >= c.at) {
        c.done = true;
        c.run();
      }
    }
  }
}
