/**
 * Triage engine: every incoming message gets ONE Jev request (speculative fan-out) with a
 * Choice over the humanitarian taxonomy plus one Noul per standing question. The commander
 * can add questions in plain language at any time; they apply to new messages and can be
 * back-filled over the messages already seen. Routing policy (thresholds) stays in code.
 * Wording mirrors research/triage (benchmarked on real wildfire data).
 */
import type { FeedMessage } from './feed';

export const PRICE_PER_M_TOKENS = 0.042; // $ per million input tokens, jev-1.13.0 (docs.typesafe.ai/models)

export const CATEGORIES: Record<string, string> = {
  caution_and_advice: 'Warnings, safety advice, advisories or instructions about the disaster',
  displaced_people_and_evacuations: 'People evacuated, displaced, relocated, or in shelters; evacuation orders',
  infrastructure_and_utility_damage: 'Damage to buildings, homes, roads, bridges, power lines, water or other utilities',
  injured_or_dead_people: 'Reports of people injured or killed, casualty counts',
  missing_or_found_people: 'People reported missing, or missing people who were found',
  not_humanitarian: "Not about the disaster's humanitarian impact, or unrelated/irrelevant",
  other_relevant_information: 'Other useful information about the disaster not covered by the other categories',
  requests_or_urgent_needs: 'Requests for help or urgent needs: food, water, shelter, medical help, rescue, supplies',
  rescue_volunteering_or_donation_effort: 'Rescue operations, volunteering, fundraising or donations of money or goods',
  sympathy_and_support: 'Prayers, thoughts, condolences, emotional support',
};

/** Operational lanes a routed message lands in. */
export const LANES: { id: string; name: string; cats: string[] }[] = [
  { id: 'NEEDS', name: 'Needs & missing people', cats: ['requests_or_urgent_needs', 'missing_or_found_people'] },
  { id: 'CASUALTIES', name: 'Casualties', cats: ['injured_or_dead_people'] },
  { id: 'DAMAGE', name: 'Damage', cats: ['infrastructure_and_utility_damage'] },
  { id: 'EVAC', name: 'Evacuations', cats: ['displaced_people_and_evacuations'] },
  { id: 'ADVICE', name: 'Warnings & advice', cats: ['caution_and_advice'] },
  { id: 'HELP', name: 'Donations & volunteers', cats: ['rescue_volunteering_or_donation_effort'] },
  { id: 'INFO', name: 'Other information', cats: ['other_relevant_information'] },
  { id: 'NOISE', name: 'Noise & sympathy', cats: ['not_humanitarian', 'sympathy_and_support'] },
];

export interface Question { id: string; text: string; builtin: boolean }

export const DEFAULT_QUESTIONS: Question[] = [
  { id: 'needs_help', builtin: true, text: 'Does this message request help or supplies for people affected by the disaster, or describe their urgent needs such as food, water, shelter, medical care or rescue?' },
  { id: 'people', builtin: true, text: 'Does this message report on people injured, killed, missing or found in the disaster, including casualty counts, death tolls, or news about the search for missing people?' },
  { id: 'damage', builtin: true, text: 'Does this message report damage to or destruction of homes, buildings, structures, roads, power lines, water supply or other infrastructure?' },
  { id: 'evacuation', builtin: true, text: 'Is this message about evacuations, evacuation orders, evacuees, or people who were displaced, lost their homes, or are staying in shelters?' },
  { id: 'eyewitness', builtin: true, text: 'Was this message written by someone who is personally at the scene of the fire — directly seeing, hearing or experiencing it, or affected on the ground — rather than by news media, officials, organisations, businesses, or people following it from elsewhere?' },
];

export const SHORT: Record<string, string> = { needs_help: 'NEEDS HELP', people: 'PEOPLE', damage: 'DAMAGE', evacuation: 'EVACUATION', eyewitness: 'EYEWITNESS' };

export interface Triaged {
  msg: FeedMessage;
  seq: number;
  status: 'PENDING' | 'DONE' | 'ERROR';
  category?: string;
  catProb?: number;
  catConf?: number;
  q: Record<string, number>;
  ms?: number;
  tokens?: number;
  error?: string;
}

export interface EngineStats { done: number; errors: number; tokens: number; msSum: number; ms: number[] }

type Ask = (state: unknown, questions: Record<string, unknown>) => Promise<{ answers: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }>; usage?: { input_tokens: number } }>;

