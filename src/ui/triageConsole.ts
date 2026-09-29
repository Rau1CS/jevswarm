/**
 * MESSAGE TRIAGE console: a live stream of real wildfire messages, triaged by Jev.
 * The commander can type new questions mid-incident; confident answers are auto-routed,
 * uncertain ones go to human review. Human labels from the dataset are shown for honesty.
 */
import { JevClient } from '../jev/judge';
import { LANES, PRICE_PER_M_TOKENS, SHORT, TriageEngine, type Triaged } from '../triage/engine';
import { FEEDS, shuffled, type FeedMessage } from '../triage/feed';
import { esc, money } from './loadoutPanel';
import { replayAsk, type TriageSession } from '../triage/session';

const SUGGEST = [
  'Does this message say a road, highway or bridge is closed or blocked?',
  'Is someone asking about a missing pet or animals that need rescue?',
  'Does this message name a specific street, neighbourhood or town that is affected?',
  'Does this message spread a rumour or an unverified claim?',
  'Is this an official update from a fire agency, sheriff or government body?',
];
const CAT_SHORT = (c?: string) => (c ? c.replace(/_/g, ' ').replace('and utility', '').replace('or urgent', '/').toUpperCase() : '…');

export class TriageConsole {
  private root = document.getElementById('triage')!;
  private client = new JevClient();
  private engine: TriageEngine = new TriageEngine((state, questions) => this.client.ask(state, questions) as never);
  private feed: FeedMessage[] = [];
  private cursor = 0;
  private timer = 0;
  private running = false;
  private rate = 1;
  private threshold = 0.8;
  private sortBy = 'needs_help';
  private laneFilter: string | null = null;
  private dirty = false;
  private feedId = FEEDS[0].id;
  private loading = false;

  constructor() {
    this.engine.onChange = () => this.markDirty();
  }

  /** Without a key the console plays a recorded real Jev session instead of running live. */
  private recorded: TriageSession | null = null;
  private replayTimers: number[] = [];
  private get replayMode(): boolean {
    return !this.client.configured;
  }

  async open(): Promise<void> {
    this.root.classList.remove('hidden');
    this.feedId = FEEDS[0].id;
    this.shell();
    await this.client.init();
    await this.loadFeed();
    this.root.querySelectorAll<HTMLElement>('[data-k="feed"], [data-k="rate"], [data-k="budget"], .tc-add input, .tc-add button, .tc-sugg button')
      .forEach((el) => ((el as HTMLInputElement).disabled = this.replayMode));
    this.markDirty();
  }

  close(): void {
    this.pause();
    this.root.classList.add('hidden');
  }

  private replayNotice(): string {
    const s = this.recorded;
    return `Recorded real Jev session${s ? ` (${s.recordedAt.slice(0, 10)}, ${s.model})` : ''}: the same messages, questions and Jev answers, replayed with their original timing. Add your Jev key on the title screen to run it live and ask your own questions.`;
  }

  /** Replay a recorded session: messages and commander questions at their recorded times. */
  private async playRecording(): Promise<void> {
    try {
      this.recorded ??= (await (await fetch('/recordings/triage-session.json')).json()) as TriageSession;
    } catch {
      this.notice('Could not load the recorded session.');
      return;
    }
    const s = this.recorded;
    const byId = new Map(this.feed.map((m) => [m.id, m]));
    const idOfText = new Map(this.feed.map((m) => [m.text, m.id]));
    this.engine = new TriageEngine(replayAsk(s, (t) => idOfText.get(t)));
    this.engine.budgetUsd = 1;
    this.engine.onChange = () => this.markDirty();
    this.running = true;
    this.notice(this.replayNotice());
    for (const ev of s.events) {
      this.replayTimers.push(window.setTimeout(() => {
        if (ev.type === 'question') {
          const q = this.engine.addQuestion(ev.text);
          this.engine.backfill(q.id);
          this.sortBy = q.id;
        } else {
          const m = byId.get(ev.id);
          if (m) { this.engine.ingest(m); this.cursor++; }
        }
      }, ev.atMs));
    }
    const end = (s.events[s.events.length - 1]?.atMs ?? 0) + 4000;
    this.replayTimers.push(window.setTimeout(() => { this.running = false; this.markDirty(); }, end));
    this.markDirty();
  }

