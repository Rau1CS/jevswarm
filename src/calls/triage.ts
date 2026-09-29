/**
 * Call triage. ONE Jev request per call (speculative fan-out) answers everything the
 * dispatcher needs; code turns the answers into actions under an explicit policy:
 *   kind        Choice  — person in danger / fire report / info request / not an emergency / unclear
 *   urgency     Score   — life risk, 5 levels
 *   place       Choice  — select from the local gazetteer (or UNKNOWN); code never lets Jev invent places
 *   duplicate   Choice  — one of the open incidents, or NEW
 *   cannotLeave Noul    — is anyone unable to get out on their own?
 *   response    Choice  — one of the fixed response packages code knows how to execute
 * The fallback produces the same shape from transparent keyword rules (clearly labelled).
 */
import type { JevClient } from '../jev/judge';
import type { CallKind } from './generator';
import { PLACES, candidatePlaces } from './places';

export type ResponseId = 'VERIFY' | 'VERIFY_ROUTE' | 'FULL_RESCUE' | 'CHECK_FIRE' | 'REPLY' | 'HUMAN';

export const RESPONSES: Record<ResponseId, { label: string; units: number; desc: string }> = {
  VERIFY: { label: '1 scout · verify', units: 1, desc: 'Send one scout drone to find and confirm the people reported, before committing more aircraft.' },
  VERIFY_ROUTE: { label: 'Scout + evacuation route', units: 2, desc: 'A scout to confirm the people plus a scout to find a safe evacuation route for them; they can move on their own.' },
  FULL_RESCUE: { label: 'Full rescue: scouts + route + supply drop', units: 3, desc: 'Scout to confirm, evacuation route and a supply drop (water, masks, radio) for people who cannot get out on their own.' },
  CHECK_FIRE: { label: '1 drone · check reported fire', units: 1, desc: 'Send a drone to check and map a reported new fire or spot fire; no people reported in danger.' },
  REPLY: { label: 'No aircraft · reply to caller', units: 0, desc: 'No aircraft: answer the caller with information or advice (information requests and non-emergencies).' },
  HUMAN: { label: 'Operator must listen back', units: 0, desc: 'The call is too unclear to act on: a human operator must listen back before any action.' },
};

export const KINDS: Record<CallKind, string> = {
  PERSON_IN_DANGER: 'Someone is (or may be) in danger from the fire and needs help or guidance',
  FIRE_REPORT: 'A report of a new fire, flames, embers or smoke, with nobody said to be in danger',
  INFO_REQUEST: 'A question asking for information: roads, shelters, air quality, closures',
  NOT_EMERGENCY: 'Not an emergency: thanks, curiosity, wrong numbers, unrelated questions',
  UNCLEAR: 'Too garbled or vague to tell what is happening or where',
};

export const URGENCY = [
  'No one is in danger: information or a non-emergency.',
  'Possible danger later; nobody reported in immediate danger.',
  'People near the fire who can probably get themselves out.',
  'People in danger who may not get out without help, or whose way out is blocked.',
  'Life-threatening now: people trapped or unable to move, with fire or heavy smoke at their location.',
];

export interface OpenIncident { id: string; placeName: string; summary: string }

export interface CallTriage {
  source: 'JEV' | 'SIM';
  kind: CallKind; kindProb: number;
  urgency: number; urgencyConf: number;
  placeId: string | null; placeProb: number;
  duplicateOf: string | null; dupProb: number;
  cannotLeave: number;
  response: ResponseId; responseProb: number;
  latencyMs: number; tokens: number;
}

type Ans = { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number; score?: number };

export function buildCallRequest(transcript: string, incidents: OpenIncident[]) {
  const state = {
    transcript,
    local_places: PLACES.map((p) => p.name),
    open_incidents: incidents.map((i) => ({ id: i.id, place: i.placeName, summary: i.summary })),
  };
  const places: Record<string, string> = Object.fromEntries(PLACES.map((p) => [p.id, `${p.name} (also: ${p.aliases.join(', ')})`]));
  places.UNKNOWN = 'The caller gives no identifiable location, or it cannot be matched to any of these places';
  const questions: Record<string, unknown> = {
    kind: { type: 'choice', instructions: 'What kind of emergency call is `transcript`?', criteria: KINDS },
    urgency: { type: 'score', instructions: 'How urgent is `transcript` for life safety right now?', criteria: URGENCY },
    place: { type: 'choice', instructions: 'Which local place is the caller (or the people they are calling about) at, according to `transcript`?', criteria: places },
    cannot_leave: { type: 'noul', instructions: 'According to `transcript`, is at least one person unable to get out on their own (cannot walk far, no vehicle, trapped, blocked in, medical condition, or caring for small children)?' },
    response: { type: 'choice', instructions: 'Which response package should the drone dispatch centre choose for `transcript`?', criteria: Object.fromEntries(Object.entries(RESPONSES).map(([k, v]) => [k, v.desc])) },
  };
  if (incidents.length) {
    questions.duplicate = {
      type: 'choice',
      instructions: 'Is `transcript` about the same people and place as one of `open_incidents` (a repeat or follow-up call), or a new incident?',
      criteria: { NEW: 'A new incident, not already reported', ...Object.fromEntries(incidents.map((i) => [i.id, `${i.placeName}: ${i.summary}`])) },
    };
  }
  return { state, questions };
}

