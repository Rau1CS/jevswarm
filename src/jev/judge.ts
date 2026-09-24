/**
 * Judgment sources. JevJudge asks TypeSafe Jev (POST /v1/systemone via the local proxy):
 *   - `priority`      Choice over candidate objectives
 *   - `urgency.<id>`  Score (5 levels) per objective
 * All questions go in ONE request (speculative fan-out); code consumes the answers.
 * FallbackJudge produces the same shape from transparent heuristics.
 */
import { fmtClock } from '../core/math';
import type { FireModel } from '../sim/fire';
import type { Drone } from '../sim/drone';
import type { Directive, Judgment, Objective } from './types';

export const URGENCY_LEVELS = [
  'Routine: nobody and nothing important is at stake for at least 15 minutes; this can wait.',
  'Low: useful for situational awareness, but nothing is threatened in the next 10 minutes.',
  'Moderate: people or property could be affected within about 10 minutes, or important information is unresolved.',
  'High: a possible person or an evacuation route could be reached by fire within 5 to 10 minutes.',
  'Critical: a person is likely to be in danger within about 5 minutes unless drones act now.',
];

const MAX_JEV_OBJECTIVES = 16;

export interface JudgeContext {
  t: number;
  fire: FireModel;
  drones: Drone[];
  directive: Directive | null;
  windNote: string;
}

type AnyAnswer = { type: string; choice?: string; score?: number; confidence?: number; noul?: number };
interface JevResponse { model: string; answers: Record<string, AnyAnswer>; usage?: { input_tokens: number } }

export class JevClient {
  connected = false;
  configured = false;
  lastError = '';
  calls = 0;
  inputTokens = 0;

  async init(): Promise<void> {
    try {
      const r = await fetch('/api/jev/status');
      const j = (await r.json()) as { configured: boolean };
      this.configured = this.connected = Boolean(j.configured);
    } catch {
      this.configured = this.connected = false;
    }
  }

  async ask(state: unknown, questions: Record<string, unknown>): Promise<JevResponse> {
    const r = await fetch('/api/jev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, questions }),
    });
    const j = await r.json();
    if (!r.ok) {
      this.lastError = `${r.status} ${(j as { error?: string }).error ?? ''}`.trim();
      if (r.status === 401 || r.status === 503) this.connected = false;
      throw new Error(this.lastError);
    }
    this.calls++;
    const resp = j as JevResponse;
    this.inputTokens += resp.usage?.input_tokens ?? 0;
    return resp;
  }
}

/** Pre-rank so the most relevant objectives are the ones Jev sees when there are many. */
export function prerank(o: Objective): number {
  const base = { RESCUE: 5, VERIFY: 4, SUPPRESS: 3, PROTECT_ROAD: 3, RELAY: 2, MONITOR: 1.5, SEARCH: 1 }[o.kind];
  return base + (Number.isFinite(o.arrivalSec) ? Math.max(0, 3 - o.arrivalSec / 200) : 0) + o.boost;
}

export function buildJevRequest(objs: Objective[], ctx: JudgeContext) {
  const top = [...objs].sort((a, b) => prerank(b) - prerank(a)).slice(0, MAX_JEV_OBJECTIVES);
  const airborne = ctx.drones.filter((d) => d.airborne);
  const stats = ctx.fire.stats();
  const state = {
    mission_time: fmtClock(ctx.t),
    commander_intent: ctx.directive?.text ?? 'No specific instruction. Standard doctrine: protect life first.',
    wind: { from_degrees: Math.round(ctx.fire.wind.fromDeg), speed_mps: +ctx.fire.wind.speed.toFixed(1), note: ctx.windNote },
    fire: { active_front_km: +stats.frontKm.toFixed(2), burned_area_ha: +stats.areaHa.toFixed(1) },
    swarm: {
      airborne: airborne.length,
      suppression_drones_with_payload: ctx.drones.filter((d) => d.role === 'SUPPRESSION' && d.payload > 0.5).length,
      low_battery: ctx.drones.filter((d) => d.battery < 0.3).length,
    },
    objectives: top.map((o) => ({ id: o.id, kind: o.kind, sector: o.sector, facts: o.facts })),
  };
  const questions: Record<string, unknown> = {
    priority: {
      type: 'choice',
      instructions:
        "Which objective in `objectives` should the wildfire rescue drone swarm treat as its single top priority right now? Protect human life first, then keep fire away from people and evacuation routes, then build situational awareness. Follow `commander_intent` unless doing so would leave a person in immediate danger.",
      criteria: Object.fromEntries(top.map((o) => [o.id, `${o.kind} in ${o.sector}: ${o.facts}`])),
    },
  };
  top.forEach((o, i) => {
    questions[`urgency.${o.id}`] = {
      type: 'score',
      instructions: `How urgent is objective \`objectives[${i}]\` (${o.kind} in ${o.sector}) for the wildfire rescue drone swarm right now, given \`wind\`, \`fire\` and \`commander_intent\`?`,
      criteria: URGENCY_LEVELS,
    };
  });
  return { state, questions, top };
}

export async function jevJudge(client: JevClient, objs: Objective[], ctx: JudgeContext): Promise<Judgment> {
  const t0 = performance.now();
  const { state, questions, top } = buildJevRequest(objs, ctx);
  const resp = await client.ask(state, questions);
  const urgency: Record<string, number> = {};
  const urgencyConf: Record<string, number> = {};
  for (const o of top) {
    const a = resp.answers[`urgency.${o.id}`];
    if (a && typeof a.score === 'number') {
      urgency[o.id] = a.score;
      urgencyConf[o.id] = a.confidence ?? 0;
    }
  }
  // Objectives Jev did not see (overflow) get heuristic urgency, clearly marked in code.
  const fb = fallbackJudge(objs.filter((o) => !(o.id in urgency)), ctx);
  const p = resp.answers.priority;
  return {
    source: 'JEV',
    model: resp.model,
    priorityId: p?.choice ?? fb.priorityId,
    priorityConf: p?.confidence ?? 0,
    urgency: { ...fb.urgency, ...urgency },
    urgencyConf: { ...fb.urgencyConf, ...urgencyConf },
    latencyMs: performance.now() - t0,
    inputTokens: resp.usage?.input_tokens,
  };
}

/** Deterministic fallback — same outputs, transparent rules. */
export function fallbackJudge(objs: Objective[], _ctx: JudgeContext): Judgment {
  const urgency: Record<string, number> = {};
  const conf: Record<string, number> = {};
  const band = (arr: number, a: number, b: number, c: number) => (arr < 300 ? a : arr < 600 ? b : c);
  for (const o of objs) {
    const arr = o.arrivalSec;
    let u = 1;
    switch (o.kind) {
      case 'RESCUE': u = band(arr, 4, 3.3, 2.6); break;
      case 'VERIFY': u = band(arr, 3.7, 2.8, 1.9); break;
      case 'SUPPRESS': u = band(arr, 3.3, 2.4, 1.3); break;
      case 'PROTECT_ROAD': u = band(arr, 3, 2.2, 1.2); break;
      case 'RELAY': u = 2; break;
      case 'MONITOR': u = 1.5; break;
      case 'SEARCH': u = 0.9 + (arr < 600 ? 0.6 : 0); break;
    }
    urgency[o.id] = u;
    conf[o.id] = 1;
  }
  let best: string | null = null;
  for (const o of objs) if (!best || urgency[o.id] + o.boost > urgency[best] + (objs.find((q) => q.id === best)?.boost ?? 0)) best = o.id;
  return { source: 'SIM', priorityId: best, priorityConf: 1, urgency, urgencyConf: conf, latencyMs: 0 };
}
