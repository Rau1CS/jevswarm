import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { Director, type DirectorHost } from '../src/demo/director';
import { demoScenario } from '../src/app/scenarios';

describe('Cinematic demo (headless, fallback coordinator)', () => {
  it('plays the hero storyline end to end', { timeout: 120000 }, () => {
    const sim = new Simulation(demoScenario(24));
    sim.timeScale = 2;
    const titles: string[] = [];
    const callouts: string[][] = [];
    sim.on({
      log: (e) => titles.push(e.title), banner: (t) => titles.push(t), priority: (_t, l) => callouts.push(l),
      fx: () => {}, replan: () => {},
    });
    const rig = new Proxy({}, { get: () => () => {} }) as unknown as DirectorHost['rig'];
    let finished = false;
    const dir = new Director({
      sim, rig, caption: () => {}, title: () => {}, hud: () => {}, endCard: () => {},
      finish: () => (finished = true), select: () => {}, callout: (_t, l) => callouts.push(l),
    });
    for (let i = 0; i < 166 * 60 && !finished; i++) {
      dir.update(1 / 60);
      sim.advance(1 / 60);
    }
    expect(finished).toBe(true);
    for (const t of ['THERMAL ANOMALY', 'WIND SHIFT DETECTED', 'SUPPRESSION DROP', 'HUMAN CONFIRMED', 'SAFE CORRIDOR IDENTIFIED']) expect(titles).toContain(t);
    // The priority-change callout lists a coordinated team (several drones, several roles).
    const team = callouts.find((l) => l[0] === 'CIVILIAN RISK: CRITICAL' && l.length >= 4);
    expect(team).toBeTruthy();
    const hero = sim.civilians.find((c) => c.hero)!;
    expect(hero.confirmed).toBe(true);
    expect(['GUIDED', 'SAFE']).toContain(hero.behavior);
  });
});
