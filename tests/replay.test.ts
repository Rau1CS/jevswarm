import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { Director, type DirectorHost } from '../src/demo/director';
import { demoScenario } from '../src/app/scenarios';
import { ReplayClient, fingerprint, type DemoSession } from '../src/jev/session';

describe('Recorded Jev session', () => {
  it('replays the committed recording exactly (no network, no fallback rules)', { timeout: 120000 }, async () => {
    const session = JSON.parse(readFileSync('public/recordings/demo-session.json', 'utf8')) as DemoSession;
    const sim = new Simulation(demoScenario(session.drones));
    sim.timeScale = 2;
    const client = new ReplayClient(session);
    sim.coordinator.client = client;
    sim.coordinator.allowFallback = false;
    sim.calls.allowFallback = false;
    sim.gate = (n) => client.gate(n);
    await sim.coordinator.init();
    expect(sim.coordinator.mode).toBe('JEV');
    const rig = new Proxy({}, { get: () => () => {} }) as unknown as DirectorHost['rig'];
    let finished = false;
    new Director({ sim, rig, caption: () => {}, title: () => {}, hud: () => {}, endCard: () => {}, finish: () => (finished = true, sim.paused = true), select: () => {}, callout: () => {} });
    // Frame sizes differ from the recording on purpose: answers are released by step, not by frame.
    for (let i = 0; i < 40000 && !finished; i++) {
      sim.advance(i % 3 === 0 ? 1 / 30 : 1 / 90);
      await new Promise((r) => setImmediate(r));
    }
    expect(finished).toBe(true);
    expect(client.diverged).toBe(0);
    expect(client.calls).toBe(session.entries.length);
    expect(fingerprint(sim)).toBe(session.finalFingerprint);
    expect(sim.calls.records.map((r) => r.status).sort()).toEqual(['AUTO_REPLY', 'DISPATCHED', 'MERGED']);
  });
});
