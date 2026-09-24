/**
 * Commander command → typed Directive. Function-calling pattern (docs.typesafe.ai
 * cookbooks/function_calling): the directive's closed-set fields are Jev Choice questions.
 */
import type { Area, Directive, Intent } from './types';
import type { JevClient } from './judge';

const INTENTS: Record<Intent, string> = {
  PRIORITIZE_AREA: 'Give priority to people and work in a named area',
  SEARCH_AREA: 'Search a named area for people',
  PROTECT_ROAD: 'Keep an evacuation road or escape route open',
  RESERVE: 'Hold a number of drones back in reserve at the command post',
  FOCUS_SUPPRESSION_CIVILIANS: 'Concentrate firefighting drops where people are threatened',
  RETURN_TO_BASE: 'Recall all drones to the command post',
  RESUME: 'Cancel the previous instruction and return to normal autonomous operation',
  UNKNOWN: 'Not an instruction for the drone swarm',
};
const AREAS: Record<Area, string> = {
  VILLAGE: 'the village, settlement, houses or residential area',
  NORTH_FOREST: 'the northern forest or the north',
  SOUTH: 'the south or southern part of the map',
  EAST: 'the east or eastern part of the map',
  WEST: 'the west or western part of the map',
  FIRE_FRONT: 'the fire front or the flames themselves',
  EVAC_ROAD: 'the evacuation road or escape route',
  NONE: 'no particular area is mentioned',
};
const COUNTS = ['1', '2', '3', '4', '5', '6', '8', '10'];

export async function parseWithJev(client: JevClient, text: string): Promise<Directive> {
  const resp = await client.ask(
    { commander_message: text, context: 'Incident commander instruction to an autonomous wildfire rescue drone swarm.' },
    {
      intent: { type: 'choice', instructions: 'What is the incident commander asking the drone swarm to do in `commander_message`?', criteria: INTENTS },
      area: { type: 'choice', instructions: 'Which area of the incident does `commander_message` refer to?', criteria: AREAS },
      count: {
        type: 'choice',
        instructions: 'How many drones does `commander_message` ask for?',
        criteria: Object.fromEntries(COUNTS.map((c) => [c, `${c} drone${c === '1' ? '' : 's'}`])),
      },
      count_stated: { type: 'noul', instructions: 'Does `commander_message` state a number of drones?' },
    },
  );
  const a = resp.answers;
  const intent = (a.intent?.choice ?? 'UNKNOWN') as Intent;
  const area = (a.area?.choice ?? 'NONE') as Area;
  const stated = (a.count_stated?.noul ?? 0) > 0.5;
  return {
    text,
    intent,
    area,
    count: stated ? Number(a.count?.choice ?? 5) : 5,
    confidence: Math.min(a.intent?.confidence ?? 0, a.area?.confidence ?? 1),
    source: 'JEV',
  };
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** Keyword fallback used when Jev is unavailable. */
export function parseFallback(text: string): Directive {
  const s = text.toLowerCase();
  const num = s.match(/\b(\d{1,2})\b/)?.[1] ?? Object.keys(WORDS).find((w) => new RegExp(`\\b${w}\\b`).test(s));
  const count = num ? (WORDS[num] ?? Number(num)) : 5;
  let area: Area = 'NONE';
  if (/village|town|house|settlement|residential|homes/.test(s)) area = 'VILLAGE';
  else if (/north/.test(s)) area = 'NORTH_FOREST';
  else if (/south/.test(s)) area = 'SOUTH';
  else if (/east/.test(s)) area = 'EAST';
  else if (/west/.test(s)) area = 'WEST';
  else if (/road|route|corridor/.test(s)) area = 'EVAC_ROAD';
  else if (/front|flame/.test(s)) area = 'FIRE_FRONT';
  let intent: Intent = 'UNKNOWN';
  if (/reserve|hold back|keep .* (back|base)/.test(s)) intent = 'RESERVE';
  else if (/(suppress|water|drop).*(civil|people|person)|(civil|people|person).*(suppress|water|drop)/.test(s)) intent = 'FOCUS_SUPPRESSION_CIVILIANS';
  else if (/protect|keep .* open|defend/.test(s) && /road|route/.test(s)) intent = 'PROTECT_ROAD';
  else if (/search|scan|sweep|look/.test(s)) intent = 'SEARCH_AREA';
  else if (/priorit|focus|concentrate/.test(s)) intent = 'PRIORITIZE_AREA';
  else if (/return|recall|rtb|come back/.test(s)) intent = 'RETURN_TO_BASE';
  else if (/resume|cancel|autonom|normal/.test(s)) intent = 'RESUME';
  if (intent === 'PROTECT_ROAD') area = 'EVAC_ROAD';
  return { text, intent, area, count, confidence: intent === 'UNKNOWN' ? 0.2 : 0.8, source: 'SIM' };
}

export function describeDirective(d: Directive): string {
  const areaTxt = d.area === 'NONE' ? '' : ` · ${d.area.replace('_', ' ')}`;
  switch (d.intent) {
    case 'RESERVE': return `RESERVE ${d.count} DRONES`;
    case 'UNKNOWN': return 'NOT UNDERSTOOD';
    default: return `${d.intent.replace(/_/g, ' ')}${areaTxt}`;
  }
}
