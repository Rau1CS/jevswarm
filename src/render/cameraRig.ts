/**
 * Camera rig: free orbit (OrbitControls), eased fly-to transitions, drone follow modes
 * (chase / POV / thermal / map) and director-driven cinematic moves.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { heightAt } from '../world/layout';
import type { Drone } from '../sim/drone';

export type FollowMode = 'CHASE' | 'POV' | 'THERMAL' | 'MAP';

interface Tween { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; dur: number; age: number; ease: (t: number) => number }

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraRig {
  readonly controls: OrbitControls;
  private tween: Tween | null = null;
  follow: Drone | null = null;
  followMode: FollowMode = 'CHASE';
  lastUserInput = -999;
  private orbitCine: { center: THREE.Vector3; radius: number; height: number; speed: number; a: number } | null = null;
  onUserTakeover: (() => void) | null = null;

  constructor(public camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 3600;
    this.controls.target.set(0, 60, 0);
    this.controls.zoomSpeed = 1.2;
    const mark = () => {
      this.lastUserInput = performance.now() / 1000;
      if (this.tween || this.orbitCine) {
        this.tween = null;
        this.orbitCine = null;
        this.onUserTakeover?.();
      }
    };
    dom.addEventListener('pointerdown', mark);
    dom.addEventListener('wheel', mark, { passive: true });
  }

  get userIdleSec(): number {
    return performance.now() / 1000 - this.lastUserInput;
  }

  flyTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 2.2): void {
    this.follow = null;
    this.orbitCine = null;
    this.tween = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos.clone(), t1: target.clone(), dur, age: 0, ease: easeInOut };
  }

  /** Frame a ground point from a pleasant oblique angle. */
  frame(x: number, z: number, dist = 420, dur = 2.2, azimuth?: number): void {
    const gy = heightAt(x, z);
    const cur = this.camera.position.clone().sub(this.controls.target);
    const az = azimuth ?? Math.atan2(cur.x, cur.z);
    const elev = 0.62;
    const pos = new THREE.Vector3(x + Math.sin(az) * Math.cos(elev) * dist, gy + Math.sin(elev) * dist, z + Math.cos(az) * Math.cos(elev) * dist);
    this.flyTo(pos, new THREE.Vector3(x, gy + 20, z), dur);
  }

  cineOrbit(center: THREE.Vector3, radius: number, height: number, speed: number): void {
    this.follow = null;
    this.tween = null;
    const cur = this.camera.position.clone().sub(center);
    this.orbitCine = { center, radius, height, speed, a: Math.atan2(cur.x, cur.z) };
  }

  followDrone(d: Drone, mode: FollowMode): void {
    this.tween = null;
    this.orbitCine = null;
    this.follow = d;
    this.followMode = mode;
  }

  release(): void {
    this.follow = null;
    this.controls.enabled = true;
    this.camera.fov = 50;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    const cam = this.camera;
    if (this.tween) {
      const tw = this.tween;
      tw.age += dt;
      const k = tw.ease(Math.min(1, tw.age / tw.dur));
      cam.position.lerpVectors(tw.p0, tw.p1, k);
      // Lift the midpoint so long moves arc over terrain rather than clip it.
      const lift = Math.sin(k * Math.PI) * Math.min(300, tw.p0.distanceTo(tw.p1) * 0.2);
      cam.position.y += lift;
      this.controls.target.lerpVectors(tw.t0, tw.t1, k);
      if (tw.age >= tw.dur) this.tween = null;
      cam.lookAt(this.controls.target);
      return;
    }
    if (this.orbitCine) {
      const o = this.orbitCine;
      o.a += o.speed * dt;
      const p = new THREE.Vector3(o.center.x + Math.sin(o.a) * o.radius, o.center.y + o.height, o.center.z + Math.cos(o.a) * o.radius);
      cam.position.lerp(p, Math.min(1, dt * 1.5));
      this.controls.target.lerp(o.center, Math.min(1, dt * 1.5));
      cam.lookAt(this.controls.target);
      return;
    }
    const d = this.follow;
    if (d) {
      const fwd = new THREE.Vector3(Math.sin(d.yaw), 0, Math.cos(d.yaw));
      const dp = new THREE.Vector3(d.x, d.y, d.z);
      if (this.followMode === 'CHASE') {
        // Translate camera + target with the drone; OrbitControls keeps user rotation/zoom.
        this.controls.enabled = true;
        const newT = this.controls.target.clone().lerp(dp.clone().addScaledVector(fwd, 18), Math.min(1, dt * 4));
        cam.position.add(newT.clone().sub(this.controls.target));
        this.controls.target.copy(newT);
        if (this.userIdleSec > 3) {
          const desired = dp.clone().addScaledVector(fwd, -38).add(new THREE.Vector3(0, 11, 0));
          cam.position.lerp(desired, Math.min(1, dt * 1.6));
        }
        cam.fov = 50;
        cam.updateProjectionMatrix();
        this.controls.update();
        const g = heightAt(cam.position.x, cam.position.z) + 6;
        if (cam.position.y < g) cam.position.y = g;
        return;
      } else if (this.followMode === 'MAP') {
        this.controls.enabled = false;
        const desired = new THREE.Vector3(d.x, d.y + 520, d.z + 1);
        cam.position.lerp(desired, Math.min(1, dt * 2));
        this.controls.target.lerp(dp, Math.min(1, dt * 3));
        cam.fov = 45;
      } else {
        // POV / THERMAL: gimbal camera under the nose, pitched down 25°.
        this.controls.enabled = false;
        const eye = dp.clone().addScaledVector(fwd, 3).add(new THREE.Vector3(0, -2, 0));
        cam.position.copy(eye);
        const look = eye.clone().addScaledVector(fwd, 100).add(new THREE.Vector3(0, -46, 0));
        this.controls.target.lerp(look, Math.min(1, dt * 6));
        cam.fov = 62;
      }
      cam.updateProjectionMatrix();
      cam.lookAt(this.controls.target);
      if (this.followMode === 'POV' || this.followMode === 'THERMAL') cam.rotateZ(-d.roll * 0.6);
      return;
    }
    this.controls.enabled = true;
    this.controls.update();
    // Never go underground.
    const g = heightAt(cam.position.x, cam.position.z) + 8;
    if (cam.position.y < g) cam.position.y = g;
  }
}
