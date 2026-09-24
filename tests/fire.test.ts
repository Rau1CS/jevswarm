import { describe, expect, it } from 'vitest';
import { FireModel, BURNING, UNBURNED } from '../src/sim/fire';
import { Rng } from '../src/core/math';

function headRun(seed: number) {
  const f = new FireModel(new Rng(seed));
  f.setWind({ fromDeg: 265, speed: 6 }, true);
  f.ignite(-760, -80, 25);
  const target = f.cellOf(-400, -80); // 360 m downwind through forest
  const predicted = f.predictArrival(2000)[target];
  let reached = -1;
  for (let t = 0; t < 500; t += 0.2) {
    f.update(0.2);
    if (f.state[target] !== UNBURNED) {
      reached = t;
      break;
    }
  }
  return { predicted, reached };
}

describe('FireModel', () => {
  it('spreads downwind reliably across seeds (no percolation die-out)', () => {
    for (let seed = 1; seed <= 4; seed++) expect(headRun(seed).reached).toBeGreaterThan(0);
  });

  it('arrival predictor is within ~45% of the simulated head-fire arrival', () => {
    const runs = [1, 2, 3, 4].map(headRun);
    const mean = runs.reduce((s, r) => s + r.reached, 0) / runs.length;
    const pred = runs[0].predicted;
    expect(Math.abs(pred - mean) / mean).toBeLessThan(0.45);
  });

  it('suppression reduces intensity and wets fuel', () => {
    const f = new FireModel(new Rng(3));
    f.ignite(-700, -200, 40);
    for (let i = 0; i < 100; i++) f.update(0.2);
    const k = f.burning[0];
    const c = f.cellCenter(k % f.n, (k / f.n) | 0);
    const red = f.suppress(c.x, c.z, 40, 0.95);
    expect(red).toBeGreaterThan(0.2);
    expect(f.wet[k]).toBeGreaterThan(0.3);
  });

  it('downwind cells are predicted to burn before upwind cells', () => {
    const f = new FireModel(new Rng(5));
    f.setWind({ fromDeg: 270, speed: 7 }, true); // blowing toward +x (east)
    f.ignite(-600, -300, 25);
    const a = f.predictArrival(3000);
    expect(a[f.cellOf(-450, -300)]).toBeLessThan(a[f.cellOf(-750, -300)]);
    expect(f.state[f.cellOf(-600, -300)]).toBe(BURNING);
  });
});
