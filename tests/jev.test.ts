import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { demoScenario } from '../src/app/scenarios';
import { buildObjectives } from '../src/jev/objectives';
import { buildJevRequest, fallbackJudge, URGENCY_LEVELS } from '../src/jev/judge';
import { allocate } from '../src/jev/allocator';
import { parseFallback } from '../src/jev/commands';

function warmSim(seconds = 90) {
  const sim = new Simulation(demoScenario(24));
  sim.launchAll(1, 0.3);
  for (let i = 0; i < seconds * 30; i++) sim.step(1 / 30);
  return sim;
}

describe('Jev request (docs.typesafe.ai/api)', () => {
  it('builds a valid single fan-out request: one Choice + one Score per objective', () => {
    const sim = warmSim();
    const view = sim.view();
    view.arrival = sim.fire.predictArrival();
    const objs = buildObjectives(view);
    const { state, questions, top } = buildJevRequest(objs, { t: sim.t, fire: sim.fire, drones: sim.drones, directive: null, windNote: 'steady' });
    expect(Object.keys(questions).length).toBeLessThanOrEqual(64);
    const pri = questions.priority as { type: string; criteria: Record<string, string> };
    expect(pri.type).toBe('choice');
    expect(Object.keys(pri.criteria).length).toBe(top.length);
    expect(Object.keys(pri.criteria).length).toBeLessThanOrEqual(255);
    for (const o of top) {
      const q = questions[`urgency.${o.id}`] as { type: string; criteria: string[]; instructions: string };
      expect(q.type).toBe('score');
      expect(q.criteria).toEqual(URGENCY_LEVELS);
      expect(q.criteria.length).toBeLessThanOrEqual(10);
      expect(q.instructions).toContain('`objectives[');
    }
    // State must never leak hidden ground truth (civilian ids/positions of unconfirmed people).
    expect(JSON.stringify(state)).not.toMatch(/"truthCivId"|"P\d\d"/);
  });
});

describe('Allocator', () => {
  it('fills the most urgent objectives first and respects the commander reserve', () => {
    const sim = warmSim();
    const view = sim.view();
    view.arrival = sim.fire.predictArrival();
    const objs = buildObjectives(view);
    const j = fallbackJudge(objs, { t: sim.t, fire: sim.fire, drones: sim.drones, directive: null, windNote: '' });
    const res = allocate(objs, j, sim.drones, { text: 'keep five in reserve', intent: 'RESERVE', area: 'NONE', count: 5, confidence: 1, source: 'SIM' });
    expect(res.reserve.length).toBe(5);
    const used = new Set(res.allocs.map((a) => a.drone));
    expect(used.size).toBe(res.allocs.length); // one task per drone
    for (const r of res.reserve) expect(used.has(r)).toBe(false);
  });

  it('never assigns thermal tasks to a drone whose thermal camera failed', () => {
    const sim = warmSim();
    sim.drones.forEach((d) => (d.thermalOK = d.role !== 'SCOUT'));
    const view = sim.view();
    view.arrival = sim.fire.predictArrival();
    const objs = buildObjectives(view);
    const j = fallbackJudge(objs, { t: sim.t, fire: sim.fire, drones: sim.drones, directive: null, windNote: '' });
    const res = allocate(objs, j, sim.drones, null);
    for (const a of res.allocs) {
      if (['SEARCH', 'VERIFY', 'CORRIDOR', 'MONITOR'].includes(a.slot.task)) expect(a.drone.thermalOK).toBe(true);
    }
  });
});

describe('Commander command fallback parser', () => {
  it.each([
    ['Prioritize the village.', 'PRIORITIZE_AREA', 'VILLAGE'],
    ['Search the northern forest.', 'SEARCH_AREA', 'NORTH_FOREST'],
    ['Protect the evacuation road.', 'PROTECT_ROAD', 'EVAC_ROAD'],
    ['Focus suppression near civilians.', 'FOCUS_SUPPRESSION_CIVILIANS', 'NONE'],
  ])('%s', (text, intent, area) => {
    const d = parseFallback(text);
    expect(d.intent).toBe(intent);
    expect(d.area).toBe(area);
  });
  it('reads counts from words', () => {
    const d = parseFallback('Keep five drones in reserve.');
    expect(d.intent).toBe('RESERVE');
    expect(d.count).toBe(5);
  });
});
