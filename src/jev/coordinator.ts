/**
 * JevCoordinator — strategic layer. Runs periodically and on significant events.
 * Pipeline: observable state → candidate objectives (code) → judgments (Jev or fallback)
 * → allocation (code) → drone tasks. Flight, sensing and fire stay deterministic code.
 */
import { fmtClock } from '../core/math';
import type { Drone, Task } from '../sim/drone';
import { allocate, type AllocResult } from './allocator';
import { describeDirective, parseFallback, parseWithJev } from './commands';
import { fallbackJudge, jevJudge, JevClient, type JudgeContext } from './judge';
import { buildObjectives, fmtMin, type CoordView, type CorridorState } from './objectives';
import { planCorridor } from './planner';

const STAGING = { x: -330, z: 280 };
import type { Directive, Judgment, LogEntry, Objective, PlanChange } from './types';

export interface CoordinatorEvents {
  log(e: LogEntry): void;
  replanned(changes: PlanChange[], j: Judgment, objs: Objective[]): void;
  priorityChange(title: string, lines: string[], objective: Objective): void;
}

export type CoordMode = 'JEV' | 'SIM';

export class JevCoordinator {
  readonly client = new JevClient();
  mode: CoordMode = 'SIM';
  directive: Directive | null = null;
  corridors = new Map<string, CorridorState>();
  judgment: Judgment | null = null;
  objectives: Objective[] = [];
  alloc: AllocResult | null = null;
  replans = 0;
  decisions = 0;
  jevCalls = 0;
  lastLatency = 0;
  windNote = 'steady';
  private nextPlanT = 4;
  private pending: string | null = 'initial plan';
  private inflight = false;
  private escalated = new Set<string>();
  private lastPriority: string | null = null;
  private lastBannerT = -999;
  enabled = false;
  /** Force the offline coordinator even when Jev is configured. */
  forceSim = false;

  constructor(private ev: CoordinatorEvents) {}

  async init(): Promise<void> {
    await this.client.init();
    this.mode = this.client.connected && !this.forceSim ? 'JEV' : 'SIM';
  }

  get label(): string {
    return this.mode === 'JEV' ? 'JEV CONNECTED' : 'SIMULATION COORDINATOR';
  }

  /** Full-screen priority callouts (the demo enables them at the wind shift). */
  calloutsEnabled = true;
  /** Objective id the demo wants featured in the callout, if it escalates. */
  featured: string | null = null;

  trigger(reason: string): void {
    this.pending = reason;
    if (reason === 'wind shift') {
      // A major change: re-evaluate every escalation under the new conditions.
      this.escalated.clear();
      this.lastBannerT = -999;
      for (const c of this.corridors.values()) c.plannedAt = -Infinity;
    }
  }

  tick(view: CoordView, ctxExtra: Omit<JudgeContext, 't' | 'fire' | 'drones' | 'directive' | 'windNote'> = {}): void {
    if (!this.enabled) return;
    if (view.t < this.nextPlanT && !this.pending) return;
    if (this.inflight) return;
    const reason = this.pending ?? 'periodic';
    this.pending = null;
    this.nextPlanT = view.t + 10;
    view.arrival = view.fire.predictArrival();
    const objs = buildObjectives(view);
    const ctx: JudgeContext = { t: view.t, fire: view.fire, drones: view.drones, directive: this.directive, windNote: this.windNote, ...ctxExtra };
    if (this.mode === 'JEV' && this.client.connected) {
      this.inflight = true;
      jevJudge(this.client, objs, ctx)
        .then((j) => {
          this.jevCalls++;
          this.lastLatency = j.latencyMs;
          // Re-derive objectives at apply time: the world moved while Jev answered.
          this.apply(j, buildObjectives(view), view, reason);
        })
        .catch((e: unknown) => {
          this.ev.log({ t: view.t, title: 'JEV UNAVAILABLE', lines: [String(e instanceof Error ? e.message : e).slice(0, 60), 'fallback coordinator engaged'], level: 'warn' });
          if (!this.client.connected) this.mode = 'SIM';
          this.apply(fallbackJudge(objs, ctx), objs, view, reason);
        })
        .finally(() => (this.inflight = false));
    } else {
      this.apply(fallbackJudge(objs, ctx), objs, view, reason);
    }
  }

