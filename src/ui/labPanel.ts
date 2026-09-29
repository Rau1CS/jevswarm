/**
 * Full-screen overlays: the SUPPRESSION LAB (policy comparison on identical seeds) and the
 * platform/agent CATALOGUE with provenance tags and sources.
 */
import { aggregate, POLICIES, runChunked, type PolicyRow, type RunResult } from '../lab/experiment';
import { AGENTS, PICKABLE_AGENTS, PICKABLE_PLATFORMS, PLATFORMS, REFERENCE_SYSTEMS, SRC, capacity, loadout, type Agent, type P, type Platform } from '../sim/loadout/catalogue';
import type { SuppressionSetup } from '../app/scenarios';
import { esc, money, tag } from './loadoutPanel';

const POLICY_TXT: Record<string, [string, string]> = {
  NONE: ['NO SUPPRESSION', 'Suppression aircraft stay on the pad (baseline).'],
  NEAREST: ['NEAREST-FIRE RULE', 'Each suppression drone attacks the front cell nearest to itself.'],
  COORDINATOR: ['HEURISTIC PLANNER', 'Objectives → urgency rules → allocation. Rule-based on purpose: this tool compares physics & logistics, not Jev.'],
};

export class SupOverlay {
  private root = document.getElementById('sup-overlay')!;
  private run = 0;

  close(): void {
    this.run++;
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
  }

  private shell(title: string, sub: string, body: string): void {
    this.root.innerHTML = `<div class="so-card"><div class="so-head"><div><div class="so-title">${title}</div><div class="so-sub">${sub}</div></div><button class="so-x" title="Close">✕</button></div><div class="so-body">${body}</div></div>`;
    this.root.classList.remove('hidden');
    this.root.querySelector('.so-x')!.addEventListener('click', () => this.close());
    this.root.onclick = (e) => { if (e.target === this.root) this.close(); };
  }

  // ───────────── Lab ─────────────

