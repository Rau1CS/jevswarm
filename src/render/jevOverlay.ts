/**
 * JEV VIEW: Jev's operational picture projected onto the terrain via a canvas texture.
 * Layers: sectors, searched/unexplored, fire arrival prediction, active fire, comms,
 * evacuation routes, detections, scout sensor footprints.
 */
import * as THREE from 'three';
import { BASE_POS, COVER_N, FIRE_N, HALF, SAFE_ZONE, SECTOR_N, SECTOR_ROWS, WORLD_SIZE } from '../config';
import { ROADS } from '../world/layout';
import { BASE_COMM_RANGE, RELAY_COMM_RANGE } from '../jev/planner';
import { BURNING, BURNT } from '../sim/fire';
import type { Simulation } from '../sim/simulation';

const RES = 1024;
const px = (x: number) => ((x + HALF) / WORLD_SIZE) * RES;

export class JevOverlay {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private tex: THREE.CanvasTexture;
  private acc = 1;
  private arrivalImg: ImageData;
  private small = document.createElement('canvas');
  private sctx: CanvasRenderingContext2D;
  visible = false;
  highlightSector: string | null = null;

  constructor(terrainGeo: THREE.BufferGeometry) {
    this.canvas.width = this.canvas.height = RES;
    this.ctx = this.canvas.getContext('2d')!;
    this.small.width = this.small.height = FIRE_N;
    this.sctx = this.small.getContext('2d')!;
    this.arrivalImg = this.sctx.createImageData(FIRE_N, FIRE_N);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.anisotropy = 8;
    this.tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.tex }, uOpacity: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position + normal * 1.2, 1.0); }`,
      fragmentShader: `uniform sampler2D uMap; uniform float uOpacity; varying vec2 vUv;
        void main(){ vec4 c = texture2D(uMap, vUv); gl_FragColor = vec4(c.rgb, c.a * uOpacity); }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(terrainGeo, mat);
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.mesh.visible = true;
    this.acc = 1;
  }

  update(dt: number, sim: Simulation): void {
    const m = this.mesh.material as THREE.ShaderMaterial;
    const target = this.visible ? 1 : 0;
    m.uniforms.uOpacity.value += (target - m.uniforms.uOpacity.value) * Math.min(1, dt * 4);
    this.mesh.visible = m.uniforms.uOpacity.value > 0.01;
    if (!this.mesh.visible) return;
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc = 0;
    this.draw(sim);
    this.tex.needsUpdate = true;
  }

  private draw(sim: Simulation): void {
    const c = this.ctx;
    const S = RES / FIRE_N;
    c.clearRect(0, 0, RES, RES);
    c.fillStyle = 'rgba(6,12,18,0.42)';
    c.fillRect(0, 0, RES, RES);

    // Searched vs unexplored.
    const cs = RES / COVER_N;
    const cov = sim.sensors.coverage;
    for (let j = 0; j < COVER_N; j++) for (let i = 0; i < COVER_N; i++) {
      if (cov[j * COVER_N + i]) {
        c.fillStyle = 'rgba(110,200,190,0.16)';
        c.fillRect(i * cs, j * cs, cs + 0.5, cs + 0.5);
      }
    }
    c.save();
    c.strokeStyle = 'rgba(160,180,200,0.07)';
    c.lineWidth = 1;
    for (let k = -RES; k < RES; k += 10) {
      c.beginPath();
      c.moveTo(k, 0);
      c.lineTo(k + RES, RES);
      c.stroke();
    }
    c.restore();

    // Predicted fire arrival (red → amber isochrones up to 10 min) + active/burnt fire.
    const img = this.arrivalImg.data;
    const arr = sim.arrival;
    const f = sim.fire;
    for (let k = 0; k < FIRE_N * FIRE_N; k++) {
      const a = arr[k];
      let r = 0, g = 0, b = 0, al = 0;
      if (f.state[k] === BURNING) { r = 255; g = 90; b = 30; al = 200; }
      else if (f.state[k] === BURNT) { r = 30; g = 22; b = 18; al = 150; }
      else if (a < 600) {
        const t = a / 600;
        r = 255; g = 60 + t * 150; b = 30 + t * 20; al = 150 * (1 - t) + 30;
      }
      if (f.wet[k] > 0.2) { r = 90; g = 170; b = 230; al = Math.max(al, 120 * f.wet[k]); }
      img[k * 4] = r; img[k * 4 + 1] = g; img[k * 4 + 2] = b; img[k * 4 + 3] = al;
    }
    this.sctx.putImageData(this.arrivalImg, 0, 0);
    c.imageSmoothingEnabled = true;
    c.drawImage(this.small, 0, 0, RES, RES);
    // Isochrone contours at 2 / 5 / 10 min.
    c.lineWidth = 1.5;
    for (const [lim, colr] of [[120, 'rgba(255,90,60,0.9)'], [300, 'rgba(255,150,70,0.8)'], [600, 'rgba(255,210,120,0.55)']] as const) {
      c.strokeStyle = colr;
      c.beginPath();
      for (let j = 0; j < FIRE_N - 1; j++) for (let i = 0; i < FIRE_N - 1; i++) {
        const k = j * FIRE_N + i;
        const inside = arr[k] < lim;
        if (inside !== arr[k + 1] < lim) { c.moveTo((i + 1) * S, j * S); c.lineTo((i + 1) * S, (j + 1) * S); }
        if (inside !== arr[k + FIRE_N] < lim) { c.moveTo(i * S, (j + 1) * S); c.lineTo((i + 1) * S, (j + 1) * S); }
      }
      c.stroke();
    }

    // Sector grid + labels.
    const ss = RES / SECTOR_N;
    c.strokeStyle = 'rgba(170,205,225,0.32)';
    c.lineWidth = 1.5;
    c.font = '600 17px "IBM Plex Mono", monospace';
    for (let r = 0; r < SECTOR_N; r++) for (let q = 0; q < SECTOR_N; q++) {
      const label = `${SECTOR_ROWS[r]}${q + 1}`;
      const hi = label === this.highlightSector;
      c.strokeStyle = hi ? 'rgba(255,190,120,0.95)' : 'rgba(170,205,225,0.3)';
      c.lineWidth = hi ? 4 : 1.5;
      c.strokeRect(q * ss + 1, r * ss + 1, ss - 2, ss - 2);
      c.fillStyle = hi ? 'rgba(255,200,140,1)' : 'rgba(190,215,230,0.62)';
      c.fillText(label, q * ss + 8, r * ss + 22);
      const pct = Math.round(sim.sensors.sectorSearched(label) * 100);
      c.fillStyle = 'rgba(190,215,230,0.35)';
      c.font = '12px "IBM Plex Mono", monospace';
      c.fillText(`${pct}%`, q * ss + 8, r * ss + 38);
      c.font = '600 17px "IBM Plex Mono", monospace';
    }

    // Evacuation routes (blocked segments red).
    for (const road of ROADS) {
      for (let i = 0; i < road.pts.length - 1; i++) {
        const a = road.pts[i], b = road.pts[i + 1];
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const threat = arr[f.cellOf(mx, mz)];
        c.strokeStyle = !road.evac ? 'rgba(200,200,200,0.35)' : threat < 120 ? 'rgba(255,70,50,0.95)' : threat < 300 ? 'rgba(255,170,60,0.9)' : 'rgba(120,230,170,0.9)';
        c.lineWidth = road.evac ? 5 : 2.5;
        c.setLineDash(road.evac ? [] : [6, 6]);
        c.beginPath();
        c.moveTo(px(a.x), px(a.z));
        c.lineTo(px(b.x), px(b.z));
        c.stroke();
      }
    }
    c.setLineDash([]);

    // Comms coverage.
    const circle = (x: number, z: number, r: number, stroke: string, dash: number[] = []) => {
      c.strokeStyle = stroke;
      c.setLineDash(dash);
      c.lineWidth = 2;
      c.beginPath();
      c.arc(px(x), px(z), (r / WORLD_SIZE) * RES, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
    };
    circle(BASE_POS.x, BASE_POS.z, BASE_COMM_RANGE, 'rgba(170,185,255,0.55)', [10, 8]);
    for (const d of sim.drones) if (d.airborne && d.task.kind === 'RELAY' && d.phase >= 1) circle(d.x, d.z, RELAY_COMM_RANGE, 'rgba(170,185,255,0.45)', [6, 8]);
    circle(SAFE_ZONE.x, SAFE_ZONE.z, SAFE_ZONE.r, 'rgba(120,230,170,0.9)');

    // Scout footprints.
    c.fillStyle = 'rgba(140,200,255,0.12)';
    for (const d of sim.drones) {
      if (!d.airborne || d.role !== 'SCOUT') continue;
      c.beginPath();
      c.arc(px(d.x), px(d.z), (sim.sensors.footprint(d) / WORLD_SIZE) * RES, 0, Math.PI * 2);
      c.fill();
    }

    // Detections.
    c.font = '600 13px "IBM Plex Mono", monospace';
    for (const d of sim.sensors.detections) {
      if (d.status === 'DISMISSED') continue;
      const conf = d.status === 'CONFIRMED';
      c.strokeStyle = conf ? 'rgba(127,224,200,1)' : 'rgba(255,180,80,1)';
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(px(d.x), px(d.z), conf ? 7 : 7 + (1 - d.conf) * 10, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = c.strokeStyle;
      c.fillText(conf ? `${d.id} ✓` : `${d.id} ${d.conf.toFixed(2)}`, px(d.x) + 12, px(d.z) + 4);
    }
  }
}