export class TriageEngine {
  questions: Question[] = DEFAULT_QUESTIONS.map((q) => ({ ...q }));
  items: Triaged[] = [];
  stats: EngineStats = { done: 0, errors: 0, tokens: 0, msSum: 0, ms: [] };
  budgetUsd = 0.05;
  concurrency = 6;
  onChange: () => void = () => {};
  private inflight = 0;
  private queue: (() => Promise<void>)[] = [];
  private seq = 0;
  private customN = 0;

  constructor(private ask: Ask) {}

  get spentUsd(): number {
    return (this.stats.tokens * PRICE_PER_M_TOKENS) / 1e6;
  }
  get overBudget(): boolean {
    return this.spentUsd >= this.budgetUsd;
  }

  /** Commander adds a question in plain language; returns its id. */
  addQuestion(text: string): Question {
    const q = { id: `c${++this.customN}`, text: text.trim(), builtin: false };
    this.questions.push(q);
    this.onChange();
    return q;
  }

  removeQuestion(id: string): void {
    this.questions = this.questions.filter((q) => q.id !== id);
    for (const it of this.items) delete it.q[id];
    this.onChange();
  }

  /** New message arrives: queue one fan-out request (category + all standing questions). */
  ingest(msg: FeedMessage): Triaged {
    const it: Triaged = { msg, seq: ++this.seq, status: 'PENDING', q: {} };
    this.items.unshift(it);
    if (this.items.length > 600) this.items.pop();
    const qs = [...this.questions];
    this.enqueue(async () => {
      const questions: Record<string, unknown> = {
        category: { type: 'choice', instructions: 'Which humanitarian category best describes this social-media message posted during a wildfire disaster?', criteria: CATEGORIES },
      };
      for (const q of qs) questions[`q.${q.id}`] = { type: 'noul', instructions: q.text };
      await this.run(it, questions, (a) => {
        const c = a.category;
        it.category = c?.choice;
        it.catProb = c?.probabilities?.[c.choice ?? ''] ?? c?.confidence;
        it.catConf = c?.confidence;
        for (const q of qs) if (a[`q.${q.id}`]) it.q[q.id] = a[`q.${q.id}`].noul ?? 0;
      });
    });
    return it;
  }

  /** Ask one question of every message already triaged (e.g. a question added mid-incident). */
  backfill(qid: string): number {
    const q = this.questions.find((x) => x.id === qid);
    if (!q) return 0;
    const targets = this.items.filter((it) => it.status === 'DONE' && it.q[qid] === undefined);
    for (const it of targets) {
      this.enqueue(() => this.run(it, { [`q.${qid}`]: { type: 'noul', instructions: q.text } }, (a) => {
        if (a[`q.${qid}`]) it.q[qid] = a[`q.${qid}`].noul ?? 0;
      }, false));
    }
    return targets.length;
  }

  private async run(it: Triaged, questions: Record<string, unknown>, apply: (a: Awaited<ReturnType<Ask>>['answers']) => void, main = true): Promise<void> {
    if (this.overBudget) {
      if (main) { it.status = 'ERROR'; it.error = 'budget reached'; }
      return;
    }
    const t0 = performance.now();
    try {
      const r = await this.ask({ message: it.msg.text }, questions);
      apply(r.answers);
      const ms = performance.now() - t0;
      const tok = r.usage?.input_tokens ?? 0;
      this.stats.tokens += tok;
      if (main) {
        it.status = 'DONE';
        it.ms = ms;
        it.tokens = tok;
        this.stats.done++;
        this.stats.msSum += ms;
        this.stats.ms.push(ms);
        if (this.stats.ms.length > 400) this.stats.ms.shift();
      }
    } catch (e) {
      if (main) { it.status = 'ERROR'; it.error = String(e instanceof Error ? e.message : e).slice(0, 80); this.stats.errors++; }
    }
    this.onChange();
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.inflight < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.inflight++;
      job().finally(() => { this.inflight--; this.pump(); });
    }
  }

  get backlog(): number {
    return this.queue.length + this.inflight;
  }

  /** Route: confident category → its lane; otherwise human review. */
  laneOf(it: Triaged, threshold: number): string | null {
    if (it.status !== 'DONE' || !it.category) return null;
    if ((it.catProb ?? 0) < threshold) return 'REVIEW';
    return LANES.find((l) => l.cats.includes(it.category!))?.id ?? 'INFO';
  }
}
