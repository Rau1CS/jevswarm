/** World-anchored DOM labels with screen-space decluttering (higher priority wins). */
import * as THREE from 'three';

export interface LabelSpec {
  key: string; x: number; y: number; z: number; html: string; cls: string;
  maxDist?: number;
  /** Higher keeps its place when labels overlap. */
  priority?: number;
  /** Approximate size in px for overlap tests. */
  w?: number; h?: number;
}

interface Placed { x0: number; y0: number; x1: number; y1: number }

export class Labels {
  private root = document.getElementById('labels')!;
  private pool = new Map<string, { el: HTMLDivElement; html: string; cls: string }>();
  private v = new THREE.Vector3();

  render(specs: LabelSpec[], cam: THREE.PerspectiveCamera): void {
    const w = window.innerWidth, h = window.innerHeight;
    const seen = new Set<string>();
    const placed: Placed[] = [];
    const projected: { s: LabelSpec; sx: number; sy: number; d: number }[] = [];
    for (const s of specs) {
      this.v.set(s.x, s.y, s.z);
      const dist = this.v.distanceTo(cam.position);
      if (s.maxDist && dist > s.maxDist) continue;
      this.v.project(cam);
      if (this.v.z > 1 || this.v.x < -1.1 || this.v.x > 1.1 || this.v.y < -1.1 || this.v.y > 1.1) continue;
      projected.push({ s, sx: ((this.v.x + 1) / 2) * w, sy: ((1 - this.v.y) / 2) * h, d: dist });
    }
    projected.sort((a, b) => (b.s.priority ?? 0) - (a.s.priority ?? 0) || a.d - b.d);
    for (const { s, sx, sy } of projected) {
      const lw = s.w ?? 90, lh = s.h ?? 14;
      const r = { x0: sx - lw / 2, y0: sy - lh, x1: sx + lw / 2, y1: sy };
      if (placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0)) continue;
      placed.push(r);
      seen.add(s.key);
      let e = this.pool.get(s.key);
      if (!e) {
        const el = document.createElement('div');
        this.root.append(el);
        e = { el, html: '', cls: '' };
        this.pool.set(s.key, e);
      }
      if (e.html !== s.html) {
        e.el.innerHTML = s.html;
        e.html = s.html;
      }
      if (e.cls !== s.cls) {
        e.el.className = `lbl ${s.cls}`;
        e.cls = s.cls;
      }
      e.el.style.left = `${sx}px`;
      e.el.style.top = `${sy}px`;
      e.el.style.display = '';
    }
    for (const [k, e] of this.pool) if (!seen.has(k)) e.el.style.display = 'none';
  }

  clear(): void {
    for (const e of this.pool.values()) e.el.remove();
    this.pool.clear();
  }
}
