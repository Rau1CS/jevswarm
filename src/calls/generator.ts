/**
 * Emergency-call generator (SIM). Produces caller transcripts from hidden ground truth:
 * people in danger (some who cannot leave on their own), repeat calls about the same people,
 * fire sightings, information requests, non-emergencies and garbled/vague calls.
 * The truth travels with the call but is never shown to the triage (Jev or fallback).
 */
import { Rng } from '../core/math';
import type { Civilian } from '../sim/civilians';
import type { Pt } from '../world/layout';
import { nearestPlace, placeById, type Place } from './places';

export type CallKind = 'PERSON_IN_DANGER' | 'FIRE_REPORT' | 'INFO_REQUEST' | 'NOT_EMERGENCY' | 'UNCLEAR';

export interface CallTruth {
  kind: CallKind;
  civId: string | null;
  placeId: string | null;
  cannotLeave: boolean;
  duplicateOfCall: string | null;
}

export interface Call {
  id: string;
  t: number;
  caller: string;
  transcript: string;
  /** Hidden ground truth (for scoring/visualisation only). */
  truth: CallTruth;
  /** Where the caller actually is (hidden). */
  truePos: Pt | null;
}

const REL = [['grandmother', 'she', 'her'], ['dad', 'he', 'him'], ['uncle', 'he', 'him'], ['mum', 'she', 'her'], ['neighbour', 'she', 'her']];
const CANNOT = ['can’t walk far', 'is in a wheelchair', 'doesn’t drive and has no car', 'just had hip surgery', 'is on oxygen'];

function personText(rng: Rng, place: Place, cannotLeave: boolean): { text: string; caller: string } {
  const [rel, he, him] = rng.pick(REL);
  const cap = he[0].toUpperCase() + he.slice(1);
  const pl = place.name;
  const opts = cannotLeave
    ? [
        `Hi, yes — I’m calling about my ${rel}, ${he} lives at ${pl}. ${cap} ${rng.pick(CANNOT)} and the smoke is getting really thick there. I can’t reach ${him} on the phone. Please send someone.`,
        `My ${rel} is still in the house near ${pl}. ${cap} ${rng.pick(CANNOT)}, there’s no way ${he} gets out alone. The fire’s coming down the hill.`,
        `(coughing) We’re in the house by ${pl}, we tried to leave but a tree came down across the lane. I’ve got two little kids here and my mother ${rng.pick(CANNOT)}.`,
      ]
    : [
        `We’re at ${pl} and there’s smoke everywhere, I can see flames behind the trees. Which way do we go? We have a car but I don’t know if the road is open.`,
        `I’m out walking near ${pl}, I think I’m cut off — there’s fire below me. I can move, I just don’t know which way is safe.`,
        `Hello? There’s three of us at ${pl}, the fire is really close now. We can drive but the smoke’s so thick. Should we go or stay?`,
      ];
  const i = Math.floor(rng.next() * opts.length);
  // Templates about someone else name the relationship; first-person ones are the person on scene.
  const aboutOther = cannotLeave && i < 2;
  return { text: opts[i], caller: aboutOther ? (rel === 'neighbour' ? 'neighbour' : `relative (${rel})`) : 'caller on scene' };
}

const DUP = [
  (pl: string) => `I’m calling again — well, my sister called already — about the house at ${pl}. Is anyone going? They’re still in there.`,
  (pl: string) => `I just drove past ${pl} and there’s someone waving from the window. Looked like they’re stuck. Somebody should check.`,
  (pl: string) => `Has anyone got to the people at ${pl} yet? We reported it a few minutes ago and the smoke is worse now.`,
];
const FIRE = [
  (pl: string) => `There’s a new column of smoke near ${pl}, it looks like it just started. It wasn’t there ten minutes ago.`,
  (pl: string) => `Embers are landing in the field by ${pl}, there are little fires popping up everywhere.`,
  (pl: string) => `I can see flames jumping over the road near ${pl}. Nobody’s hurt, I just thought you should know.`,
];
const INFO = [
  'Is the Main Road still open to drive out towards the highway? I need to pick up my son.',
  'Where’s the evacuation centre? Can I bring my two dogs with me?',
  'Is the air safe for kids to be outside in town today? It smells really smoky.',
  'Are they going to close the school tomorrow because of the fire?',
];
const NOISE = [
  'Wow, you can see the whole fire from up here, it’s incredible. Is it going to be on the news tonight?',
  'I just want to say thank you to all the firefighters and the drone people, you’re amazing.',
  'Is the farmers’ market on Saturday still happening?',
  'Sorry, wrong number, I was trying to call the pizza place.',
];
const VAGUE = [
  'Please— please help, there’s smoke everywhere, I can’t see anything, we were driving and… I don’t know where we are… [line breaks up]',
  'Someone’s screaming in the woods, I don’t know, somewhere past the big bend… hello? can you hear me?',
  'There’s a fire, there’s a fire, we need… [inaudible] … my husband went back for the horses…',
];

