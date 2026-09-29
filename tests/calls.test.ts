import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/math';
import { CallCenter, type CallHost } from '../src/calls/callCenter';
import { CallGenerator } from '../src/calls/generator';
import { PLACES } from '../src/calls/places';
import { buildCallRequest, fallbackTriage } from '../src/calls/triage';
import type { Civilian } from '../src/sim/civilians';

const civ = (id: string, x: number, z: number, behavior: Civilian['behavior'] = 'TRAPPED') =>
  ({ id, x, z, behavior } as unknown as Civilian);

function host() {
  const logs: { title: string; by: string }[] = [];
  const incidents: string[] = [];
  const h: CallHost = {
    t: () => 100,
    client: () => null, // no Jev: labelled fallback rules
    log: (title, _l, _lv, by) => logs.push({ title, by }),
    banner: () => {},
    createIncident: () => { incidents.push('x'); return `T${incidents.length}`; },
    replan: () => {},
    detectionOpen: () => true,
  };
  return { h, logs, incidents };
}

describe('Call triage request (Jev)', () => {
  it('asks everything in ONE request and only lets Jev select known places', () => {
    const { questions, state } = buildCallRequest('My dad is at the old mill and cannot walk', [{ id: 'INC1', placeName: 'the old mill', summary: '1 call(s)' }]);
    expect(Object.keys(questions).sort()).toEqual(['cannot_leave', 'duplicate', 'kind', 'place', 'response', 'urgency']);
    const place = questions.place as { type: string; criteria: Record<string, string> };
    expect(place.type).toBe('choice');
    expect(Object.keys(place.criteria)).toEqual([...PLACES.map((p) => p.id), 'UNKNOWN']);
    expect((questions.urgency as { criteria: string[] }).criteria).toHaveLength(5);
    expect(JSON.stringify(state)).not.toMatch(/civId|truth/);
  });
});

describe('Dispatch policy (code) over triage answers', () => {
  it('routes calls: rescue needs approval, info is auto-replied, repeats merge, vague goes to an operator', () => {
    const { h, logs, incidents } = host();
    const cc = new CallCenter(h);
    const gen = new CallGenerator(new Rng(3));
    const person = cc.receive(gen.personCall(10, civ('P01', -200, -95), true, 'WEST_LANE_END'));
    expect(person.status).toBe('AWAITING_APPROVAL'); // full rescue = 3 aircraft → human approval
    expect(incidents).toHaveLength(0);
    cc.approve(person.call.id);
    expect(person.status).toBe('DISPATCHED');
    expect(incidents).toHaveLength(1);
    expect(logs.find((l) => l.title === 'COMMANDER DECISION')?.by).toBe('HUMAN');

    const info = cc.receive(gen.infoCall(20));
    expect(info.status).toBe('AUTO_REPLY');

    const dup = cc.receive(gen.duplicateOf(30, person.call));
    expect(dup.status).toBe('MERGED');
    expect(cc.incidents[0].callIds).toHaveLength(2);
    expect(incidents).toHaveLength(1); // no second incident for a repeat call
  });

  it('never dispatches aircraft to an unknown place without a human', () => {
    const { h, incidents } = host();
    const cc = new CallCenter(h);
    const tr = fallbackTriage('Someone’s screaming in the woods, I don’t know, somewhere past the big bend… hello? can you hear me?', []);
    expect(tr.placeId).toBeNull();
    const rec = cc.receive({ id: 'C09', t: 1, caller: 'x', transcript: 'Someone’s screaming in the woods… hello? can you hear me?', truth: { kind: 'UNCLEAR', civId: null, placeId: null, cannotLeave: false, duplicateOfCall: null }, truePos: null });
    expect(rec.status).toBe('REVIEW');
    expect(incidents).toHaveLength(0);
    cc.approve('C09', 'VERIFY', 'OLD_MILL'); // operator listened back and set the place
    expect(rec.status).toBe('DISPATCHED');
    expect(incidents).toHaveLength(1);
  });
});

describe('Call generator', () => {
  it('produces every kind of call with hidden truth, never naming the truth in the transcript', () => {
    const gen = new CallGenerator(new Rng(9));
    const civs = [civ('P01', -200, -95), civ('P02', 360, 330, 'SHELTER'), civ('P03', -40, -520, 'WANDER')];
    const kinds = new Set<string>();
    for (let i = 0; i < 80; i++) {
      const c = gen.next(i * 30, civs, [{ x: 500, z: -150 }]);
      kinds.add(c.truth.kind);
      expect(c.transcript).not.toMatch(/P0\d|civId/);
    }
    expect([...kinds].sort()).toEqual(['FIRE_REPORT', 'INFO_REQUEST', 'NOT_EMERGENCY', 'PERSON_IN_DANGER', 'UNCLEAR']);
  });
});
