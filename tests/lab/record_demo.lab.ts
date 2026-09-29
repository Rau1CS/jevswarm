/**
 * Records the cinematic demo driven by REAL Jev (key from .env.local), in real time, and writes
 * public/recordings/demo-session.json. Run: npx vitest run --config vitest.lab.config.ts tests/lab/record_demo.lab.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { Simulation } from '../../src/sim/simulation';
import { Director, type DirectorHost } from '../../src/demo/director';
import { demoScenario } from '../../src/app/scenarios';
import { RecordingClient, fingerprint, type DemoSession } from '../../src/jev/session';
import type { JevResponse } from '../../src/jev/judge';

const key = readFileSync('.env.local', 'utf8').split(/\r?\n/).find((l) => l.startsWith('TYPESAFE_API_KEY='))!.split('=')[1].trim().replace(/^"|"$/g, '');
const ask = async (state: unknown, questions: Record<string, unknown>): Promise<JevResponse> => {
  const r = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions }) });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as JevResponse;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('record demo session with live Jev', { timeout: 600000 }, async () => {
  const sim = new Simulation(demoScenario(24));
  sim.timeScale = 2;
  const rec = new RecordingClient(ask, () => sim.stepCount);
  sim.coordinator.client = rec;
  sim.coordinator.allowFallback = false;
  sim.calls.allowFallback = false;
  await sim.coordinator.init();
  const rig = new Proxy({}, { get: () => () => {} }) as unknown as DirectorHost['rig'];
  let finished = false;
  new Director({ sim, rig, caption: () => {}, title: () => {}, hud: () => {}, endCard: () => {}, finish: () => (finished = true, sim.paused = true), select: () => {}, callout: () => {} });
  let last = performance.now();
  while (!finished) {
    await sleep(8);
    const now = performance.now();
    sim.advance((now - last) / 1000);
    last = now;
  }
  const session: DemoSession = {
    version: 1, kind: 'demo', recordedAt: new Date().toISOString(), model: rec.sorted()[0]?.response.model ?? 'jev',
    seed: sim.opts.seed, drones: sim.drones.length, entries: rec.sorted(), finalFingerprint: fingerprint(sim), inputTokens: rec.inputTokens,
  };
  writeFileSync('public/recordings/demo-session.json', JSON.stringify(session));
  console.log(`recorded ${session.entries.length} Jev answers · ${session.inputTokens} tokens · steps ${sim.stepCount} · calls ${sim.calls.records.map((r) => `${r.call.id}:${r.status}`).join(' ')}`);
});
