/** Ground emergency vehicles moving along the road network (ambient, road-block aware). */
import { ROADS, pointAlong, polyLength, type Pt } from '../world/layout';
import type { FireModel } from './fire';

export type VehicleKind = 'ENGINE' | 'AMBULANCE' | 'COMMAND';

export interface Vehicle {
  id: string;
  kind: VehicleKind;
  pts: Pt[];
  length: number;
  s: number;
  dir: 1 | -1;
  speed: number;
  x: number; z: number; ang: number;
  stopAt: number; // distance along path where it holds position
  blocked: boolean;
}

export function spawnVehicles(): Vehicle[] {
  const r1 = ROADS.find((r) => r.id === 'R1')!.pts;
  const r2 = ROADS.find((r) => r.id === 'R2')!.pts;
  const mk = (id: string, kind: VehicleKind, pts: Pt[], s: number, stopFrac: number, speed: number): Vehicle => {
    const length = polyLength(pts);
    const p = pointAlong(pts, s);
    return { id, kind, pts, length, s, dir: 1, speed, x: p.x, z: p.z, ang: p.ang, stopAt: length * stopFrac, blocked: false };
  };
  return [
    mk('E1', 'ENGINE', r1, 30, 0.44, 9),
    mk('E2', 'ENGINE', r1, 5, 0.4, 9),
    mk('A1', 'AMBULANCE', [...r2].reverse(), 20, 0.55, 8),
    mk('C1', 'COMMAND', r1, 0, 0.02, 0),
  ];
}

export function updateVehicle(v: Vehicle, dt: number, fire: FireModel, roadBlocks: Pt[]): void {
  const ahead = pointAlong(v.pts, v.s + v.dir * 40);
  v.blocked = fire.intensityAt(ahead.x, ahead.z) > 0.1 || roadBlocks.some((b) => Math.hypot(b.x - ahead.x, b.z - ahead.z) < 45);
  if (v.blocked) {
    // Turn back toward the command post / safe zone side.
    if (v.dir === 1) {
      v.dir = -1;
      v.stopAt = 0;
    }
  }
  const target = v.dir === 1 ? v.stopAt : 0;
  const d = target - v.s;
  if (Math.abs(d) > 1) v.s += Math.sign(d) * Math.min(Math.abs(d), v.speed * dt * (Math.abs(d) < 40 ? 0.5 : 1));
  const p = pointAlong(v.pts, v.s);
  v.x = p.x;
  v.z = p.z;
  v.ang = p.ang + (Math.sign(d) < 0 ? Math.PI : 0);
}