  private apply(j: Judgment, objs: Objective[], view: CoordView, reason: string): void {
    this.judgment = j;
    this.objectives = objs;
    this.replans++;
    // Corridor routes are planned in code for every person-related objective that needs one.
    for (const o of objs) {
      if (!o.detectionId) continue;
      const needs = o.slots.some((s) => s.task === 'CORRIDOR');
      const st = this.corridors.get(o.detectionId);
      // Routes are cached; re-planned every 15 s (or after a wind shift) until flown.
      if (needs && (!st || (!st.flown && view.t - st.plannedAt > 15))) {
        const route = planCorridor({ x: o.x, z: o.z }, view.fire, view.arrival);
        this.corridors.set(o.detectionId, { route, flown: false, guided: st?.guided ?? false, plannedAt: view.t });
      }
    }
    const res = allocate(objs, j, view.drones, this.directive);
    this.alloc = res;
    const changes: PlanChange[] = [];
    const byId = new Map(objs.map((o) => [o.id, o]));
    const recall = this.directive?.intent === 'RETURN_TO_BASE';
    const set = (d: Drone, task: Task, objectiveId: string) => {
      const cur = d.task;
      if (cur.objectiveId === objectiveId && (cur.kind === task.kind || (cur.kind === 'SWAP' && cur.then?.kind === task.kind))) {
        // Same job: refresh target without restarting the manoeuvre.
        const live = cur.kind === 'SWAP' ? cur.then! : cur;
        if (live.kind !== 'SUPPRESS' || d.phase < 2) live.target = task.target;
        if (task.waypoints && live.kind !== 'SEARCH') live.waypoints = task.waypoints;
        return;
      }
      changes.push({ droneId: d.id, from: cur.label, to: task.label, objectiveId, fromTarget: d.airborne && cur.kind !== 'IDLE' ? { ...cur.target } : undefined });
      d.assign(task);
    };
    for (const a of res.allocs) {
      if (recall) break;
      const o = byId.get(a.objectiveId)!;
      const det = o.detectionId;
      const civ = det ? view.confirmedCiv(det) : undefined;
      const cor = det ? this.corridors.get(det) : undefined;
      let task: Task = {
        kind: a.slot.task, objectiveId: o.id, target: a.slot.target, label: a.slot.label,
        waypoints: a.slot.task === 'CORRIDOR' ? (cor?.route ?? [a.slot.target]) : a.slot.waypoints,
        detectionId: det, civilianId: civ?.id ?? det,
      };
      if (a.swapTo) task = { kind: 'SWAP', objectiveId: o.id, target: a.drone.pad, label: `PAYLOAD SWAP → ${a.swapTo}`, swapTo: a.swapTo, then: task };
      set(a.drone, task, o.id);
    }
    for (const d of res.reserve) {
      if (d.task.kind !== 'RESERVE') set(d, { kind: 'RESERVE', target: d.pad, label: 'RESERVE', objectiveId: 'RESERVE' }, 'RESERVE');
    }
    for (const d of recall ? view.drones.filter((q) => q.airborne) : res.idle) {
      if (recall) {
        if (d.task.kind !== 'RTB') set(d, { kind: 'RTB', target: d.pad, label: 'RTB · COMMANDER', objectiveId: 'RTB' }, 'RTB');
      } else if (d.airborne && d.task.kind !== 'IDLE' && d.task.kind !== 'SWAP') {
        set(d, { kind: 'IDLE', target: { x: d.x, z: d.z }, label: 'HOLDING', objectiveId: 'IDLE' }, 'IDLE');
      } else if (d.status === 'LANDED' && d.task.kind === 'IDLE' && d.battery > 0.9 && d.launchAt <= view.t) {
        // Unassigned aircraft pre-position in a staging orbit between the command post and the village.
        const a = (d.index * 2.39996) % (Math.PI * 2);
        const tgt = { x: STAGING.x + Math.cos(a) * 110, z: STAGING.z + Math.sin(a) * 110 };
        set(d, { kind: 'IDLE', target: tgt, label: 'STAGING', objectiveId: 'IDLE' }, 'IDLE');
      }
    }
    this.decisions += changes.length + 1;

    // Decision stream.
    const src = j.source === 'JEV' ? 'JEV' : 'COORD';
    const pri = j.priorityId ? byId.get(j.priorityId) : undefined;
    const rank = (c: PlanChange) => (c.to.startsWith('SEARCH') || c.to === 'HOLDING' || c.to === 'STAGING' ? 1 : 0);
    changes.sort((a, b) => rank(a) - rank(b));
    if (changes.length) {
      const lines = changes.slice(0, 6).map((c) => `${c.droneId} → ${c.to.toLowerCase()}`);
      if (changes.length > 6) lines.push(`+${changes.length - 6} more`);
      this.ev.log({ t: view.t, title: `${src} REPLAN`, lines: [`trigger: ${reason}`, ...lines], level: 'jev' });
    }
    if (pri && pri.id !== this.lastPriority) {
      this.lastPriority = pri.id;
      const u = j.urgency[pri.id] ?? 0;
      this.ev.log({ t: view.t, title: 'PRIORITY', lines: [`${pri.kind.toLowerCase()} ${pri.sector}`, `urgency ${u.toFixed(1)}/4${j.source === 'JEV' ? ` · conf ${j.priorityConf.toFixed(2)}` : ''}`], level: 'info' });
    }
    const fresh = objs
      .filter((o) => (o.kind === 'VERIFY' || o.kind === 'RESCUE') && (j.urgency[o.id] ?? 0) >= 3.4 && !this.escalated.has(o.id))
      .sort((a, b) => a.arrivalSec - b.arrivalSec);
    if (fresh.length) {
      fresh.forEach((o) => this.escalated.add(o.id));
      const o = fresh.find((q) => q.id === this.featured) ?? fresh[0];
      const sectors = [...new Set(fresh.map((q) => q.sector))];
      this.ev.log({ t: view.t, title: 'PRIORITY ESCALATED', lines: [`${sectors.join(', ')} → CRITICAL`, `fire arrival ${fmtMin(o.arrivalSec)}`], level: 'crit' });
      // Full-screen callout at most every 25 s so it stays meaningful.
      if (this.calloutsEnabled && view.t - this.lastBannerT > 25) {
        this.lastBannerT = view.t;
        this.ev.priorityChange('JEV PRIORITY CHANGE', ['CIVILIAN RISK: CRITICAL', ...teamLines(o, view.drones, changes)], o);
      }
    }
    this.ev.replanned(changes, j, objs);
  }

