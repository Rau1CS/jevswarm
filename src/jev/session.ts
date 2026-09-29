/**
 * Recorded Jev sessions. The simulation is deterministic given its seed, so a session is just
 * Jev's real answers plus the simulation step at which each one arrived. Replaying feeds the
 * same answers back at the same steps: every drone, call, panel and decision the visitor sees
 * is a re-run of a genuine Jev session (no fallback rules involved).
 */
import { JevClient, type JevResponse } from './judge';

export interface SessionEntry {
  seq: number;
  reqStep: number;
  applyStep: number;
  hash: string;
  latencyMs: number;
  response: JevResponse;
}

export interface DemoSession {
  version: 1;
  kind: 'demo';
  recordedAt: string;
  model: string;
  seed: number;
  drones: number;
  entries: SessionEntry[];
  /** Fingerprint of the final simulation state (tests assert the replay reproduces it). */
  finalFingerprint: string;
  inputTokens: number;
}

/** FNV-1a over the request, to detect a replay drifting away from the recording. */
export function hashRequest(state: unknown, questions: unknown): string {
  const s = JSON.stringify({ state, questions });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Run fn in a new macrotask (after all pending microtasks). MessageChannel avoids background-tab timer throttling. */
function nextTask(fn: () => void): void {
  if (typeof MessageChannel === 'undefined') {
    setTimeout(fn, 0);
    return;
  }
  const ch = new MessageChannel();
  ch.port1.onmessage = () => {
    ch.port1.close();
    fn();
  };
  ch.port2.postMessage(null);
}

type Ask = (state: unknown, questions: Record<string, unknown>) => Promise<JevResponse>;

/** Wraps a real Jev client and records every answer with the step at which it arrived. */
export class RecordingClient extends JevClient {
  entries: SessionEntry[] = [];
  private seq = 0;

  constructor(private inner: Ask, private stepOf: () => number) {
    super();
    this.configured = this.connected = true;
  }

  override async init(): Promise<void> {}

  override async ask(state: unknown, questions: Record<string, unknown>): Promise<JevResponse> {
    const seq = this.seq++;
    const reqStep = this.stepOf();
    const t0 = performance.now();
    const response = await this.inner(state, questions);
    this.calls++;
    this.inputTokens += response.usage?.input_tokens ?? 0;
    this.entries.push({ seq, reqStep, applyStep: this.stepOf(), hash: hashRequest(state, questions), latencyMs: performance.now() - t0, response });
    return response;
  }

  sorted(): SessionEntry[] {
    return [...this.entries].sort((a, b) => a.seq - b.seq);
  }
}

/** Serves recorded answers; the simulation's gate releases each one at its recorded step. */
export class ReplayClient extends JevClient {
  diverged = 0;
  /** First request that did not match the recording (diagnostics). */
  firstDivergence: { seq: number; step: number; recordedStep: number; state: unknown } | null = null;
  private lastStep = 0;
  /** True from releasing an answer until the next task: its consumers must apply it before stepping on. */
  private blocked = false;
  private seq = 0;
  private pending: { e: SessionEntry; resolve: (r: JevResponse) => void }[] = [];
  private bySeq: Map<number, SessionEntry>;

  constructor(readonly session: DemoSession) {
    super();
    this.configured = this.connected = true;
    this.bySeq = new Map(session.entries.map((e) => [e.seq, e]));
  }

  override async init(): Promise<void> {}

  override ask(state: unknown, questions: Record<string, unknown>): Promise<JevResponse> {
    const e = this.bySeq.get(this.seq++);
    if (!e) return Promise.reject(new Error('end of recording'));
    if (e.hash !== hashRequest(state, questions)) {
      this.diverged++;
      this.firstDivergence ??= { seq: e.seq, step: this.lastStep, recordedStep: e.reqStep, state };
    }
    this.calls++;
    this.inputTokens += e.response.usage?.input_tokens ?? 0;
    return new Promise((resolve) => this.pending.push({ e, resolve }));
  }

  /** Called before each simulation step; true = an answer was released (stop stepping this frame). */
  gate(stepCount: number): boolean {
    this.lastStep = stepCount;
    if (this.blocked) return true;
    const due = this.pending.filter((p) => p.e.applyStep <= stepCount);
    if (!due.length) return false;
    this.pending = this.pending.filter((p) => !due.includes(p));
    for (const p of due) p.resolve(p.e.response);
    // Hold stepping until every promise continuation (microtasks) has run, whatever the caller's frame loop.
    this.blocked = true;
    nextTask(() => (this.blocked = false));
    return true;
  }
}

/** Compact fingerprint of simulation state for record/replay verification. */
export function fingerprint(sim: { t: number; drones: { x: number; z: number }[]; fire: { burning: number[] }; sensors: { detections: { id: string; status: string }[] } }): string {
  const parts = [
    sim.t.toFixed(3),
    ...sim.drones.map((d) => `${d.x.toFixed(2)},${d.z.toFixed(2)}`),
    `fire${sim.fire.burning.length}`,
    ...sim.sensors.detections.map((d) => `${d.id}:${d.status}`),
  ];
  return hashRequest(parts, null);
}
