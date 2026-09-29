/**
 * Recorded triage sessions: real Jev answers for a replayed stream of real messages. Only message
 * ids are stored (the tweet text is loaded from its public source at runtime), plus Jev's answers,
 * their latency and the commander's questions with timings.
 */
import type { JevResponse } from '../jev/judge';
import type { Ask } from './engine';

export type TriageEvent = { atMs: number; type: 'msg'; id: string } | { atMs: number; type: 'question'; text: string };

export interface TriageAnswer { id: string; qkeys: string; latencyMs: number; response: JevResponse }

export interface TriageSession {
  version: 1;
  kind: 'triage';
  feed: string;
  recordedAt: string;
  model: string;
  events: TriageEvent[];
  answers: TriageAnswer[];
  inputTokens: number;
}

export const qkeysOf = (questions: Record<string, unknown>) => Object.keys(questions).sort().join('|');

/** Serves recorded answers (with their recorded latency) for the same messages and questions. */
export function replayAsk(session: TriageSession, idOfText: (text: string) => string | undefined): Ask {
  const byKey = new Map(session.answers.map((a) => [`${a.id}#${a.qkeys}`, a]));
  return (state, questions) => {
    const id = idOfText((state as { message: string }).message);
    const a = id ? byKey.get(`${id}#${qkeysOf(questions)}`) : undefined;
    if (!a) return Promise.reject(new Error('not in recording'));
    return new Promise((resolve) => setTimeout(() => resolve(a.response as never), a.latencyMs));
  };
}
