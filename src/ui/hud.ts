/** DOM HUD: JEV panel, decision stream, alerts, priority callout, wind, drone card. */
import { DRONE } from '../config';
import { fmtClock, sectorOf } from '../core/math';
import { ROLE_SENSORS, type Drone } from '../sim/drone';
import type { Simulation } from '../sim/simulation';
import type { LogEntry } from '../jev/types';
import type { FollowMode } from '../render/cameraRig';
import type { ViewMode } from '../render/stage';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface HudActions {
  view(m: ViewMode): void;
  cam(preset: string): void;
  droneCount(n: number): void;
  timeScale(n: number): void;
  techMode(on: boolean): void;
  techPage(): void;
  quality(): void;
  mute(): void;
  end(): void;
  command(text: string): void;
  droneCam(mode: FollowMode): void;
  deselect(): void;
}

export class Hud {
  private stream = $('stream');
  private alerts = $('alerts');
  private callout = $('callout');
  private card = $('drone-card');
  private count = 0;
  techMode = false;
  followMode: FollowMode | null = null;
  private lastCardHtml = '';
  private calloutTimer = 0;

  constructor(a: HudActions) {
    document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) =>
      b.addEventListener('click', () => a.view(b.dataset.view as ViewMode)),
    );
    document.querySelectorAll<HTMLButtonElement>('#cams button').forEach((b) => b.addEventListener('click', () => a.cam(b.dataset.cam!)));
    $('drone-count').addEventListener('change', (e) => a.droneCount(Number((e.target as HTMLSelectElement).value)));
    $('time-scale').addEventListener('change', (e) => a.timeScale(Number((e.target as HTMLSelectElement).value)));
    $('btn-techmode').addEventListener('click', () => {
      this.techMode = !this.techMode;
      $('btn-techmode').classList.toggle('on', this.techMode);
      a.techMode(this.techMode);
      this.lastCardHtml = '';
    });
    $('btn-techpage').addEventListener('click', () => a.techPage());
    $('btn-quality').addEventListener('click', () => a.quality());
    $('btn-mute').addEventListener('click', () => a.mute());
    $('btn-end').addEventListener('click', () => a.end());
    const input = $<HTMLInputElement>('cmd-input');
    $('command').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim().slice(0, 140);
      if (v) a.command(v);
      input.value = '';
      input.blur();
    });
    document.querySelectorAll<HTMLButtonElement>('#cmd-suggest button').forEach((b) =>
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        a.command(b.textContent ?? '');
        input.blur();
      }),
    );
    this.card.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.fm) a.droneCam(t.dataset.fm as FollowMode);
      if (t.classList.contains('dc-close')) a.deselect();
    });
  }

  show(on: boolean): void {
    $('hud').classList.toggle('hidden', !on);
  }

  setView(m: ViewMode): void {
    document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === m));
  }
  setCamActive(preset: string | null): void {
    document.querySelectorAll<HTMLButtonElement>('#cams button').forEach((b) => b.classList.toggle('on', b.dataset.cam === preset));
  }
  setToggle(id: string, label: string, on?: boolean): void {
    const b = $(id);
    b.textContent = label;
    if (on !== undefined) b.classList.toggle('on', on);
  }
  setCoordinator(label: string, live: boolean): void {
    const b = $('coord-badge');
    b.textContent = label;
    b.classList.toggle('live', live);
  }
  setMode(txt: string): void {
    $('mission-mode').textContent = txt;
  }

  clearLog(): void {
    this.stream.innerHTML = '';
    this.count = 0;
  }

  addLog(e: LogEntry): void {
    const div = document.createElement('div');
    div.className = `ev ${e.level}`;
    div.innerHTML = `<div class="ts">${fmtClock(e.t)}</div><div class="ti">${esc(e.title)}</div>${e.lines.map((l) => `<div class="ln">${esc(l)}</div>`).join('')}`;
    this.stream.prepend(div);
    while (this.stream.children.length > 120) this.stream.lastChild!.remove();
    this.count++;
    $('stream-count').textContent = String(this.count);
    if (e.level === 'jev') {
      const p = $('jev-pulse');
      p.classList.remove('think');
      void p.offsetWidth;
      p.classList.add('think');
    }
  }

  alert(title: string, lines: string[], level: 'warn' | 'crit' | 'info', ms = 4200): void {
    const div = document.createElement('div');
    div.className = `alert ${level}`;
    div.innerHTML = `<div class="a-t">${esc(title)}</div>${lines.map((l) => `<div class="a-l">${esc(l)}</div>`).join('')}`;
    this.alerts.append(div);
    while (this.alerts.children.length > 3) this.alerts.firstChild!.remove();
    setTimeout(() => {
      div.classList.add('out');
      setTimeout(() => div.remove(), 520);
    }, ms);
  }

  showCallout(title: string, lines: string[]): void {
    const [sub, ...rows] = lines;
    this.callout.innerHTML = `<div class="c-t">${esc(title)}</div><div class="c-s">${esc(sub ?? '')}</div>${rows
      .map((r, i) => {
        const [id, ...rest] = r.split(' → ');
        return `<div class="c-row" style="animation-delay:${0.25 + i * 0.22}s"><b>${esc(id)}</b><span>→ ${esc(rest.join(' → '))}</span></div>`;
      })
      .join('')}`;
    this.callout.classList.remove('hidden');
    clearTimeout(this.calloutTimer);
    this.calloutTimer = window.setTimeout(() => this.callout.classList.add('hidden'), 6500);
  }

  caption(text: string | null): void {
    const c = $('demo-caption');
    c.classList.toggle('hidden', !text);
    if (text) c.textContent = text;
  }

  setWind(fromDeg: number, speed: number, shifting: boolean): void {
    $('wind-arrow').style.transform = `rotate(${fromDeg + 180}deg)`;
    $('wind-val').textContent = `${Math.round(fromDeg)}° · ${speed.toFixed(1)} m/s`;
    $('wind').classList.toggle('shift', shifting);
  }

  update(sim: Simulation, selected: Drone | null): void {
    $('clock').textContent = fmtClock(sim.t);
    $('tscale').textContent = `${sim.timeScale}×`;
    const ok = sim.drones.filter((d) => d.status !== 'FAILED').length;
    $('st-drones').textContent = `${ok} / ${sim.drones.length}`;
    const conf = sim.sensors.detections.filter((d) => d.status === 'CONFIRMED').length;
    const poss = sim.sensors.detections.filter((d) => d.status === 'POSSIBLE').length;
    $('st-civ').innerHTML = `${conf} confirmed<br /><span class="sub">${poss} possible</span>`;
    $('st-fire').textContent = `${sim.fire.stats().frontKm.toFixed(1)} km`;
    const co = sim.coordinator;
    const pri = co.judgment?.priorityId ? co.objectives.find((o) => o.id === co.judgment!.priorityId) : undefined;
    const u = pri ? co.judgment!.urgency[pri.id] ?? 0 : 0;
    const pe = $('st-priority');
    pe.textContent = pri ? `${prettyKind(pri.kind)} · Sector ${pri.sector}` : co.enabled ? 'Establishing picture' : 'Standby';
    pe.classList.toggle('crit', u >= 3.4);
    const j = co.judgment;
    $('st-coord').textContent = j
      ? `${j.source === 'JEV' ? `${j.model ?? 'jev'} · ${Math.round(j.latencyMs)} ms` : 'deterministic fallback'} · ${co.replans} replans · ${co.decisions} decisions${co.directive ? ` · directive: ${co.directive.intent.replace(/_/g, ' ').toLowerCase()}` : ''}`
      : '—';
    $('st-status').textContent = co.enabled ? 'ACTIVE' : 'STANDBY';
    this.updateCard(selected);
  }

  private updateCard(d: Drone | null): void {
    if (!d) {
      this.card.classList.add('hidden');
      return;
    }
    this.card.classList.remove('hidden');
    const bat = Math.round(d.battery * 100);
    const roleCol = { SCOUT: '#e8eef2', SUPPRESSION: '#ff7048', LOGISTICS: '#ffc240', RELAY: '#8fb5d8' }[d.role];
    const sensor = d.task.kind === 'VERIFY' || d.task.kind === 'SEARCH' ? 'THERMAL' : d.task.kind === 'CORRIDOR' ? 'RGB + DEPTH' : ROLE_SENSORS[d.role].split(' ')[0];
    const status = d.status === 'LINK_LOST' ? 'LINK LOST' : d.status === 'FAILED' ? 'LOST' : !d.linkOK && d.airborne ? 'AUTONOMOUS (NO LINK)' : d.status;
    const fm = this.followMode;
    const btn = (m: FollowMode, l: string) => `<button data-fm="${m}" class="${fm === m ? 'on' : ''}">${l}</button>`;
    const payload = d.role === 'SUPPRESSION' ? `${Math.round(d.payload * DRONE.suppressantLitres)} L` : d.role === 'LOGISTICS' ? (d.payload > 0.5 ? 'SUPPLY KIT' : 'EMPTY') : d.role === 'RELAY' ? 'MESH RADIO' : 'GIMBAL';
    const tech = this.techMode
      ? `<div class="dc-tech">
          <div class="row"><span>AIRFRAME</span><span>X500-derived sim platform<i class="tag con">CONCEPT</i></span></div>
          <div class="row"><span>AUTOPILOT</span><span>PX4 architecture<i class="tag con">CONCEPT</i></span></div>
          <div class="row"><span>COMPANION</span><span>simulation equivalent<i class="tag sim">SIM</i></span></div>
          <div class="row"><span>SENSORS</span><span>${ROLE_SENSORS[d.role].toLowerCase()}</span></div>
          <div class="row"><span>PAYLOAD</span><span>configurable · ${d.role.toLowerCase()}</span></div>
          <div class="row"><span>ENDURANCE</span><span>${DRONE.enduranceMin} min<i class="tag sim">SIM</i></span></div>
          <div class="row"><span>MAX SPEED</span><span>${DRONE.maxSpeed} m/s<i class="tag sim">SIM</i></span></div>
          <div class="row"><span>DISTANCE FLOWN</span><span>${(d.totalDist / 1000).toFixed(2)} km</span></div>
        </div>`
      : '';
    const html = `<div class="dc-head"><div><span class="dc-id">DRONE ${d.id}</span></div><div><span class="dc-role" style="color:${roleCol}">${d.role}</span><button class="dc-close" title="Close">✕</button></div></div>
      <div class="dc-grid">
        <div><div class="dc-k">BATTERY</div><div class="dc-v">${bat}%</div><div class="bar ${bat < 25 ? 'crit' : bat < 45 ? 'low' : ''}"><i style="width:${bat}%"></i></div></div>
        <div><div class="dc-k">STATUS</div><div class="dc-v" style="font-size:11px">${status}</div></div>
        <div class="wide"><div class="dc-k">MISSION</div><div class="dc-v">${esc(d.task.label)}</div></div>
        <div><div class="dc-k">SENSOR</div><div class="dc-v">${sensor}</div></div>
        <div><div class="dc-k">PAYLOAD</div><div class="dc-v">${payload}</div></div>
        <div><div class="dc-k">ALTITUDE</div><div class="dc-v">${Math.round(d.agl)} m</div></div>
        <div><div class="dc-k">SPEED</div><div class="dc-v">${d.speed.toFixed(1)} m/s</div></div>
        <div class="wide"><div class="dc-k">POSITION</div><div class="dc-v">Sector ${sectorOf(d.x, d.z)} · hdg ${String(Math.round(((d.yaw * 180) / Math.PI + 180) % 360)).padStart(3, '0')}°</div></div>
      </div>
      <div class="dc-cams">${btn('CHASE', 'CHASE CAMERA')}${btn('POV', 'DRONE POV')}${btn('THERMAL', 'THERMAL CAMERA')}${btn('MAP', 'MAP VIEW')}</div>${tech}`;
    if (html !== this.lastCardHtml) {
      this.card.innerHTML = html;
      this.lastCardHtml = html;
    }
  }
}

export function prettyKind(k: string): string {
  return ({ VERIFY: 'Verify possible human', RESCUE: 'Rescue', SUPPRESS: 'Suppression', SEARCH: 'Search', RELAY: 'Comms relay', PROTECT_ROAD: 'Protect evac road', MONITOR: 'Fire mapping' } as Record<string, string>)[k] ?? k;
}
