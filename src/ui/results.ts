/** MISSION COMPLETE card + scrubbable replay timeline. */
import { fmtClock } from '../core/math';
import type { Simulation } from '../sim/simulation';

export interface ResultsActions {
  scrub(t01: number): void;
  togglePlay(): boolean;
  restartDemo(): void;
  freeSim(): void;
  menu(): void;
}

export class Results {
  private root = document.getElementById('results')!;
  private slider!: HTMLInputElement;
  private time!: HTMLSpanElement;
  private playBtn!: HTMLButtonElement;
  dragging = false;

  show(sim: Simulation, duration: number, a: ResultsActions, demo: boolean): void {
    const r = sim.results();
    const row = (k: string, v: string) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`;
    this.root.innerHTML = `
      <div class="res-card">
        <h2>MISSION COMPLETE<small>${demo ? 'Cinematic demo' : 'Free simulation'} · ${fmtClock(sim.t)} mission time · ${sim.drones.length} aircraft · coordinator: ${sim.coordinator.mode === 'JEV' ? 'Jev' : 'simulation fallback'}</small></h2>
        <div class="res-grid">
          ${row('CIVILIANS LOCATED', `${r.located} / ${r.total}`)}
          ${row('CONFIRMED', `${r.confirmed}`)}
          ${row('AVERAGE DETECTION TIME', fmtClock(r.avgDetection))}
          ${row('AREA SEARCHED', `${r.searchedKm2.toFixed(1)} km²`)}
          ${row('FIRE CONTAINMENT (SIM)', `${Math.round(r.containment * 100)}%`)}
          ${row('DRONES LOST', `${r.dronesLost}`)}
          ${row('AUTONOMOUS REPLANS', `${r.replans}`)}
          ${row(sim.coordinator.mode === 'JEV' ? 'JEV DECISIONS' : 'COORDINATOR DECISIONS', `${r.decisions}`)}
          ${row('SUPPRESSION DROPS', `${r.drops}`)}
          ${row('FALSE POSITIVES CLEARED', `${r.falsePositives}`)}
        </div>
        <div class="res-actions">
          <button data-a="demo">RUN DEMO AGAIN</button>
          <button data-a="free">NEW SIMULATION</button>
          <button data-a="menu">MENU</button>
        </div>
      </div>
      <div class="replay">
        <span class="k">3D REPLAY</span>
        <button data-a="play">PLAY</button>
        <input type="range" min="0" max="1000" value="1000" />
        <span class="t">${fmtClock(duration)}</span>
      </div>`;
    this.root.classList.remove('hidden');
    document.getElementById('hud')!.classList.add('results');
    this.slider = this.root.querySelector('input')!;
    this.time = this.root.querySelector('.replay .t')!;
    this.playBtn = this.root.querySelector('[data-a="play"]')!;
    this.slider.addEventListener('input', () => {
      this.dragging = true;
      a.scrub(Number(this.slider.value) / 1000);
    });
    this.slider.addEventListener('change', () => (this.dragging = false));
    this.root.querySelector('[data-a="play"]')!.addEventListener('click', () => {
      this.playBtn.textContent = a.togglePlay() ? 'PAUSE' : 'PLAY';
    });
    this.root.querySelector('[data-a="demo"]')!.addEventListener('click', () => a.restartDemo());
    this.root.querySelector('[data-a="free"]')!.addEventListener('click', () => a.freeSim());
    this.root.querySelector('[data-a="menu"]')!.addEventListener('click', () => a.menu());
  }

  setTime(t01: number, t: number, playing: boolean): void {
    if (!this.slider) return;
    if (!this.dragging) this.slider.value = String(Math.round(t01 * 1000));
    this.time.textContent = fmtClock(t);
    this.playBtn.textContent = playing ? 'PAUSE' : 'PLAY';
  }

  hide(): void {
    document.getElementById('hud')!.classList.remove('results');
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
  }
}
