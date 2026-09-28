import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/math';
import { BURNING, FireModel, UNBURNED } from '../src/sim/fire';
import { AGENTS, PLATFORMS, capacity, landingFraction, loadout } from '../src/sim/loadout/catalogue';
import { applyAgent, CELL_AREA, hottestCell } from '../src/sim/suppression';
import { Logistics } from '../src/sim/logistics';
import { Simulation } from '../src/sim/simulation';
import { setupScenario } from '../src/app/scenarios';

function burningFire(seed = 3) {
  const f = new FireModel(new Rng(seed));
  f.setWind({ fromDeg: 265, speed: 3 }, true);
  f.ignite(-700, -200, 40);
  for (let i = 0; i < 60; i++) f.update(0.2);
  return f;
}

describe('Catalogue', () => {
  it('capacity is payload minus dispenser hardware, divided by density', () => {
    expect(capacity(loadout('X500', 'WATER'))).toBeCloseTo((1.5 - 0.45) / 1.0, 5);
    expect(capacity(loadout('HEAVY', 'WATER'))).toBeCloseTo(20, 5);
    // Denser retardant mixture → fewer litres from the same payload.
    expect(capacity(loadout('HEAVY', 'LTR'))).toBeLessThan(capacity(loadout('HEAVY', 'WATER')));
  });

  it('every parameter carries a provenance tag, and PUBLIC values cite a source or physical constant', () => {
    for (const pf of Object.values(PLATFORMS)) {
      for (const [k, v] of Object.entries(pf)) {
        if (v && typeof v === 'object' && 'tag' in v) {
          expect(['PUBLIC', 'SIM', 'CONCEPT', 'ASSUMPTION'], k).toContain(v.tag);
          if (v.tag === 'PUBLIC') expect(v.src, `${pf.id}.${k}`).toBeTruthy();
        }
      }
    }
    for (const a of Object.values(AGENTS)) expect(a.cost.tag).toBe('ASSUMPTION');
  });

  it('wind reduces the landing fraction; cohesive gel drifts less than water', () => {
    const w = loadout('HEAVY', 'WATER'), g = loadout('HEAVY', 'GEL');
    expect(landingFraction(w, 8)).toBeLessThan(landingFraction(w, 2));
    expect(landingFraction(g, 8)).toBeGreaterThan(landingFraction(w, 8));
    expect(landingFraction(w, 0)).toBeLessThanOrEqual(0.95);
  });
});

describe('Physical application', () => {
  it('separates released, on-target and effective agent', () => {
    const f = burningFire();
    const k = f.burning[0];
    const c = f.cellCenter(k % f.n, (k / f.n) | 0);
    const a = applyAgent(f, loadout('HEAVY', 'WATER'), c.x, c.z, 20);
    expect(a.released).toBe(20);
    expect(a.onTarget).toBeLessThan(a.released);
    expect(a.effective).toBeLessThanOrEqual(a.onTarget);
    expect(a.effective).toBeGreaterThan(0);
  });

  it('a single 20 L drop cannot knock down a 244 m² flaming cell; concentrated drops can', () => {
    const f = burningFire();
    const lo = loadout('HEAVY', 'WATER');
    const k = hottestCell(f, -700, -200, 60);
    expect(k).toBeGreaterThanOrEqual(0);
    const c = f.cellCenter(k % f.n, (k / f.n) | 0);
    expect(applyAgent(f, lo, c.x, c.z, 20).knocked).toBe(false);
    // Thermal targeting spreads repeated drops over the hottest nearby cells; keep dropping until this one is out.
    for (let i = 0; i < 200 && f.state[k] === BURNING; i++) applyAgent(f, lo, c.x, c.z, 20);
    expect(f.state[k]).toBe(UNBURNED);
    expect(f.knockdowns).toBeGreaterThan(0);
    expect(CELL_AREA).toBeGreaterThan(200);
  });

  it('foam expansion is not a multiplier: foam needs the same order of liquid as water', () => {
    const drops = (agent: 'WATER' | 'FOAM_A') => {
      const f = burningFire(4);
      const k = hottestCell(f, -700, -200, 60);
      const c = f.cellCenter(k % f.n, (k / f.n) | 0);
      let n = 0;
      while (f.state[k] === BURNING && n < 300) { applyAgent(f, loadout('HEAVY', agent), c.x, c.z, 20); n++; }
      return n;
    };
    const w = drops('WATER'), fo = drops('FOAM_A');
    expect(fo).toBeLessThanOrEqual(w);
    expect(fo).toBeGreaterThan(w / 2); // no "5× effectiveness" shortcut
  });

  it('retardant slows spread with dose but never makes fuel nonflammable', () => {
    const f = new FireModel(new Rng(1));
    const k = f.cellOf(0, 0);
    expect(f.retEff(k)).toBe(0);
    f.salts[k] = 0.8;
    const half = f.retEff(k);
    f.salts[k] = 50;
    expect(half).toBeGreaterThan(0.3);
    expect(f.retEff(k)).toBeGreaterThan(half);
    expect(f.retEff(k)).toBeLessThan(0.86);
  });

  it('dry chemical knocks down flame but leaves heat that can rekindle; water cools it out', () => {
    const run = (agent: 'WATER' | 'DRY_CHEM') => {
      const f = burningFire(5);
      const k = hottestCell(f, -700, -200, 60);
      const c = f.cellCenter(k % f.n, (k / f.n) | 0);
      for (let i = 0; i < 300 && f.state[k] === BURNING; i++) applyAgent(f, loadout('HEAVY', agent), c.x, c.z, 20);
      expect(f.state[k]).toBe(UNBURNED);
      return { heat: f.heat[k], wet: f.cover[k] * f.coverWater[k] };
    };
    const w = run('WATER'), d = run('DRY_CHEM');
    expect(d.heat).toBeGreaterThan(w.heat);
    expect(d.wet).toBeLessThan(0.05);
    expect(w.wet).toBeGreaterThan(0.5);
  });
});

