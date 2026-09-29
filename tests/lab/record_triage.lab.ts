/** Records a triage-console session with REAL Jev → public/recordings/triage-session.json (no tweet text stored). */
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { FEEDS, shuffled } from '../../src/triage/feed';
import { TriageEngine } from '../../src/triage/engine';
import { qkeysOf, type TriageAnswer, type TriageEvent, type TriageSession } from '../../src/triage/session';
import type { JevResponse } from '../../src/jev/judge';

const key = readFileSync('.env.local', 'utf8').split(/\r?\n/).find((l) => l.startsWith('TYPESAFE_API_KEY='))!.split('=')[1].trim().replace(/^"|"$/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROAD = 'Does this message say a road, highway or bridge is closed or blocked?';

it('record triage session with live Jev', { timeout: 600000 }, async () => {
  const feed = shuffled(await FEEDS[0].load());
  const idOf = new Map(feed.map((m) => [m.text, m.id]));
  const answers: TriageAnswer[] = [];
  const events: TriageEvent[] = [];
  let tokens = 0;
  const t0 = performance.now();
  const engine = new TriageEngine(async (state, questions) => {
    const s = performance.now();
    const r = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions }) });
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as JevResponse;
    tokens += j.usage?.input_tokens ?? 0;
    answers.push({ id: idOf.get((state as { message: string }).message)!, qkeys: qkeysOf(questions), latencyMs: Math.round(performance.now() - s), response: j });
    return j as never;
  });
  engine.budgetUsd = 1;
  for (let i = 0; i < 48; i++) {
    if (i === 18) {
      events.push({ atMs: Math.round(performance.now() - t0), type: 'question', text: ROAD });
      const q = engine.addQuestion(ROAD);
      engine.backfill(q.id);
    }
    events.push({ atMs: Math.round(performance.now() - t0), type: 'msg', id: feed[i].id });
    engine.ingest(feed[i]);
    await sleep(900);
  }
  while (engine.backlog) await sleep(200);
  const session: TriageSession = { version: 1, kind: 'triage', feed: FEEDS[0].id, recordedAt: new Date().toISOString(), model: answers[0]?.response.model ?? 'jev', events, answers, inputTokens: tokens };
  writeFileSync('public/recordings/triage-session.json', JSON.stringify(session));
  const done = engine.items.filter((it) => it.status === 'DONE');
  const agree = done.filter((it) => it.category === it.msg.human.category).length;
  console.log(`recorded ${answers.length} answers · ${tokens} tokens · agreement ${agree}/${done.length}`);
});