  private notice(t: string): void {
    const n = this.root.querySelector('.tc-notice') as HTMLElement;
    n.textContent = t;
    n.classList.toggle('hidden', !t);
  }

  private async loadFeed(): Promise<void> {
    const src = FEEDS.find((f) => f.id === this.feedId)!;
    this.loading = true;
    this.notice(`Loading ${src.name} from ${src.dataset}…`);
    try {
      this.feed = shuffled(await src.load());
      this.cursor = 0;
      this.notice(this.client.configured ? '' : this.replayNotice());
    } catch {
      this.notice(`Could not load ${src.name}. Check the network connection.`);
    }
    this.loading = false;
    this.markDirty();
  }

  private start(): void {
    if (this.loading) return;
    if (this.replayMode) {
      this.cursor = 0;
      void this.playRecording();
      return;
    }
    this.running = true;
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 1000 / this.rate);
    this.markDirty();
  }

  private pause(): void {
    this.running = false;
    clearInterval(this.timer);
    this.replayTimers.forEach((t) => clearTimeout(t));
    this.replayTimers = [];
    this.markDirty();
  }

  private tick(): void {
    if (this.engine.overBudget) {
      this.pause();
      this.notice(`Session budget of ${money(this.engine.budgetUsd)} reached. Raise it to continue.`);
      return;
    }
    if (this.engine.backlog > 24) return; // don't outrun the API; the stream waits
    const m = this.feed[this.cursor++];
    if (!m) { this.pause(); this.notice('End of this incident’s messages.'); return; }
    this.engine.ingest(m);
  }

  private markDirty(): void {
    if (this.dirty) return;
    this.dirty = true;
    // A short timer (not rAF) so the console keeps updating in a background tab.
    setTimeout(() => { this.dirty = false; this.render(); }, 120);
  }

  private shell(): void {
    this.root.innerHTML = `
      <div class="tc-top">
        <div class="tc-title">MESSAGE TRIAGE <span>// JEV</span><small>real wildfire messages · human labels shown for comparison · powered by <a href="https://typesafe.ai" target="_blank" rel="noopener">TypeSafe Jev</a></small></div>
        <div class="tc-ctl">
          <select data-k="feed">${FEEDS.map((f) => `<option value="${f.id}">${esc(f.name)} · ${esc(f.dataset)}</option>`).join('')}</select>
          <select data-k="rate"><option value="0.5">0.5 msg/s</option><option value="1" selected>1 msg/s</option><option value="2">2 msg/s</option><option value="5">5 msg/s</option></select>
          <label>BUDGET <select data-k="budget"><option value="0.02">$0.02</option><option value="0.05" selected>$0.05</option><option value="0.2">$0.20</option></select></label>
          <button data-a="run" class="primary">START STREAM</button>
          <button data-a="close" class="ghost">✕</button>
        </div>
      </div>
      <div class="tc-notice hidden"></div>
      <div class="tc-stats"></div>
      <div class="tc-main">
        <section class="tc-feed"></section>
        <section class="tc-q">
          <h3>COMMANDER QUESTIONS <small>asked of every message · one request each</small></h3>
          <div class="tc-qlist"></div>
          <form class="tc-add"><input maxlength="220" placeholder="Ask a new question in plain English…" /><button>ADD</button></form>
          <div class="tc-hint">Jev reads questions literally — say exactly what counts (e.g. “including death tolls”).</div>
          <div class="tc-sugg">${SUGGEST.map((s) => `<button type="button">${esc(s)}</button>`).join('')}</div>
        </section>
        <section class="tc-route">
          <h3>ROUTING <small>auto-route when category probability ≥ <b class="thr"></b></small></h3>
          <input type="range" min="0.5" max="0.98" step="0.02" value="${this.threshold}" data-k="thr" />
          <div class="tc-lanes"></div>
          <h3>PRIORITY INBOX <small>highest “<span class="sortq"></span>” first</small></h3>
          <div class="tc-inbox"></div>
        </section>
      </div>`;
    const $ = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    $('[data-a="close"]').addEventListener('click', () => this.close());
    $('[data-a="run"]').addEventListener('click', () => (this.running ? this.pause() : this.start()));
    $<HTMLSelectElement>('[data-k="rate"]').addEventListener('change', (e) => {
      this.rate = Number((e.target as HTMLSelectElement).value);
      if (this.running) this.start();
    });
    $<HTMLSelectElement>('[data-k="budget"]').addEventListener('change', (e) => (this.engine.budgetUsd = Number((e.target as HTMLSelectElement).value)));
    $<HTMLSelectElement>('[data-k="feed"]').addEventListener('change', (e) => {
      this.pause();
      this.feedId = (e.target as HTMLSelectElement).value;
      this.engine.items = [];
      void this.loadFeed();
    });
    $<HTMLInputElement>('[data-k="thr"]').addEventListener('input', (e) => { this.threshold = Number((e.target as HTMLInputElement).value); this.markDirty(); });
    const add = $<HTMLFormElement>('.tc-add');
    add.addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = add.querySelector('input')!;
      if (inp.value.trim().length < 8) return;
      const q = this.engine.addQuestion(inp.value);
      this.sortBy = q.id;
      inp.value = '';
    });
    this.root.querySelectorAll('.tc-sugg button').forEach((b) => b.addEventListener('click', () => {
      (add.querySelector('input') as HTMLInputElement).value = b.textContent ?? '';
    }));
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const qid = t.closest<HTMLElement>('[data-sort]')?.dataset.sort;
      if (t.dataset.rm) this.engine.removeQuestion(t.dataset.rm);
      else if (t.dataset.fill) {
        const n = this.engine.backfill(t.dataset.fill);
        this.notice(n ? `Asking “${this.engine.questions.find((q) => q.id === t.dataset.fill)?.text.slice(0, 60)}…” of ${n} earlier messages.` : '');
      } else if (qid) { this.sortBy = qid; this.markDirty(); }
      const lane = t.closest<HTMLElement>('[data-lane]')?.dataset.lane;
      if (lane) { this.laneFilter = this.laneFilter === lane ? null : lane; this.markDirty(); }
    });
  }

  private render(): void {
    const e = this.engine, r = this.root;
    const q = (s: string) => r.querySelector(s) as HTMLElement;
    q('[data-a="run"]').textContent = this.replayMode ? (this.running ? 'STOP' : 'PLAY RECORDED SESSION') : this.running ? 'PAUSE' : this.cursor ? 'RESUME' : 'START STREAM';
    q('.thr').textContent = this.threshold.toFixed(2);
    q('.sortq').textContent = SHORT[this.sortBy] ?? e.questions.find((x) => x.id === this.sortBy)?.text.slice(0, 40) ?? '';
    const done = e.items.filter((it) => it.status === 'DONE');
    const ms = [...e.stats.ms].sort((a, b) => a - b);
    const p50 = ms.length ? ms[Math.floor(ms.length / 2)] : 0;
    const withCat = done.filter((it) => it.msg.human.category);
    const agree = withCat.filter((it) => it.category === it.msg.human.category).length;
    const eyeFlag = done.filter((it) => (it.q.eyewitness ?? 0) >= 0.5 && it.msg.human.source);
    const eyeHit = eyeFlag.filter((it) => it.msg.human.source === 'Eyewitness').length;
    const routed = done.filter((it) => e.laneOf(it, this.threshold) !== 'REVIEW').length;
    const stat = (k: string, v: string, s = '') => `<div><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
    q('.tc-stats').innerHTML = [
      stat('MESSAGES TRIAGED', `${e.stats.done}`, `${this.feed.length ? `${this.cursor} / ${this.feed.length} streamed` : 'loading…'} · backlog ${e.backlog}`),
      stat('JUDGMENTS', `${done.reduce((n, it) => n + 1 + Object.keys(it.q).length, 0)}`, `${e.questions.length + 1} per message now, one request`),
      stat('LATENCY p50', p50 ? `${Math.round(p50)} ms` : '—'),
      stat('AUTO-ROUTED', done.length ? `${Math.round((routed / done.length) * 100)}%` : '—', `rest → human review`),
      withCat.length ? stat('AGREES WITH HUMAN LABEL', `${Math.round((agree / withCat.length) * 100)}%`, `category, n=${withCat.length}`) :
        stat('EYEWITNESS FLAGS', eyeFlag.length ? `${Math.round((eyeHit / eyeFlag.length) * 100)}%` : '—', `human-labelled eyewitness, n=${eyeFlag.length}`),
      stat('COST', `$${e.spentUsd < 0.01 ? e.spentUsd.toFixed(4) : e.spentUsd.toFixed(2)}`, `${e.stats.tokens.toLocaleString()} tokens · ${money((PRICE_PER_M_TOKENS * 1000 * (e.stats.tokens / Math.max(1, e.stats.done))) / 1e6)}/1k msgs`),
    ].join('');

    // Questions.
    q('.tc-qlist').innerHTML = e.questions.map((x) => `
      <div class="tc-qi${this.sortBy === x.id ? ' on' : ''}" data-sort="${x.id}">
        <div class="tc-qn">${esc(SHORT[x.id] ?? `Q${x.id.slice(1)} · COMMANDER`)}</div>
        <div class="tc-qt">${esc(x.text)}</div>
        ${x.builtin ? '' : `<div class="tc-qa"><button type="button" data-fill="${x.id}">ASK EARLIER MESSAGES</button><button type="button" data-rm="${x.id}">REMOVE</button></div>`}
      </div>`).join('');

    // Lanes.
    const counts = new Map<string, number>();
    for (const it of done) { const l = e.laneOf(it, this.threshold)!; counts.set(l, (counts.get(l) ?? 0) + 1); }
    const lane = (id: string, name: string) => `<button class="tc-lane${this.laneFilter === id ? ' on' : ''}${id === 'REVIEW' ? ' rev' : ''}" data-lane="${id}"><span>${name}</span><b>${counts.get(id) ?? 0}</b></button>`;
    q('.tc-lanes').innerHTML = lane('REVIEW', 'Needs human review') + LANES.map((l) => lane(l.id, l.name)).join('');

    // Priority inbox.
    const top = done.filter((it) => it.q[this.sortBy] !== undefined).sort((a, b) => b.q[this.sortBy] - a.q[this.sortBy]).slice(0, 8);
    q('.tc-inbox').innerHTML = top.map((it) => `<div class="tc-ib"><b>${Math.round(it.q[this.sortBy] * 100)}%</b><span>${esc(it.msg.text.slice(0, 120))}</span></div>`).join('') || '<div class="muted">No answers yet.</div>';

    // Feed.
    const shown = e.items.filter((it) => !this.laneFilter || e.laneOf(it, this.threshold) === this.laneFilter).slice(0, 40);
    q('.tc-feed').innerHTML = shown.map((it) => this.card(it)).join('') || `<div class="tc-empty">${this.replayMode ? 'Press PLAY RECORDED SESSION to watch a real Jev triage session.' : 'Press START STREAM to replay the incident’s messages through Jev.'}</div>`;
  }

  private card(it: Triaged): string {
    const e = this.engine;
    const lane = e.laneOf(it, this.threshold);
    const human = it.msg.human.category ? `human: ${it.msg.human.category.replace(/_/g, ' ')}` : it.msg.human.source ? `human: ${it.msg.human.source} · ${it.msg.human.infoType ?? ''}` : '';
    const agree = it.msg.human.category && it.category ? (it.msg.human.category === it.category ? 'agree' : 'differ') : '';
    const bars = e.questions.map((x) => {
      const p = it.q[x.id];
      const cls = p === undefined ? 'na' : p >= 0.5 ? 'yes' : '';
      return `<div class="tc-bar ${cls}" title="${esc(x.text)}"><span>${esc(SHORT[x.id] ?? `Q${x.id.slice(1)}`)}</span><i style="width:${Math.round((p ?? 0) * 100)}%"></i><b>${p === undefined ? '·' : Math.round(p * 100)}</b></div>`;
    }).join('');
    return `<article class="tc-card ${it.status.toLowerCase()}${lane === 'REVIEW' ? ' review' : ''}">
      <div class="tc-meta"><span class="tc-cat">${it.status === 'DONE' ? `${CAT_SHORT(it.category)} · ${Math.round((it.catProb ?? 0) * 100)}%` : it.status === 'ERROR' ? `ERROR · ${esc(it.error ?? '')}` : 'JEV…'}</span>
        <span class="tc-lane-tag">${lane === 'REVIEW' ? 'HUMAN REVIEW' : lane ? LANES.find((l) => l.id === lane)?.name.toUpperCase() : ''}</span>
        <span class="tc-ms">${it.ms ? `${Math.round(it.ms)} ms` : ''}</span></div>
      <p>${esc(it.msg.text)}</p>
      <div class="tc-bars">${bars}</div>
      ${human ? `<div class="tc-human ${agree}">${esc(human)}</div>` : ''}
    </article>`;
  }
}

