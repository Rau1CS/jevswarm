/**
 * Title-screen SUPPRESSION LOADOUT picker: scenario, platform, agent, refill options, with
 * derived capacity and provenance tags. The choice persists per browser (convenience only).
 */
import { AGENTS, PICKABLE_AGENTS, PICKABLE_PLATFORMS, PLATFORMS, capacity, landingFraction, loadout, type P, type Prov } from '../sim/loadout/catalogue';
import type { SuppressionSetup } from '../app/scenarios';

const KEY = 'jev.loadout.v1';
export const DEFAULT_SETUP: SuppressionSetup = { platform: 'HEAVY', agent: 'WATER', scenario: 'INITIAL_ATTACK', forward: false };
const TAGCLS: Record<Prov, string> = { PUBLIC: 'pub', SIM: 'sim', CONCEPT: 'con', ASSUMPTION: 'asm' };
const TAGTXT: Record<Prov, string> = { PUBLIC: 'PUBLIC', SIM: 'SIM', CONCEPT: 'CONCEPT', ASSUMPTION: 'ASSUMPTION' };

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const tag = (p: P<unknown>) => `<i class="tag ${TAGCLS[p.tag]}" title="${esc(p.note ?? '')}">${TAGTXT[p.tag]}</i>`;
export const money = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `$${n.toFixed(n < 10 ? 2 : 0)}`);

export function loadSetup(): SuppressionSetup {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as SuppressionSetup;
      if (PLATFORMS[s.platform] && AGENTS[s.agent]) return { ...DEFAULT_SETUP, ...s };
    }
  } catch { /* storage unavailable: defaults */ }
  return { ...DEFAULT_SETUP };
}

function saveSetup(s: SuppressionSetup): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export class LoadoutPanel {
  setup = loadSetup();
  private root = document.getElementById('loadout')!;
  onLab: () => void = () => {};
  onCatalogue: () => void = () => {};
  onStart: () => void = () => {};
  onCancel: () => void = () => {};

  constructor() {
    this.render();
  }

  private render(): void {
    const s = this.setup;
    const concept = s.platform === 'CONCEPT120';
    const lo = loadout(s.platform, concept ? 'ABSTRACT' : s.agent);
    const pf = lo.platform, ag = lo.agent;
    const cap = capacity(lo);
    const opt = (v: string, label: string, cur: string) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
    const seg = (name: string, v: string, label: string, on: boolean) => `<button type="button" data-seg="${name}" data-v="${v}" class="${on ? 'on' : ''}">${label}</button>`;
    const landing = landingFraction(lo, 3);
    const warn = ag.notes.filter((n) => /jurisdiction|not extinguishment|never guaranteed/i.test(n));
    this.root.innerHTML = `
      <div class="lo-head">FREE SIMULATION SETUP <span class="muted">· runs on live Jev</span></div>
      <div class="lo-intro">Random fire, civilians, emergency calls and disruptions. Pick the scenario and the suppression hardware the drones carry; Jev makes the calls.</div>
      <div class="lo-row"><span class="k">SCENARIO</span><div class="seg">${seg('scenario', 'INITIAL_ATTACK', 'INITIAL ATTACK', s.scenario === 'INITIAL_ATTACK')}${seg('scenario', 'ESTABLISHED', 'ESTABLISHED FIRE', s.scenario === 'ESTABLISHED')}</div></div>
      <div class="lo-row"><span class="k">PLATFORM</span><select data-f="platform">${PICKABLE_PLATFORMS.map((id) => opt(id, PLATFORMS[id].name, s.platform)).join('')}</select></div>
      <div class="lo-row"><span class="k">AGENT</span><select data-f="agent"${concept ? ' disabled' : ''}>${concept ? opt('ABSTRACT', AGENTS.ABSTRACT.name, 'ABSTRACT') : PICKABLE_AGENTS.map((id) => opt(id, AGENTS[id].name, s.agent)).join('')}</select></div>
      <div class="lo-row"><span class="k">REFILL</span><div class="seg">${seg('forward', '0', 'BASE + LAKE', !s.forward)}${seg('forward', '1', '+ FORWARD TRUCK', s.forward)}</div></div>
      <div class="lo-derived">
        <div><span>AGENT PER SORTIE</span><b>${cap.toFixed(cap < 10 ? 1 : 0)} ${ag.unit}</b></div>
        <div class="formula">(${pf.payloadKg.v} kg payload${tag(pf.payloadKg)} − ${pf.dispenserKg.v} kg dispenser${tag(pf.dispenserKg)}) ÷ ${ag.density.v} kg/${ag.unit === 'kg' ? 'kg' : 'L'}${tag(ag.density)}</div>
        <div><span>ON TARGET @ 3 m/s WIND</span><b>${Math.round(landing * 100)}%${tag(pf.aim)}</b></div>
        <div><span>ENDURANCE · SPEED</span><b>${pf.enduranceMin.v} min${tag(pf.enduranceMin)} · ${pf.maxSpeed.v} m/s${tag(pf.maxSpeed)}</b></div>
        <div><span>UNIT COST · AGENT</span><b>${money(pf.unitCost.v)}${tag(pf.unitCost)} · ${money(ag.cost.v)}/${ag.unit}${tag(ag.cost)}</b></div>
      </div>
      ${warn.map((w) => `<div class="lo-warn">${esc(w)}</div>`).join('')}
      ${concept ? '<div class="lo-warn">Legacy abstraction: effect is not derived from delivered litres. The cinematic demo always uses it.</div>' : ''}
      <div class="lo-actions"><button type="button" data-a="start" class="primary">START LIVE SIMULATION</button><button type="button" data-a="cat" class="ghost">CATALOGUE</button><button type="button" data-a="cancel" class="ghost">CANCEL</button></div>`;
    this.root.querySelectorAll<HTMLSelectElement>('select[data-f]').forEach((el) => el.addEventListener('change', () => {
      if (el.dataset.f === 'platform') this.setup.platform = el.value as SuppressionSetup['platform'];
      else this.setup.agent = el.value as SuppressionSetup['agent'];
      this.changed();
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-seg]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.seg === 'scenario') this.setup.scenario = b.dataset.v as SuppressionSetup['scenario'];
      else this.setup.forward = b.dataset.v === '1';
      this.changed();
    }));
    this.root.querySelector('[data-a="cat"]')!.addEventListener('click', () => this.onCatalogue());
    this.root.querySelector('[data-a="start"]')!.addEventListener('click', () => this.onStart());
    this.root.querySelector('[data-a="cancel"]')!.addEventListener('click', () => this.onCancel());
  }

  private changed(): void {
    saveSetup(this.setup);
    this.render();
  }
}
