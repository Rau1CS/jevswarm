/**
 * EMERGENCY CALLS panel: every call, Jev's triage (typed answers + confidence), what the
 * dispatch policy did with it, and who decided (JEV / CODE / HUMAN). Calls that need a
 * person are pinned at the top with APPROVE / CHANGE / DISMISS controls.
 */
import { fmtClock } from '../core/math';
import type { CallCenter, CallRecord } from '../calls/callCenter';
import { PLACES, placeById } from '../calls/places';
import { RESPONSES, type ResponseId } from '../calls/triage';
import { esc } from './loadoutPanel';

const STATUS: Record<string, [string, string]> = {
  TRIAGING: ['TRIAGING', 'dim'], AUTO_REPLY: ['AUTO-REPLIED', 'ok'], MERGED: ['MERGED', 'ok'], REVIEW: ['OPERATOR REVIEW', 'warn'],
  AWAITING_APPROVAL: ['APPROVAL NEEDED', 'crit'], DISPATCHED: ['DISPATCHED', 'ok'], DISMISSED: ['DISMISSED', 'dim'],
};
const KIND: Record<string, string> = { PERSON_IN_DANGER: 'PERSON IN DANGER', FIRE_REPORT: 'FIRE REPORT', INFO_REQUEST: 'INFO REQUEST', NOT_EMERGENCY: 'NOT EMERGENCY', UNCLEAR: 'UNCLEAR' };
const pct = (x: number) => `${Math.round(x * 100)}%`;

export class CallsPanel {
  private root = document.getElementById('calls')!;
  private cc: CallCenter | null = null;
  private lastHtml = '';
  private collapsed = false;
  onFocus: (x: number, z: number) => void = () => {};
  /** The demo director marks decisions it makes on the commander's behalf. */
  scripted = false;

