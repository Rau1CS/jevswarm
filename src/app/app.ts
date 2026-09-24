/**
 * Application shell: owns renderer modules, the live Simulation, modes (menu / demo /
 * free / results+replay), UI wiring, camera presets, audio and adaptive quality.
 */
import * as THREE from 'three';
import { BASE_POS } from '../config';
import { Stage, type Quality, type ViewMode } from '../render/stage';
import { CameraRig, type FollowMode } from '../render/cameraRig';
import { WorldMesh } from '../render/worldMesh';
import { Forest } from '../render/forest';
import { FireFx } from '../render/fireFx';
import { DroneRender } from '../render/droneRender';
import { Actors } from '../render/actors';
import { Paths } from '../render/paths';
import { JevOverlay } from '../render/jevOverlay';
import { GLOBAL } from '../render/thermal';
import { Simulation } from '../sim/simulation';
import { Recorder } from '../sim/recorder';
import { EventScheduler } from '../sim/events';
import type { Drone } from '../sim/drone';
import { Rng } from '../core/math';
import { Hud } from '../ui/hud';
import { Labels } from '../ui/labels';
import { Results } from '../ui/results';
import { TechPage } from '../ui/techPage';
import { SoundScape } from '../audio/audio';
import { Director } from '../demo/director';
import { buildLabels } from './labelSpecs';
import { demoScenario, freeScenario } from './scenarios';

type Mode = 'MENU' | 'DEMO' | 'FREE' | 'RESULTS';
const $ = (id: string) => document.getElementById(id)!;

export class App {
  stage = new Stage($('app'));
  rig = new CameraRig(this.stage.camera, this.stage.renderer.domElement);
  sim!: Simulation;
  world!: WorldMesh;
  forest!: Forest;
  fireFx!: FireFx;
  drones = new DroneRender();
  actors = new Actors();
  paths = new Paths();
  overlay!: JevOverlay;
  labels = new Labels();
  hud: Hud;
  results = new Results();
  tech = new TechPage();
  sound = new SoundScape();
  recorder = new Recorder();
  director: Director | null = null;
  scheduler: EventScheduler | null = null;
  mode: Mode = 'MENU';
  view: ViewMode = 'WORLD';
  selected: Drone | null = null;
  hovered: Drone | null = null;
  droneCount = 24;
  highlight = new Map<string, number>();
  private now = 0;
  private last = performance.now();
  private hudAcc = 0;
  private replay = { on: false, playing: false, t: 0 };
  private frameTimes: number[] = [];
  private techOpen = false;
  private jevConfigured = false;
  private followPrev: ViewMode | null = null;
  private windShiftUntil = 0;
  private bannerLast = new Map<string, number>();