export async function jevTriage(client: JevClient, transcript: string, incidents: OpenIncident[]): Promise<CallTriage> {
  const t0 = performance.now();
  const { state, questions } = buildCallRequest(transcript, incidents);
  const r = await client.ask(state, questions);
  const a = r.answers as Record<string, Ans>;
  const top = (x?: Ans) => x?.probabilities?.[x.choice ?? ''] ?? x?.confidence ?? 0;
  const place = a.place?.choice && a.place.choice !== 'UNKNOWN' ? a.place.choice : null;
  const dup = a.duplicate?.choice && a.duplicate.choice !== 'NEW' ? a.duplicate.choice : null;
  return {
    source: 'JEV',
    kind: (a.kind?.choice ?? 'UNCLEAR') as CallKind, kindProb: top(a.kind),
    urgency: a.urgency?.score ?? 0, urgencyConf: a.urgency?.confidence ?? 0,
    placeId: place, placeProb: top(a.place),
    duplicateOf: dup, dupProb: dup ? top(a.duplicate) : a.duplicate ? 1 - top(a.duplicate) : 0,
    cannotLeave: a.cannot_leave?.noul ?? 0,
    response: (a.response?.choice ?? 'HUMAN') as ResponseId, responseProb: top(a.response),
    latencyMs: performance.now() - t0, tokens: r.usage?.input_tokens ?? 0,
  };
}

/** Deterministic keyword fallback (no Jev configured). Same output shape; confidence 1 = rule fired. */
export function fallbackTriage(transcript: string, incidents: OpenIncident[]): CallTriage {
  const s = transcript.toLowerCase();
  const places = candidatePlaces(transcript);
  const placeId = places[0]?.id ?? null;
  const has = (...w: string[]) => w.some((x) => s.includes(x));
  let kind: CallKind;
  if (has('wrong number', 'market', 'thank you', 'on the news')) kind = 'NOT_EMERGENCY';
  else if (!placeId && has('[line', '[inaudible', 'hello?')) kind = 'UNCLEAR';
  else if (has('still open', 'evacuation centre', 'air safe', 'school', 'where’s')) kind = 'INFO_REQUEST';
  else if (has('smoke', 'embers', 'flames') && !has('we’re', 'my ', 'someone', 'people', 'they’re', 'i’m out')) kind = 'FIRE_REPORT';
  else kind = placeId ? 'PERSON_IN_DANGER' : 'UNCLEAR';
  const cannot = has('can’t walk', 'wheelchair', 'no car', 'hip surgery', 'oxygen', 'tree came down', 'stuck', 'little kids') ? 1 : 0;
  const repeat = has('again', 'already', 'reported it', 'anyone got', 'is anyone going', 'someone waving');
  const inc = repeat && placeId ? incidents.find((i) => places.some((p) => p.name === i.placeName)) : undefined;
  const response: ResponseId = kind === 'PERSON_IN_DANGER' ? (cannot ? 'FULL_RESCUE' : 'VERIFY_ROUTE') : kind === 'FIRE_REPORT' ? 'CHECK_FIRE' : kind === 'UNCLEAR' ? 'HUMAN' : 'REPLY';
  return {
    source: 'SIM', kind, kindProb: 1,
    urgency: kind === 'PERSON_IN_DANGER' ? (cannot ? 4 : 3) : kind === 'UNCLEAR' ? 3 : kind === 'FIRE_REPORT' ? 1 : 0, urgencyConf: 1,
    placeId: kind === 'PERSON_IN_DANGER' || kind === 'FIRE_REPORT' ? placeId : null, placeProb: placeId ? 1 : 0,
    duplicateOf: inc?.id ?? null, dupProb: inc ? 1 : 0,
    cannotLeave: cannot, response, responseProb: 1, latencyMs: 0, tokens: 0,
  };
}
