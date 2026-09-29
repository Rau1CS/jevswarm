/**
 * Emergency call centre: receives calls, gets ONE triage judgment per call (Jev, or the
 * labelled fallback), then applies an explicit, human-readable dispatch POLICY (code):
 *   - confident info requests / non-emergencies → automatic reply, no aircraft
 *   - confident repeat calls → merged into the open incident (raises its priority)
 *   - unclear calls or unknown places → operator must listen back (human review)
 *   - large packages (≥ 3 aircraft) or uncertain life-safety calls → commander approval ping
 *   - everything else → dispatched automatically
 * Execution (creating the incident, tasking drones, flying) is deterministic code.
 */
import { sectorOf } from '../core/math';
import type { JevClient } from '../jev/judge';
import type { Pt } from '../world/layout';
import type { Call } from './generator';
import { placeById } from './places';
import { RESPONSES, fallbackTriage, jevTriage, type CallTriage, type OpenIncident, type ResponseId } from './triage';

export type CallStatus = 'TRIAGING' | 'AUTO_REPLY' | 'MERGED' | 'REVIEW' | 'AWAITING_APPROVAL' | 'DISPATCHED' | 'DISMISSED';
export type DecidedBy = 'JEV' | 'CODE' | 'HUMAN';

export interface CallRecord {
  call: Call;
  triage?: CallTriage;
  status: CallStatus;
  /** Why the policy routed it this way (shown in the UI). */
  reason: string;
  response?: ResponseId;
  incidentId?: string;
  decidedBy?: DecidedBy;
  decidedAt?: number;
}

export interface Incident {
  id: string;
  placeId: string;
  detId: string | null;
  callIds: string[];
  response: ResponseId;
  cannotLeave: boolean;
  supplied?: boolean;
  t: number;
}

export interface FireReport { id: string; x: number; z: number; placeName: string; until: number }

export interface CallHost {
  t(): number;
  client(): JevClient | null;
  log(title: string, lines: string[], level: 'info' | 'warn' | 'crit' | 'jev' | 'ok', by: DecidedBy): void;
  banner(title: string, lines: string[], level: 'warn' | 'crit' | 'info'): void;
  /** Create the map incident (a POSSIBLE detection) — returns its id. */
  createIncident(p: Pt, conf: number, civId: string | null): string;
  replan(reason: string): void;
  detectionOpen(detId: string): boolean;
}

/** SIM policy thresholds (explicit so they can be shown and tuned). */
export const POLICY = { minKind: 0.6, minPlace: 0.55, minDup: 0.6, approveUnits: 3, approveUncertain: 0.7 };

export class CallCenter {
  records: CallRecord[] = [];
  incidents: Incident[] = [];
  fireReports: FireReport[] = [];
  /** Commander-approval pings waiting for a human decision. */
  onChange: () => void = () => {};
  private nInc = 0;
  /** False in the app: without Jev a call goes to a human operator, never to keyword rules. */
  allowFallback = true;

  constructor(private host: CallHost) {}

  get pending(): CallRecord[] {
    return this.records.filter((r) => r.status === 'AWAITING_APPROVAL' || r.status === 'REVIEW');
  }

  openIncidents(): OpenIncident[] {
    return this.incidents
      .filter((i) => !i.detId || this.host.detectionOpen(i.detId))
      .slice(-8)
      .map((i) => ({
        id: i.id,
        placeName: placeById(i.placeId)?.name ?? i.placeId,
        summary: `${i.callIds.length} call(s); ${i.cannotLeave ? 'someone who cannot get out on their own' : 'people near the fire'}`,
      }));
  }

  receive(call: Call): CallRecord {
    const rec: CallRecord = { call, status: 'TRIAGING', reason: 'triaging…' };
    this.records.unshift(rec);
    if (this.records.length > 60) this.records.pop();
    const incidents = this.openIncidents();
    const client = this.host.client();
    this.host.log('EMERGENCY CALL', [`${call.id} · ${call.caller}`, `“${call.transcript.slice(0, 70)}…”`], 'warn', 'CODE');
    const done = (tr: CallTriage) => { rec.triage = tr; this.decide(rec); this.onChange(); };
    const noJev = () => {
      if (this.allowFallback) return done(fallbackTriage(call.transcript, incidents));
      rec.status = 'REVIEW';
      rec.reason = 'Jev unavailable · operator must triage';
      this.onChange();
    };
    if (client?.connected) jevTriage(client, call.transcript, incidents).then(done).catch(noJev);
    else noJev();
    this.onChange();
    return rec;
  }