  constructor() {
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const b = t.closest<HTMLElement>('[data-act]');
      if (t.closest('.cp-head')) {
        this.collapsed = !this.collapsed;
        this.lastHtml = '';
        return this.render();
      }
      if (!b || !this.cc) {
        const card = t.closest<HTMLElement>('[data-place]');
        const p = card ? placeById(card.dataset.place!) : undefined;
        if (p) this.onFocus(p.x, p.z);
        return;
      }
      const id = b.dataset.id!;
      const act = b.dataset.act!;
      if (act === 'dismiss') this.cc.dismiss(id);
      else {
        const sel = this.root.querySelector<HTMLSelectElement>(`select[data-id="${id}"]`);
        this.cc.approve(id, act as ResponseId, sel?.value || undefined);
      }
      this.render();
    });
  }

  bind(cc: CallCenter): void {
    this.cc = cc;
    this.lastHtml = '';
    this.root.classList.remove('hidden');
    this.render();
  }

  render(): void {
    const cc = this.cc;
    if (!cc) return;
    const recs = cc.records;
    const n = (s: string) => recs.filter((r) => r.status === s).length;
    const pending = cc.pending;
    const recent = recs.filter((r) => !pending.includes(r)).slice(0, 5);
    const head = `<div class="cp-head"><div class="cp-title">EMERGENCY CALLS <span>// JEV TRIAGE</span></div>
      <div class="cp-counts">${recs.length} calls · ${n('DISPATCHED')} dispatched · ${n('MERGED')} merged · ${n('AUTO_REPLY')} auto-replied${pending.length ? ` · <b>${pending.length} need you</b>` : ''} <i>${this.collapsed ? '▸' : '▾'}</i></div></div>`;
    const html = this.collapsed ? head : `${head}
      ${pending.map((r) => this.pendingCard(r)).join('')}
      ${recent.map((r) => this.row(r)).join('') || (pending.length ? '' : '<div class="cp-empty">No calls yet.</div>')}
      <div class="cp-legend"><span class="by by-jev">JEV</span> judges each call · <span class="by by-code">CODE</span> applies the policy &amp; flies · <span class="by by-human">HUMAN</span> approves</div>`;
    if (html !== this.lastHtml) {
      this.root.innerHTML = html;
      this.lastHtml = html;
    }
  }

  private chips(r: CallRecord): string {
    const tr = r.triage;
    if (!tr) return '<div class="cp-chips"><span class="chip dim">Jev triaging…</span></div>';
    const place = tr.placeId ? placeById(tr.placeId)?.name : 'location unknown';
    return `<div class="cp-chips">
      <span class="chip">${KIND[tr.kind]} <b>${pct(tr.kindProb)}</b></span>
      <span class="chip">URGENCY <b>${tr.urgency.toFixed(1)}/4</b></span>
      ${tr.placeId || tr.kind === 'PERSON_IN_DANGER' || tr.kind === 'FIRE_REPORT' || tr.kind === 'UNCLEAR' ? `<span class="chip${tr.placeId ? '' : ' warn'}">${esc(place ?? '')}${tr.placeId ? ` <b>${pct(tr.placeProb)}</b>` : ''}</span>` : ''}
      ${tr.kind === 'PERSON_IN_DANGER' ? `<span class="chip${tr.cannotLeave >= 0.5 ? ' warn' : ''}">CAN'T LEAVE <b>${pct(tr.cannotLeave)}</b></span>` : ''}
      ${tr.duplicateOf ? `<span class="chip">REPEAT OF ${esc(tr.duplicateOf)} <b>${pct(tr.dupProb)}</b></span>` : ''}
      <span class="src">${tr.source === 'JEV' ? `Jev · ${Math.round(tr.latencyMs)} ms · 1 request` : 'fallback rules'}</span>
    </div>`;
  }

  private pendingCard(r: CallRecord): string {
    const tr = r.triage!;
    const proposed = r.response ?? 'VERIFY';
    const alts: ResponseId[] = ['VERIFY', 'VERIFY_ROUTE', 'FULL_RESCUE'];
    const needPlace = !tr.placeId;
    const btn = (id: ResponseId, main = false) => `<button data-act="${id}" data-id="${r.call.id}" class="${main ? 'main' : ''}">${main ? 'APPROVE · ' : ''}${esc(RESPONSES[id].label)}</button>`;
    return `<div class="cp-pend ${r.status === 'REVIEW' ? 'rev' : ''}" data-place="${tr.placeId ?? ''}">
      <div class="cp-ph"><span class="st ${STATUS[r.status][1]}">${STATUS[r.status][0]}</span><span>${r.call.id} · ${fmtClock(r.call.t)} · ${esc(r.call.caller)}</span></div>
      <div class="cp-tx">“${esc(r.call.transcript)}”</div>
      ${this.chips(r)}
      <div class="cp-why">${esc(r.reason)}</div>
      ${needPlace ? `<select data-id="${r.call.id}"><option value="">— operator: set location —</option>${PLACES.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>` : ''}
      <div class="cp-btns">${r.status === 'AWAITING_APPROVAL' ? btn(proposed, true) : ''}${alts.filter((a) => a !== proposed || r.status === 'REVIEW').map((a) => btn(a)).join('')}<button data-act="dismiss" data-id="${r.call.id}" class="ghost">DISMISS</button></div>
      ${this.scripted ? '<div class="cp-scripted">demo: the commander’s decision is scripted</div>' : ''}
    </div>`;
  }

  private row(r: CallRecord): string {
    const [label, cls] = STATUS[r.status];
    const by = r.decidedBy ? `<span class="by by-${r.decidedBy.toLowerCase()}">${r.decidedBy}</span>` : '';
    return `<div class="cp-row" data-place="${r.triage?.placeId ?? ''}">
      <div class="cp-rh"><span class="st ${cls}">${label}</span>${by}<span class="cp-id">${r.call.id} · ${fmtClock(r.call.t)}</span></div>
      <div class="cp-tx sm">“${esc(r.call.transcript.slice(0, 120))}${r.call.transcript.length > 120 ? '…' : ''}”</div>
      ${this.chips(r)}
      <div class="cp-why">${esc(r.reason)}</div>
    </div>`;
  }
}
