/**
 * Named places callers refer to (the local gazetteer). Code finds candidate places in a
 * transcript; Jev *selects* among them (select, don't generate) or answers UNKNOWN.
 */
import { dist2 } from '../core/math';
import { HERO_BUILDING_POS, type Pt } from '../world/layout';

export interface Place {
  id: string;
  name: string;
  /** Extra phrases callers use for it (lower-case). */
  aliases: string[];
  x: number; z: number;
}

export const PLACES: Place[] = [
  { id: 'WEST_LANE_END', name: 'the end of West Lane', aliases: ['west lane', 'end of the lane'], ...HERO_BUILDING_POS },
  { id: 'VILLAGE_LANE', name: 'Village Lane', aliases: ['village lane'], x: -110, z: -170 },
  { id: 'SQUARE', name: 'the village square by the church', aliases: ['square', 'church', 'town centre', 'town center'], x: 60, z: -60 },
  { id: 'MAIN_JUNCTION', name: 'the Main Road junction', aliases: ['main road', 'junction', 'crossroads'], x: 0, z: -20 },
  { id: 'EVAC_ROAD', name: 'the Evacuation Road', aliases: ['evacuation road', 'road to the safe zone'], x: 330, z: 290 },
  { id: 'MILLER_FARM', name: "Miller's farm", aliases: ['miller', 'farm', 'farmhouse'], x: 360, z: 330 },
  { id: 'PINE_CABIN', name: 'the cabin up Pine Hollow', aliases: ['pine hollow', 'cabin'], x: -300, z: -420 },
  { id: 'OLD_MILL', name: 'the old mill', aliases: ['old mill', 'mill'], x: 560, z: -150 },
  { id: 'FOREST_TRACK', name: 'the North Forest Track', aliases: ['forest track', 'north track', 'logging track'], x: -40, z: -520 },
  { id: 'TRACK_TOP', name: 'the top of the forest track', aliases: ['top of the track', 'lookout'], x: 60, z: -760 },
  { id: 'LAKE', name: 'the lake', aliases: ['lake', 'reservoir', 'water'], x: -520, z: 180 },
];

export const placeById = (id: string) => PLACES.find((p) => p.id === id);

export function nearestPlace(p: Pt): { place: Place; d: number } {
  let best = PLACES[0], bd = Infinity;
  for (const q of PLACES) {
    const d = dist2(p.x, p.z, q.x, q.z);
    if (d < bd) { bd = d; best = q; }
  }
  return { place: best, d: bd };
}

/** Code step: places whose name or alias appears in the transcript (candidates for Jev to choose from). */
export function candidatePlaces(transcript: string): Place[] {
  const s = transcript.toLowerCase();
  return PLACES.filter((p) => [p.name.toLowerCase().replace(/^the /, ''), ...p.aliases].some((a) => s.includes(a)));
}