describe('Logistics', () => {
  it('refill slots are finite and served first-come first-served', () => {
    const lg = new Logistics({ x: 0, z: 0 });
    const fwd = lg.get('FWD')!;
    expect(fwd.slots).toBe(2);
    expect(lg.request('FWD', 'A')).toBe(true);
    expect(lg.request('FWD', 'B')).toBe(true);
    expect(lg.request('FWD', 'C')).toBe(false);
    expect(lg.request('FWD', 'D')).toBe(false);
    lg.release('A');
    expect(lg.request('FWD', 'D')).toBe(false); // C was first in the queue
    expect(lg.request('FWD', 'C')).toBe(true);
  });

  it('mixed agents never refill at the lake', () => {
    const lg = new Logistics(null);
    const lake = lg.get('LAKE')!;
    expect(lg.pick(loadout('HEAVY', 'FOAM_A'), { x: lake.x, z: lake.z }, 14, 15).id).not.toBe('LAKE');
    expect(lg.pick(loadout('HEAVY', 'WATER'), { x: lake.x, z: lake.z }, 14, 15).id).toBe('LAKE');
  });
});

describe('Policies (headless)', () => {
  const run = (policy: 'NONE' | 'NEAREST' | 'COORDINATOR') => {
    const sim = new Simulation(setupScenario(24, { platform: 'HEAVY', agent: 'WATER', scenario: 'INITIAL_ATTACK', forward: true, policy }, 21));
    sim.launchAll(sim.t + 2, 0.3);
    for (let i = 0; i < 200 * 30; i++) sim.step(1 / 30);
    return sim;
  };
  it('NONE never releases agent; NEAREST and COORDINATOR deliver and log the ledger', { timeout: 120000 }, () => {
    expect(run('NONE').ledger.released).toBe(0);
    for (const p of ['NEAREST', 'COORDINATOR'] as const) {
      const s = run(p);
      expect(s.ledger.sorties, p).toBeGreaterThan(3);
      expect(s.ledger.onTarget, p).toBeGreaterThan(0);
      expect(s.results().suppression.capacityPerSortie).toBeCloseTo(20, 5);
    }
  });
});

describe('Common random numbers (paired comparisons)', () => {
  it('two policies on the same seed face an identical fire until the first drop', { timeout: 120000 }, () => {
    const mk = (policy: 'NONE' | 'NEAREST') => {
      const sim = new Simulation(setupScenario(24, { platform: 'HEAVY', agent: 'WATER', scenario: 'INITIAL_ATTACK', forward: true, policy }, 31));
      sim.launchAll(sim.t + 2, 0.3);
      return sim;
    };
    const a = mk('NONE'), b = mk('NEAREST');
    while (b.ledger.sorties === 0 && b.t < 400) {
      a.step(1 / 30);
      b.step(1 / 30);
      if (b.ledger.sorties === 0) expect(Array.from(a.fire.state)).toEqual(Array.from(b.fire.state));
    }
    expect(b.ledger.sorties).toBeGreaterThan(0);
  });
});
