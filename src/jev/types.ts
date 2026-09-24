import type { Drone, Role, TaskKind } from '../sim/drone';
import type { Pt } from '../world/layout';

export type ObjectiveKind = 'VERIFY' | 'RESCUE' | 'SUPPRESS' | 'SEARCH' | 'RELAY' | 'PROTECT_ROAD' | 'MONITOR';

/** A slot the allocator fills with one drone. */
export interface Slot {
  task: TaskKind;
  prefer: Role;
  label: string;
  target: Pt;
  waypoints?: Pt[];
}

/**
 * A candidate objective, built by code from OBSERVABLE state only.
 * `facts` is the concise natural-language summary sent to Jev.
 */
export interface Objective {
  id: string;
  kind: ObjectiveKind;
  sector: string;
  x: number; z: number;
  facts: string;
  arrivalSec: number; // predicted fire arrival at the objective (Infinity if none)
  detectionId?: string;
  slots: Slot[];
  /** Code-side modifiers (commander intent); never hidden from the log. */
  boost: number;
}

export interface Judgment {
  source: 'JEV' | 'SIM';
  model?: string;
  priorityId: string | null;
  priorityConf: number;
  urgency: Record<string, number>; // 0..4
  urgencyConf: Record<string, number>;
  latencyMs: number;
  inputTokens?: number;
}

export type Intent =
  | 'PRIORITIZE_AREA' | 'SEARCH_AREA' | 'PROTECT_ROAD' | 'RESERVE'
  | 'FOCUS_SUPPRESSION_CIVILIANS' | 'RETURN_TO_BASE' | 'RESUME' | 'UNKNOWN';
export type Area = 'VILLAGE' | 'NORTH_FOREST' | 'SOUTH' | 'EAST' | 'WEST' | 'FIRE_FRONT' | 'EVAC_ROAD' | 'NONE';

export interface Directive {
  text: string;
  intent: Intent;
  area: Area;
  count: number;
  confidence: number;
  source: 'JEV' | 'SIM';
}

export interface Assignment {
  drone: Drone;
  objectiveId: string;
  slot: Slot;
}

export interface PlanChange {
  droneId: string;
  from: string;
  to: string;
  objectiveId: string;
  fromTarget?: Pt;
}

export interface LogEntry {
  t: number;
  title: string;
  lines: string[];
  level: 'info' | 'warn' | 'crit' | 'jev' | 'ok';
}