  openLab(setup: SuppressionSetup, drones: number): void {
    const concept = setup.platform === 'CONCEPT120';
    const lo = loadout(setup.platform, concept ? 'ABSTRACT' : setup.agent);
    const desc = `${lo.platform.name} · ${lo.agent.name} · ${setup.scenario === 'INITIAL_ATTACK' ? 'initial attack' : 'established fire'}${setup.forward ? ' · forward refill truck' : ''}`;
    this.shell('SUPPRESSION LAB · PHYSICS TRADE STUDY', `${esc(desc)} · side tool, no AI`, `
      <p class="so-p">Runs the same scenario and seeds under three tasking policies and compares outcomes. Headless, deterministic fallback coordinator, no random disruption events, paired seeds (common random numbers: every policy faces the same fire until suppression changes it) — <b>Jev is not called here</b> (no token spend); watch Jev live via START SIMULATION.</p>
      <div class="lab-ctl">
        <label>SEEDS <select data-k="seeds"><option>1</option><option selected>3</option><option>5</option></select></label>
        <label>DURATION <select data-k="dur"><option value="300">5 min</option><option value="600" selected>10 min</option><option value="900">15 min</option></select></label>
        <label>DRONES <select data-k="drones">${[10, 24, 50].map((n) => `<option${n === drones ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        ${setup.scenario === 'INITIAL_ATTACK' ? `<label>DETECTION DELAY <select data-k="detect"><option value="30">30 s</option><option value="60" selected>60 s</option><option value="120">2 min</option><option value="240">4 min</option></select></label>
        <label>FUEL DRYNESS <select data-k="dry"><option value="0.2">damp (0.2×)</option><option value="0.45" selected>moderate (0.45×)</option><option value="1">dry (1×)</option></select></label>` : ''}
        <label title="Plain-water application density that knocks down full-intensity flame. The most influential uncalibrated parameter.">KNOCKDOWN DENSITY <select data-k="kd"><option value="0.5">0.5 L/m²</option><option value="1" selected>1 L/m² (test loading)</option><option value="2">2 L/m²</option></select></label>
        <button class="primary" data-a="run">RUN</button>
      </div>
      <div class="lab-prog hidden"><i></i><span></span></div>
      <div class="lab-out"></div>
      <p class="so-note">Model values are SIM/ASSUMPTION and uncalibrated: read results as <i>relative</i> comparisons inside this simulation, not field performance. Costs are placeholder assumptions.</p>`);
    this.root.querySelector('[data-a="run"]')!.addEventListener('click', () => {
      const v = (k: string) => Number((this.root.querySelector(`[data-k="${k}"]`) as HTMLSelectElement | null)?.value ?? NaN);
      const opt = (k: string) => (Number.isFinite(v(k)) ? v(k) : undefined);
      void this.runLab({ ...setup, detectSec: opt('detect'), dryness: opt('dry'), knockdownDensity: opt('kd') }, v('drones'), v('seeds'), v('dur'));
    });
  }

  private async runLab(setup: SuppressionSetup, drones: number, nSeeds: number, dur: number): Promise<void> {
    const id = ++this.run;
    const prog = this.root.querySelector('.lab-prog') as HTMLDivElement;
    const bar = prog.querySelector('i') as HTMLElement, txt = prog.querySelector('span') as HTMLElement;
    const out = this.root.querySelector('.lab-out') as HTMLDivElement;
    prog.classList.remove('hidden');
    const base = (Math.random() * 1e6) | 0;
    const seeds = Array.from({ length: nSeeds }, (_, i) => base + i * 101);
    const jobs = seeds.flatMap((seed) => POLICIES.map((policy) => ({ seed, policy })));
    const results: RunResult[] = [];
    for (let j = 0; j < jobs.length; j++) {
      const { seed, policy } = jobs[j];
      const r = await runChunked(setup, drones, seed, policy, dur, (f) => {
        bar.style.width = `${((j + f) / jobs.length) * 100}%`;
        txt.textContent = `RUN ${j + 1}/${jobs.length} · ${POLICY_TXT[policy][0]} · seed ${seed}`;
      }, () => id !== this.run);
      if (!r) return;
      results.push(r);
      out.innerHTML = this.table(aggregate(results), setup);
    }
    bar.style.width = '100%';
    txt.textContent = `DONE · ${jobs.length} runs · seeds ${seeds.join(', ')}`;
  }

  private table(rows: PolicyRow[], setup: SuppressionSetup): string {
    const maxA = Math.max(0.01, ...rows.map((r) => r.areaHa));
    const unit = setup.platform === 'CONCEPT120' ? 'L' : AGENTS[setup.agent].unit;
    const fmt = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '—');
    const tr = (r: PolicyRow) => `<tr>
      <td><b>${POLICY_TXT[r.policy][0]}</b><div class="muted">${POLICY_TXT[r.policy][1]}</div></td>
      <td><div class="lab-bar"><i style="width:${(r.areaHa / maxA) * 100}%"></i></div>${fmt(r.areaHa, 2)} ha</td>
      <td>${Math.round(r.outRate * 100)}%</td>
      <td>${fmt(r.savedHa, 2)}</td>
      <td>${fmt(r.onTarget)} ${unit}<div class="muted">${Math.round(r.effectivePct * 100)}% effective</div></td>
      <td>${fmt(r.throughputPerMin, 1)}</td>
      <td>${fmt(r.meanCycleSec)} s<div class="muted">queue ${fmt(r.meanQueueSec)} s</div></td>
      <td>${Number.isFinite(r.firstEffectiveSec) ? `${fmt(r.firstEffectiveSec)} s` : '—'}</td>
      <td>${fmt(r.knockdowns)} / ${fmt(r.reignitions)}</td>
      <td>${money(r.costTotal)}<div class="muted">${Number.isFinite(r.costPerHaSaved) ? `${money(r.costPerHaSaved)}/ha saved` : ''}</div></td>
    </tr>`;
    return `<table class="lab-t"><thead><tr><th>POLICY</th><th>AREA BURNED</th><th>FIRE OUT</th><th>SAVED ha</th><th>ON TARGET</th><th>${unit}/min</th><th>CYCLE</th><th>1ST EFFECTIVE</th><th>KNOCK / REIGN</th><th>COST <i class="tag asm">ASSUMPTION</i></th></tr></thead><tbody>${rows.map(tr).join('')}</tbody></table>`;
  }

  // ───────────── Catalogue ─────────────

  openCatalogue(): void {
    const row = (k: string, p: P, unit = '') => `<tr><td>${k}</td><td>${p.v}${unit}${tag(p)}</td><td class="muted">${esc(p.note ?? '')}${p.src ? ` <a href="${p.src}" target="_blank" rel="noopener">source</a>` : ''}</td></tr>`;
    const plat = (pf: Platform) => `<div class="cat-block"><h3>${esc(pf.name)}</h3><div class="muted">${pf.notes.map(esc).join(' ')} · agent per sortie (water): <b>${capacity(loadout(pf.id, pf.id === 'CONCEPT120' ? 'ABSTRACT' : 'WATER')).toFixed(1)} L</b></div>
      <table class="cat-t">${row('Payload allowance', pf.payloadKg, ' kg')}${row('Dispenser hardware', pf.dispenserKg, ' kg')}${row('Endurance', pf.enduranceMin, ' min')}${row('Max speed', pf.maxSpeed, ' m/s')}${row('Refill pump', pf.pumpLps, ' L/s')}${row('Discharge rate', pf.dischargeLps, ' L/s')}${row('Aim (landing fraction, calm)', pf.aim)}${row('Unit cost', pf.unitCost, ' $')}${row('Service life', pf.lifeHours, ' h')}${row('Operating cost', pf.opsPerHour, ' $/h')}</table></div>`;
    const agent = (a: Agent) => `<div class="cat-block"><h3>${esc(a.name)} <span class="muted">· ${a.mission === 'PRETREAT' ? 'treat fuel ahead of the fire' : 'direct attack'} · refill: ${a.refill === 'STATION' ? 'mixing station' : 'lake or station'}</span></h3>
      <table class="cat-t">${row('Density', a.density, ` kg/${a.unit === 'kg' ? 'kg' : 'L'}`)}${row('Landing (drift/cohesion)', a.landing, '×')}${row('Contact efficiency', a.contact, '×')}${row('Water content', a.water, '×')}${row('Water retention', a.retention, '×')}${row('Retardant salts', a.salts, '×')}${row('Residual heat after knockdown', a.residualHeat)}${row('Cost', a.cost, ` $/${a.unit}`)}</table>
      ${a.notes.map((n) => `<div class="cat-note">${esc(n)}</div>`).join('')}</div>`;
    this.shell('PLATFORM &amp; SUPPRESSANT CATALOGUE', 'Every value is tagged: PUBLIC (sourced) · SIM (model assumption, uncalibrated) · CONCEPT (hypothetical class) · ASSUMPTION (placeholder, mostly costs)', `
      <div class="cat-principle">Liquid carried → agent reaching the fuel → suppression achieved: three different quantities. Foam expansion is <b>not</b> an extinguishing multiplier — capacity and cooling come from the liquid carried. Agent capacity = (payload − dispenser hardware) ÷ density.</div>
      <h2>PLATFORMS</h2>${PICKABLE_PLATFORMS.map((id) => plat(PLATFORMS[id])).join('')}
      <h2>SUPPRESSANTS</h2>${PICKABLE_AGENTS.map((id) => agent(AGENTS[id])).join('')}
      <h2>MODEL</h2><div class="cat-block muted">Knockdown needs ~1 L/m² of plain water at full intensity (the research worked example's <i>test loading</i>, SIM), divided by the agent's contact efficiency. Drops are far smaller than a 15.6 m fire cell, so treatment accumulates as sub-cell coverage that dries out; knocked-down fuel keeps residual heat and can rekindle unless cooled. Retardant reduces spread with dose (half effect at 0.8 L/m², max 85 %) and never makes fuel nonflammable. Spread model is a SIM cellular automaton, not <a href="${SRC.rothermel}" target="_blank" rel="noopener">Rothermel</a>. See docs/SUPPRESSION_MODEL.md.</div>
      <h2>REFERENCE SYSTEMS</h2>${REFERENCE_SYSTEMS.map((r) => `<div class="cat-ref"><b>${esc(r.name)}</b> — ${esc(r.what)} <a href="${r.src}" target="_blank" rel="noopener">source</a></div>`).join('')}`);
  }
}