  async command(text: string, t: number): Promise<Directive> {
    let d: Directive;
    try {
      d = this.mode === 'JEV' && this.client.connected ? await parseWithJev(this.client, text) : parseFallback(text);
    } catch {
      d = parseFallback(text);
    }
    if (d.intent === 'UNKNOWN' || d.confidence < 0.35) {
      this.ev.log({ t, title: 'COMMAND NOT UNDERSTOOD', lines: [`"${text.slice(0, 48)}"`, 'try: "search the northern forest"'], level: 'warn' });
      return d;
    }
    this.directive = d.intent === 'RESUME' ? null : d;
    this.ev.log({ t, title: 'COMMANDER DIRECTIVE', lines: [`"${text.slice(0, 48)}"`, `→ ${describeDirective(d)}`, `parsed by ${d.source === 'JEV' ? 'Jev' : 'keyword fallback'} · conf ${d.confidence.toFixed(2)}`], level: 'ok' });
    this.trigger('commander directive');
    return d;
  }

  /** For the stream: "WIND MODEL UPDATE" style notes. */
  static clock(t: number): string {
    return fmtClock(t);
  }
}

const CALLOUT_TASK: Record<string, string> = {
  VERIFY: 'VERIFY', SUPPRESS: 'SUPPRESSION', RELAY: 'RELAY', CORRIDOR: 'EVACUATION ROUTE SEARCH',
  DELIVER: 'SUPPLY DROP', GUIDE: 'GUIDE TO SAFETY', SWAP: 'PAYLOAD SWAP',
};
const CALLOUT_ORDER = ['VERIFY', 'SUPPRESS', 'RELAY', 'CORRIDOR', 'DELIVER', 'GUIDE', 'SWAP'];

/** The drones now serving a critical objective and its supporting work (changed ones first). */
function teamLines(o: Objective, drones: Drone[], changes: PlanChange[]): string[] {
  const near = (d: Drone) => Math.hypot(d.task.target.x - o.x, d.task.target.z - o.z) < 520;
  const team = drones.filter((d) => {
    const id = d.task.objectiveId ?? '';
    return id === o.id || ((id.startsWith('SUP_') || id.startsWith('RLY_')) && near(d)) || (d.task.kind === 'SWAP' && id === o.id);
  });
  const kind = (d: Drone) => (d.task.kind === 'SWAP' ? d.task.then?.kind ?? 'SWAP' : d.task.kind);
  const changed = new Set(changes.map((c) => c.droneId));
  const picked: Drone[] = [];
  for (const k of CALLOUT_ORDER) {
    const c = team.filter((d) => kind(d) === k).sort((a, b) => Number(changed.has(b.id)) - Number(changed.has(a.id)))[0];
    if (c) picked.push(c);
  }
  return picked.slice(0, 4).map((d) => `${d.id} → ${CALLOUT_TASK[kind(d)] ?? d.task.label}`);
}