export class CallGenerator {
  private n = 0;
  private called = new Set<string>();
  private personCalls: Call[] = [];

  constructor(private rng: Rng) {}

  private make(t: number, text: string, caller: string, truth: CallTruth, truePos: Pt | null): Call {
    const call: Call = { id: `C${String(++this.n).padStart(2, '0')}`, t, caller, transcript: text, truth, truePos };
    if (truth.kind === 'PERSON_IN_DANGER' && !truth.duplicateOfCall) this.personCalls.push(call);
    return call;
  }

  /** A call about a specific civilian (used by the demo director for the hero). */
  personCall(t: number, civ: Civilian, cannotLeave: boolean, placeId?: string): Call {
    const place = (placeId && placeById(placeId)) || nearestPlace(civ).place;
    const { text, caller } = personText(this.rng, place, cannotLeave);
    this.called.add(civ.id);
    return this.make(t, text, caller, { kind: 'PERSON_IN_DANGER', civId: civ.id, placeId: place.id, cannotLeave, duplicateOfCall: null }, { x: civ.x, z: civ.z });
  }

  duplicateOf(t: number, orig: Call): Call {
    const place = placeById(orig.truth.placeId ?? '')!;
    return this.make(t, this.rng.pick(DUP)(place.name), 'bystander', { ...orig.truth, duplicateOfCall: orig.id }, orig.truePos);
  }

  infoCall(t: number): Call {
    return this.make(t, this.rng.pick(INFO), 'resident', { kind: 'INFO_REQUEST', civId: null, placeId: null, cannotLeave: false, duplicateOfCall: null }, null);
  }

  /** Next random call given the current world (free simulation). */
  next(t: number, civs: Civilian[], fireFront: Pt[]): Call {
    const open = civs.filter((c) => c.behavior !== 'SAFE' && !this.called.has(c.id) && nearestPlace(c).d < 260);
    const dupable = this.personCalls.filter((c) => t - c.t < 240);
    const r = this.rng.next();
    if (r < 0.38 && open.length) {
      const civ = this.rng.pick(open);
      const cannot = civ.behavior === 'TRAPPED' || civ.behavior === 'SHELTER' ? this.rng.chance(0.7) : this.rng.chance(0.15);
      return this.personCall(t, civ, cannot);
    }
    if (r < 0.52 && dupable.length) return this.duplicateOf(t, this.rng.pick(dupable));
    const visible = fireFront.filter((f) => nearestPlace(f).d < 380); // callers name a nearby landmark
    if (r < 0.66 && visible.length) {
      const f = this.rng.pick(visible);
      const { place } = nearestPlace(f);
      return this.make(t, this.rng.pick(FIRE)(place.name), 'resident', { kind: 'FIRE_REPORT', civId: null, placeId: place.id, cannotLeave: false, duplicateOfCall: null }, f);
    }
    if (r < 0.8) return this.infoCall(t);
    if (r < 0.9) return this.make(t, this.rng.pick(NOISE), 'member of the public', { kind: 'NOT_EMERGENCY', civId: null, placeId: null, cannotLeave: false, duplicateOfCall: null }, null);
    // Garbled call: sometimes a real person we can't place.
    const lost = civs.find((c) => c.behavior === 'WANDER' && !this.called.has(c.id));
    if (lost) this.called.add(lost.id);
    return this.make(t, this.rng.pick(VAGUE), 'unknown caller', { kind: 'UNCLEAR', civId: lost?.id ?? null, placeId: null, cannotLeave: false, duplicateOfCall: null }, lost ? { x: lost.x, z: lost.z } : null);
  }

}
