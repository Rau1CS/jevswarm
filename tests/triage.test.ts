import { describe, expect, it } from 'vitest';
import { TriageEngine } from '../src/triage/engine';
import { parseCsv, shuffled } from '../src/triage/feed';

const msg = (id: string, text: string) => ({ id, text, human: { category: 'requests_or_urgent_needs' } });
const flush = () => new Promise((r) => setTimeout(r, 0));

function mockAsk() {
  const calls: { questions: Record<string, { type: string }> }[] = [];
  const ask = async (_state: unknown, questions: Record<string, unknown>) => {
    calls.push({ questions: questions as never });
    const answers: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }> = {};
    for (const [k, q] of Object.entries(questions)) {
      if ((q as { type: string }).type === 'choice') answers[k] = { choice: 'requests_or_urgent_needs', confidence: 0.9, probabilities: { requests_or_urgent_needs: 0.9 } };
      else answers[k] = { noul: 0.7 };
    }
    return { answers, usage: { input_tokens: 800 } };
  };
  return { ask, calls };
}

describe('TriageEngine', () => {
  it('asks the category plus every standing question in ONE request per message', async () => {
    const { ask, calls } = mockAsk();
    const e = new TriageEngine(ask);
    e.ingest(msg('a', 'We need water at the shelter'));
    await flush();
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions)).toEqual(['category', ...e.questions.map((q) => `q.${q.id}`)]);
    const it0 = e.items[0];
    expect(it0.status).toBe('DONE');
    expect(it0.category).toBe('requests_or_urgent_needs');
    expect(e.laneOf(it0, 0.8)).toBe('NEEDS');
    expect(e.laneOf(it0, 0.95)).toBe('REVIEW');
  });

  it('commander questions apply to new messages and can be back-filled over earlier ones', async () => {
    const { ask, calls } = mockAsk();
    const e = new TriageEngine(ask);
    e.ingest(msg('a', 'one'));
    await flush();
    const q = e.addQuestion('Does this message say a road is closed?');
    expect(e.backfill(q.id)).toBe(1);
    await flush();
    expect(Object.keys(calls[1].questions)).toEqual([`q.${q.id}`]); // back-fill asks only the new question
    expect(e.items[0].q[q.id]).toBeCloseTo(0.7);
    e.ingest(msg('b', 'two'));
    await flush();
    expect(Object.keys(calls[2].questions)).toContain(`q.${q.id}`);
  });

  it('stops spending at the session budget', async () => {
    const { ask, calls } = mockAsk();
    const e = new TriageEngine(ask);
    e.budgetUsd = (800 * 0.042) / 1e6; // exactly one request
    e.ingest(msg('a', 'one'));
    await flush();
    e.ingest(msg('b', 'two'));
    await flush();
    expect(calls).toHaveLength(1);
    expect(e.items[0].status).toBe('ERROR');
    expect(e.spentUsd).toBeCloseTo((800 * 0.042) / 1e6);
  });
});

describe('feed helpers', () => {
  it('parses quoted CSV with commas, doubled quotes and newlines', () => {
    const rows = parseCsv('Tweet ID,Tweet Text,Information Source\n1,"Fire, near ""Oak"" St\nsend help",Eyewitness\r\n2,plain,Media\n');
    expect(rows[1]).toEqual(['1', 'Fire, near "Oak" St\nsend help', 'Eyewitness']);
    expect(rows[2]).toEqual(['2', 'plain', 'Media']);
  });
  it('shuffles deterministically without losing items', () => {
    const a = shuffled([1, 2, 3, 4, 5, 6], 7);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(shuffled([1, 2, 3, 4, 5, 6], 7)).toEqual(a);
  });
});
