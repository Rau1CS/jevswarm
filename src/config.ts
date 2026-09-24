/**
 * Global simulation constants. Values marked SIM are simulation assumptions, not
 * hardware specifications — see docs/SIMULATION.md.
 */
export const WORLD_SIZE = 2000; // metres, world spans [-1000, 1000] on X and Z
export const HALF = WORLD_SIZE / 2;

/** Fire cellular grid resolution (cells per side). 2000 m / 128 ≈ 15.6 m cells. */
export const FIRE_N = 128;
export const FIRE_CELL = WORLD_SIZE / FIRE_N;

/** Search coverage grid resolution. */
export const COVER_N = 64;
export const COVER_CELL = WORLD_SIZE / COVER_N;

/** Sector grid: rows A..H north→south, columns 1..8 west→east (250 m sectors). */
export const SECTOR_N = 8;
export const SECTOR_SIZE = WORLD_SIZE / SECTOR_N;
export const SECTOR_ROWS = 'ABCDEFGH';

/** Visual exaggeration so 0.6 m aircraft remain legible on a 2 km map. */
export const DRONE_VISUAL_SCALE = 5;
export const CIV_VISUAL_SCALE = 3.5;

/** SIM: flight envelope (see TECH / REAL-WORLD DESIGN). */
export const DRONE = {
  maxSpeed: 17, // m/s  SIM
  maxAccel: 5, // m/s²  SIM
  maxClimb: 5, // m/s   SIM
  cruiseAGL: 80, // m
  searchAGL: 85,
  verifyAGL: 38,
  suppressAGL: 22,
  relayAGL: 120,
  enduranceMin: 18, // SIM: public X500 V2 hover figure (~18 min, no payload); drains faster under load
  suppressantLitres: 120, // SIM "equivalent" payload per sortie
  batterySwapSec: 18, // SIM hot-swap time at command post
  thermalFovDeg: 50,
};

export const BASE_POS = { x: -640, z: 660 };
export const SAFE_ZONE = { x: 690, z: 640, r: 90 };
export const LAKE = { x: -520, z: 180, r: 120 };

export const SIM_STEP = 1 / 30; // fixed simulation timestep (sim seconds)