  /** The dispatch policy. Pure code over Jev's typed answers. */
  private decide(rec: CallRecord): void {
    const tr = rec.triage!;
    const by: DecidedBy = tr.source === 'JEV' ? 'JEV' : 'CODE';
    const tag = `${tr.source === 'JEV' ? 'Jev' : 'fallback'}: ${tr.kind.replace(/_/g, ' ').toLowerCase()} ${Math.round(tr.kindProb * 100)}%`;
    const place = tr.placeId ? placeById(tr.placeId) : undefined;
    rec.response = tr.response;
    if ((tr.kind === 'INFO_REQUEST' || tr.kind === 'NOT_EMERGENCY') && tr.kindProb >= POLICY.minKind) {
      return this.finish(rec, 'AUTO_REPLY', 'no aircraft · automatic reply', by, [tag, 'auto-reply sent · no aircraft']);
    }
    if (tr.duplicateOf && tr.dupProb >= POLICY.minDup) {
      const inc = this.incidents.find((i) => i.id === tr.duplicateOf);
      if (inc) {
        inc.callIds.push(rec.call.id);
        rec.incidentId = inc.id;
        this.host.replan('repeat call');
        return this.finish(rec, 'MERGED', `repeat call → ${inc.id}`, by, [tag, `same people as ${inc.id} (${Math.round(tr.dupProb * 100)}%) · merged, priority raised`]);
      }
    }
    if (tr.kind === 'UNCLEAR' || tr.response === 'HUMAN' || tr.kindProb < POLICY.minKind || ((tr.kind === 'PERSON_IN_DANGER' || tr.kind === 'FIRE_REPORT') && (!place || tr.placeProb < POLICY.minPlace))) {
      rec.status = 'REVIEW';
      rec.reason = !place ? 'location unknown · operator must listen back' : 'unclear call · operator must listen back';
      this.host.log('OPERATOR REVIEW', [`${rec.call.id} · ${tag}`, rec.reason], 'warn', by);
      this.host.banner('CALL NEEDS OPERATOR', [`${rec.call.id} · ${rec.reason.toUpperCase()}`], 'warn');
      return;
    }
    const pkg = RESPONSES[tr.response];
    const uncertainLife = tr.kind === 'PERSON_IN_DANGER' && (tr.kindProb < POLICY.approveUncertain || tr.urgencyConf < 0.35);
    if (pkg.units >= POLICY.approveUnits || uncertainLife) {
      rec.status = 'AWAITING_APPROVAL';
      rec.reason = pkg.units >= POLICY.approveUnits ? `${pkg.units} aircraft requested · commander approval required` : 'uncertain life-safety call · commander approval required';
      this.host.log('APPROVAL REQUESTED', [`${rec.call.id} · ${tag}`, `${pkg.label} → ${place?.name ?? '?'}`, rec.reason], 'crit', by);
      this.host.banner('COMMANDER APPROVAL NEEDED', [`${rec.call.id} · ${pkg.label.toUpperCase()}`, (place?.name ?? '').toUpperCase()], 'crit');
      return;
    }
    this.execute(rec, tr.response, by, tag);
  }

  private finish(rec: CallRecord, status: CallStatus, reason: string, by: DecidedBy, lines: string[]): void {
    rec.status = status;
    rec.reason = reason;
    rec.decidedBy = by;
    rec.decidedAt = this.host.t();
    this.host.log(status === 'MERGED' ? 'REPEAT CALL MERGED' : 'CALL ANSWERED', [`${rec.call.id}`, ...lines], by === 'JEV' ? 'jev' : 'info', by);
  }