  constructor() {
    this.hud = new Hud({
      view: (m) => this.setView(m),
      cam: (p) => this.cameraPreset(p),
      droneCount: (n) => {
        this.droneCount = n;
        if (this.mode === 'FREE') this.startFree();
        else if (this.mode === 'DEMO') this.startDemo();
      },
      timeScale: (n) => (this.sim.timeScale = n),
      techMode: () => {},
      techPage: () => this.openTech(),
      quality: () => this.cycleQuality(),
      mute: () => {
        this.sound.setMuted(!this.sound.muted);
        this.hud.setToggle('btn-mute', this.sound.muted ? 'MUTED' : 'SOUND ON', !this.sound.muted);
      },
      end: () => this.finish(),
      command: (text) => void this.sim.coordinator.command(text, this.sim.t),
      droneCam: (m) => this.droneCam(m),
      deselect: () => this.select(null),
    });
    this.hud.setToggle('btn-mute', 'SOUND ON', true);
    this.tech.onClose = () => (this.techOpen = false);
    this.newSim(demoScenario(this.droneCount));
    this.buildStatic();
    this.bindPointer();
    this.rig.onUserTakeover = () => {
      if (this.director) this.director.userCamera = true;
    };
    $('btn-demo').addEventListener('click', () => this.startDemo());
    $('btn-free').addEventListener('click', () => this.startFree());
    $('btn-tech2').addEventListener('click', () => this.openTech());
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === '1') this.setView('WORLD');
      if (e.key === '2') this.setView('JEV');
      if (e.key === '3') this.setView('THERMAL');
      if (e.key === 'Escape') this.select(null);
    });
    // Menu backdrop: slow orbit over the burning valley.
    this.rig.flyTo(new THREE.Vector3(-1500, 700, 900), new THREE.Vector3(-300, 40, -100), 0.01);
    this.rig.cineOrbit(new THREE.Vector3(-250, 40, -80), 1450, 560, 0.03);
    fetch('/api/jev/status').then((r) => r.json()).then((j: { configured: boolean; model: string }) => {
      this.jevConfigured = j.configured;
      $('ts-status').textContent = j.configured ? `Jev connected (${j.model}) · strategic decisions from TypeSafe System One` : 'Jev not configured (set TYPESAFE_API_KEY in .env.local) · running SIMULATION COORDINATOR fallback';
    }).catch(() => ($('ts-status').textContent = 'Jev proxy unavailable · running SIMULATION COORDINATOR fallback'));
    requestAnimationFrame(() => this.loop());
  }

  private buildStatic(): void {
    this.world = new WorldMesh(this.sim.fire.tex);
    this.forest = new Forest(this.sim.fire, 1);
    this.fireFx = new FireFx(this.stage.quality);
    this.overlay = new JevOverlay(this.world.terrainGeo);
    this.stage.scene.add(this.world.group, this.forest.group, this.fireFx.group, this.drones.group, this.actors.group, this.paths.group, this.overlay.mesh);
  }

  private newSim(opts: ReturnType<typeof demoScenario>): void {
    this.sim = new Simulation(opts);
    if (this.world) this.world.fireTex.image.data = this.sim.fire.tex;
    this.recorder = new Recorder();
    this.paths.clear();
    this.labels.clear();
    this.hud.clearLog();
    this.selected = null;
    this.highlight.clear();
    this.sim.timeScale = Number((document.getElementById('time-scale') as HTMLSelectElement).value);
    this.sim.on({
      log: (e) => {
        this.hud.addLog(e);
        this.recorder.note(e.title);
        if (e.level === 'ok') this.sound.radio();
        else if (e.level === 'jev') this.sound.blip();
      },
      banner: (title, lines, level) => {
        // Repeated routine banners (e.g. several confirmations in a row) collapse to one per 20 s.
        const last = this.bannerLast.get(title) ?? -99;
        if (level !== 'crit' && this.now - last < 20) return;
        this.bannerLast.set(title, this.now);
        this.hud.alert(title, lines, level);
        if (level === 'crit') this.sound.alert();
        else this.sound.radio();
        if (title.startsWith('WIND')) {
          this.sound.whoosh();
          this.windShiftUntil = this.now + 8;
        }
      },
      priority: (title, lines, o) => {
        this.hud.showCallout(title, lines);
        this.sound.alert();
        this.director?.noteCallout();
        this.overlay.highlightSector = o.sector;
        for (const l of lines) {
          const id = l.split(' → ')[0];
          if (/^D\d+$/.test(id)) this.highlight.set(id, this.now + 9);
        }
        if (this.mode === 'FREE' && this.rig.userIdleSec > 15 && !this.rig.follow) this.rig.frame(o.x, o.z, 650, 2.5);
      },
      fx: (e) => {
        if (e.type === 'drop') {
          const d = this.sim.drones.find((q) => q.id === e.droneId);
          this.fireFx.drop(e.x, e.y, e.z, d?.vx ?? 0, d?.vz ?? 0);
          this.sound.drop();
        } else if (e.type === 'detect') this.sound.blip();
      },
      replan: (changes) => {
        this.paths.replan(changes, this.sim.drones);
        for (const c of changes) if (!c.to.startsWith('SEARCH') && c.to !== 'HOLDING' && c.to !== 'STAGING') this.highlight.set(c.droneId, Math.max(this.highlight.get(c.droneId) ?? 0, this.now + 5));
      },
    });
  }

  private async prepare(opts: ReturnType<typeof demoScenario>, mode: Mode): Promise<void> {
    this.sound.start();
    this.results.hide();
    this.replay = { on: false, playing: false, t: 0 };
    document.querySelectorAll('.endcard').forEach((e) => e.remove());
    this.newSim(opts);
    this.sim.coordinator.forceSim = !this.jevConfigured;
    await this.sim.coordinator.init();
    this.hud.setCoordinator(this.sim.coordinator.label, this.sim.coordinator.mode === 'JEV');
    this.mode = mode;
    this.hud.setMode(mode === 'DEMO' ? 'CINEMATIC DEMO' : 'FREE SIMULATION');
    $('title-screen').classList.add('hidden');
    this.setView('WORLD');
    this.rig.release();
  }

  async startDemo(): Promise<void> {
    await this.prepare(demoScenario(this.droneCount), 'DEMO');
    this.sim.timeScale = 2;
    (document.getElementById('time-scale') as HTMLSelectElement).value = '2';
    this.scheduler = null;
    this.hud.show(false);
    this.director = new Director({
      sim: this.sim,
      rig: this.rig,
      caption: (t) => this.hud.caption(t),
      title: (on) => {
        const el = $('cine-title');
        if (on) el.classList.remove('hidden', 'out');
        else {
          el.classList.add('out');
          setTimeout(() => el.classList.add('hidden'), 1000);
        }
      },
      hud: (on) => this.hud.show(on),
      endCard: () => {
        const r = this.sim.results();
        const div = document.createElement('div');
        div.className = 'endcard';
        div.innerHTML = `<div class="e1">JEV RESCUE SWARM</div><div class="e2"><b>${this.sim.drones.length}</b> autonomous aircraft<br/><b>1</b> human commander<br/><b>${r.confirmed}</b> people confirmed · <b>${r.decisions}</b> coordinated decisions</div>`;
        document.body.append(div);
      },
      finish: () => this.finish(),
      select: (d) => this.select(d, false),
      callout: (t, l) => {
        this.hud.showCallout(t, l);
        this.sound.alert();
      },
    });
  }

  async startFree(): Promise<void> {
    await this.prepare(freeScenario(this.droneCount), 'FREE');
    this.director = null;
    this.hud.show(true);
    this.hud.caption(null);
    this.scheduler = new EventScheduler(new Rng(this.sim.opts.seed + 9), 6);
    this.sim.launchAll(this.sim.t + 2, 0.3);
    this.rig.frame(BASE_POS.x + 60, BASE_POS.z - 60, 520, 2.5, -2.3);
  }

  finish(): void {
    if (this.mode === 'RESULTS' || this.mode === 'MENU') return;
    this.mode = 'RESULTS';
    this.sim.paused = true;
    this.director = null;
    this.hud.caption(null);
    this.hud.show(true);
    document.querySelectorAll('.endcard').forEach((e) => e.remove());
    this.replay = { on: true, playing: false, t: this.recorder.duration };
    this.results.show(this.sim, this.recorder.duration, {
      scrub: (k) => {
        this.replay.t = k * this.recorder.duration;
        this.applyReplay();
      },
      togglePlay: () => {
        this.replay.playing = !this.replay.playing;
        if (this.replay.playing && this.replay.t >= this.recorder.duration - 0.5) this.replay.t = 0;
        return this.replay.playing;
      },
      restartDemo: () => this.startDemo(),
      freeSim: () => this.startFree(),
      menu: () => location.reload(),
    }, this.sim.opts.hero);
    this.rig.release();
    this.rig.flyTo(new THREE.Vector3(-900, 1500, 1500), new THREE.Vector3(0, 0, -50), 3);
  }

  private applyReplay(): void {
    const f = this.recorder.frames;
    if (!f.length) return;
    const t = this.replay.t;
    let i = f.findIndex((q) => q.t > t) - 1;
    if (i < 0) i = t <= f[0].t ? 0 : f.length - 1;
    const a = f[i], b = f[Math.min(i + 1, f.length - 1)];
    const frac = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    this.recorder.apply(this.sim, i, Math.max(0, Math.min(1, frac)));
  }

  setView(m: ViewMode): void {
    this.view = m;
    this.stage.setMode(m);
    GLOBAL.uThermal.value = m === 'THERMAL' ? 1 : 0;
    GLOBAL.uJev.value = m === 'JEV' ? 1 : 0;
    this.overlay.setVisible(m === 'JEV');
    this.paths.showAssignments = m === 'JEV';
    this.hud.setView(m);
  }

  select(d: Drone | null, follow = true): void {
    this.selected = d;
    this.drones.selected = d;
    if (!d) {
      if (this.rig.follow) this.rig.release();
      this.hud.followMode = null;
      if (this.followPrev) this.setView(this.followPrev);
      this.followPrev = null;
      return;
    }
    if (follow) this.droneCam('CHASE');
  }

  private droneCam(m: FollowMode): void {
    const d = this.selected;
    if (!d) return;
    if (m === 'THERMAL') {
      if (this.view !== 'THERMAL') this.followPrev = this.view;
      this.setView('THERMAL');
    } else if (this.followPrev) {
      this.setView(this.followPrev);
      this.followPrev = null;
    }
    this.rig.followDrone(d, m);
    this.hud.followMode = m;
    this.hud.setCamActive('SELECTED');
  }

  private cameraPreset(p: string): void {
    if (this.director) this.director.userCamera = true;
    this.rig.release();
    this.hud.setCamActive(p);
    const sim = this.sim;
    const centroid = (pts: { x: number; z: number }[]) => pts.length ? { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, z: pts.reduce((s, q) => s + q.z, 0) / pts.length } : { x: 0, z: 0 };
    switch (p) {
      case 'OVERVIEW':
        this.rig.flyTo(new THREE.Vector3(-1350, 1250, 1450), new THREE.Vector3(-40, 0, -40), 2.5);
        break;
      case 'FIRE': {
        const front = sim.fire.frontCells().map((k) => sim.fire.cellCenter(k % sim.fire.n, (k / sim.fire.n) | 0));
        const c = centroid(front);
        this.rig.frame(c.x, c.z, 520);
        break;
      }
      case 'SWARM': {
        const c = centroid(sim.drones.filter((d) => d.airborne));
        this.rig.frame(c.x, c.z, 700);
        break;
      }
      case 'RESCUE': {
        const j = sim.coordinator.judgment;
        const cands = sim.coordinator.objectives.filter((o) => o.kind === 'RESCUE' || o.kind === 'VERIFY');
        const o = cands.sort((a, b) => (j?.urgency[b.id] ?? 0) - (j?.urgency[a.id] ?? 0))[0];
        if (o) this.rig.frame(o.x, o.z, 340);
        break;
      }
      case 'SELECTED':
        if (this.selected) this.droneCam('CHASE');
        else {
          const d = sim.drones.find((q) => q.airborne && q.task.kind !== 'IDLE');
          if (d) this.select(d);
        }
        break;
      case 'BASE':
        this.rig.frame(BASE_POS.x, BASE_POS.z, 300);
        break;
    }
  }

  private cycleQuality(): void {
    const order: Quality[] = ['HIGH', 'MEDIUM', 'LOW'];
    this.setQuality(order[(order.indexOf(this.stage.quality) + 1) % 3]);
  }

  private setQuality(q: Quality): void {
    this.stage.setQuality(q);
    this.forest.setShadows(q === 'HIGH');
    this.stage.scene.remove(this.fireFx.group);
    this.fireFx = new FireFx(q);
    this.stage.scene.add(this.fireFx.group);
    this.hud.setToggle('btn-quality', q);
  }

  private openTech(): void {
    this.techOpen = true;
    this.tech.open();
  }

  private bindPointer(): void {
    const dom = this.stage.renderer.domElement;
    let down = { x: 0, y: 0 };
    dom.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    dom.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || this.mode === 'MENU') return;
      const d = this.drones.pick(this.sim.drones, this.stage.camera, e.clientX, e.clientY, window.innerWidth, window.innerHeight);
      if (d) {
        if (this.director) this.director.userCamera = true;
        this.select(d);
      }
    });
    let acc = 0;
    dom.addEventListener('pointermove', (e) => {
      if (performance.now() - acc < 60) return;
      acc = performance.now();
      this.hovered = this.drones.pick(this.sim.drones, this.stage.camera, e.clientX, e.clientY, window.innerWidth, window.innerHeight);
      this.drones.hovered = this.hovered;
      dom.style.cursor = this.hovered ? 'pointer' : '';
    });
  }

  private loop(): void {
    requestAnimationFrame(() => this.loop());
    const t0 = performance.now();
    const dt = Math.min(0.05, (t0 - this.last) / 1000);
    this.last = t0;
    if (this.techOpen) return;
    this.frame(dt);
    this.adaptQuality(dt);
  }

  /** One rendered frame (also callable directly for automated capture). */
  frame(dt: number): void {
    const t0 = performance.now();
    this.now += dt;
    GLOBAL.uTime.value = this.now;
    const sim = this.sim;

    if (this.replay.on) {
      if (this.replay.playing) {
        this.replay.t = Math.min(this.recorder.duration, this.replay.t + dt * 6);
        if (this.replay.t >= this.recorder.duration) this.replay.playing = false;
        this.applyReplay();
      }
      this.results.setTime(this.recorder.duration ? this.replay.t / this.recorder.duration : 0, this.replay.t, this.replay.playing);
    } else {
      this.director?.update(dt);
      if (this.mode === 'FREE') {
        this.scheduler?.update(sim);
        if (sim.t > 900) this.finish();
      }
      sim.advance(this.mode === 'MENU' ? dt * 0.5 : dt);
      if (this.mode === 'DEMO' || this.mode === 'FREE') this.recorder.capture(sim);
    }

    this.world.update(this.now, sim.fire, sim.fire.version);
    this.forest.update(sim.fire);
    this.fireFx.setScale(this.stage.pointScale);
    this.fireFx.update(dt, sim.fire, this.stage.fireLights);
    this.drones.update(sim.drones, this.now, this.stage.camera, this.view);
    this.actors.update(this.now, sim.civilians, sim.sensors.detections, sim.vehicles, sim.packages);
    this.paths.update(dt, this.now, sim.drones, this.selected, sim.coordinator.corridors);
    this.overlay.update(dt, sim);
    this.rig.update(dt);
    this.stage.focusShadow(this.rig.controls.target);
    const hudVisible = !document.getElementById('hud')!.classList.contains('hidden');
    if (this.mode !== 'MENU' && hudVisible) this.labels.render(buildLabels(sim, this.view, this.selected, this.hovered, this.highlight, this.now, this.replay.on), this.stage.camera);
    else this.labels.render([], this.stage.camera);

    this.hudAcc += dt;
    if (this.hudAcc > 0.2) {
      this.hudAcc = 0;
      this.hud.update(sim, this.selected);
      const w = sim.fire.wind;
      this.hud.setWind(w.fromDeg, w.speed, this.now < this.windShiftUntil);
      this.audioLevels();
    }
    this.stage.render(this.now);
    this.lastWorkMs = performance.now() - t0;
  }
  lastWorkMs = 0;

  private audioLevels(): void {
    const cam = this.stage.camera.position;
    const target = this.rig.controls.target;
    const sim = this.sim;
    let fire = 0;
    const fk = sim.fire.cellOf(target.x, target.z);
    const near = sim.fire.burning.length ? Math.min(1, sim.fire.intensity[fk] + sim.fire.burning.length / 3000) : 0;
    fire = Math.min(1, near * (1 - Math.min(1, cam.distanceTo(target) / 2500)));
    let dr = 0;
    for (const d of sim.drones) {
      if (!d.airborne) continue;
      const dd = cam.distanceTo(new THREE.Vector3(d.x, d.y, d.z));
      dr += Math.max(0, 1 - dd / 260);
    }
    this.sound.setLevels(fire, Math.min(1, dr / 3), Math.min(1, sim.fire.wind.speed / 10));
  }

  /** Step down quality when frames are consistently slow. */
  private adaptQuality(dt: number): void {
    if (document.visibilityState !== 'visible') return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 180) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 1 / 40 && this.stage.quality !== 'LOW') {
      this.setQuality(this.stage.quality === 'HIGH' ? 'MEDIUM' : 'LOW');
      this.hud.alert('PERFORMANCE', [`render quality → ${this.stage.quality}`], 'info', 2500);
    }
  }
}