  /** Commander decision on a pending call (HUMAN in the loop). */
  approve(callId: string, response?: ResponseId, placeId?: string): void {
    const rec = this.records.find((r) => r.call.id === callId);
    if (!rec || (rec.status !== 'AWAITING_APPROVAL' && rec.status !== 'REVIEW')) return;
    if (placeId && rec.triage) rec.triage.placeId = placeId;
    const r = response ?? rec.response ?? 'VERIFY';
    this.host.log('COMMANDER DECISION', [`${rec.call.id} · ${RESPONSES[r].label}`, placeId ? `location set by operator: ${placeById(placeId)?.name}` : 'approved as proposed'], 'ok', 'HUMAN');
    this.execute(rec, r, 'HUMAN', 'commander');
    this.onChange();
  }

  dismiss(callId: string): void {
    const rec = this.records.find((r) => r.call.id === callId);
    if (!rec || (rec.status !== 'AWAITING_APPROVAL' && rec.status !== 'REVIEW')) return;
    this.finish(rec, 'DISMISSED', 'dismissed by commander', 'HUMAN', ['no action']);
    this.onChange();
  }

  /** Deterministic execution of a response package. */
  private execute(rec: CallRecord, response: ResponseId, by: DecidedBy, tag: string): void {
    const tr = rec.triage!;
    const place = tr.placeId ? placeById(tr.placeId) : undefined;
    rec.response = response;
    rec.decidedBy = by;
    rec.decidedAt = this.host.t();
    if (response === 'REPLY' || response === 'HUMAN' || !place) {
      return this.finish(rec, response === 'HUMAN' ? 'REVIEW' : 'AUTO_REPLY', response === 'HUMAN' ? 'operator listen-back' : 'reply sent', by, [tag]);
    }
    rec.status = 'DISPATCHED';
    if (response === 'CHECK_FIRE') {
      const same = this.activeFireReports(this.host.t()).find((f) => f.placeName === place.name);
      if (same) {
        // Code-level de-duplication: one drone per reported place is enough.
        same.until = this.host.t() + 150;
        return this.finish(rec, 'MERGED', `same fire report as ${same.id}`, 'CODE', [tag, `already checking ${place.name}`]);
      }
      this.fireReports.push({ id: `RPT${rec.call.id}`, x: place.x, z: place.z, placeName: place.name, until: this.host.t() + 150 });
      rec.reason = `drone checking reported fire · ${place.name}`;
      this.host.log('FIRE REPORT DISPATCH', [`${rec.call.id} · ${tag}`, `mapping drone → ${place.name} (${sectorOf(place.x, place.z)})`], 'jev', by);
      this.host.replan('fire report');
      return;
    }
    // People: create the incident on the map at the reported place; drones verify it.
    const conf = 0.45 + 0.1 * Math.min(4, tr.urgency) / 4;
    const detId = this.host.createIncident({ x: place.x + 8, z: place.z - 6 }, conf, rec.call.truth.civId);
    const inc: Incident = { id: `INC${++this.nInc}`, placeId: place.id, detId, callIds: [rec.call.id], response, cannotLeave: tr.cannotLeave >= 0.5, t: this.host.t() };
    this.incidents.push(inc);
    rec.incidentId = inc.id;
    rec.reason = `${RESPONSES[response].label} → ${place.name}`;
    this.host.log('DISPATCH', [`${rec.call.id} → ${inc.id} · ${place.name} (${sectorOf(place.x, place.z)})`, RESPONSES[response].label, `decided by ${by === 'HUMAN' ? 'commander' : by === 'JEV' ? 'Jev (auto, confident)' : 'fallback rules'}`], 'ok', by);
    this.host.replan('call dispatch');
  }

  /** Coordinator view of call-derived facts for a detection. */
  callInfo(detId: string): { incident: Incident; calls: number } | undefined {
    const incident = this.incidents.find((i) => i.detId === detId);
    return incident ? { incident, calls: incident.callIds.length } : undefined;
  }

  activeFireReports(t: number): FireReport[] {
    this.fireReports = this.fireReports.filter((f) => f.until > t);
    return this.fireReports;
  }
}
