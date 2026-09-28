/**
 * Procedural drone textures (generated once, shared): 2x2 twill carbon-fibre weave
 * (colour / normal / roughness), the decal atlas used by the GLB decal quads, the rotor
 * blur disc, and a small sky environment for PBR reflections in the field view.
 * No external or branded imagery is used.
 */
import * as THREE from 'three';

const cache: Record<string, THREE.Texture> = {};

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, srgb: boolean, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Twill carbon weave: returns { map, normalMap, roughnessMap } tiling every UV unit. */
export function carbonTextures(): { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture } {
  if (!cache.cMap) {
    const S = 256, N = 8, cell = S / N;
    const hgt = new Float32Array(S * S);
    const shade = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = Math.floor(x / cell), j = Math.floor(y / cell);
        const fx = (x % cell) / cell, fy = (y % cell) / cell;
        const warp = (i + j) % 4 < 2; // 2x2 twill: warp tow on top for two cells, then weft
        const across = warp ? fy : fx;
        const along = warp ? fx : fy;
        const bump = Math.sin(across * Math.PI);
        const dip = 0.75 + 0.25 * Math.sin(along * Math.PI);
        const fib = 0.04 * Math.sin((warp ? y : x) * 2.1) * Math.sin((warp ? y : x) * 0.37);
        hgt[y * S + x] = bump * dip + fib;
        shade[y * S + x] = (warp ? 1.0 : 0.72) * (0.8 + 0.2 * bump) + fib;
      }
    }
    const [cm, gm] = canvas(S), [cn, gn] = canvas(S), [cr, gr] = canvas(S);
    const im = gm.createImageData(S, S), inn = gn.createImageData(S, S), ir = gr.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const k = y * S + x, o = k * 4;
        const h = (xx: number, yy: number) => hgt[((yy + S) % S) * S + ((xx + S) % S)];
        const dx = (h(x + 1, y) - h(x - 1, y)) * 2.2, dy = (h(x, y + 1) - h(x, y - 1)) * 2.2;
        const l = Math.hypot(dx, dy, 1);
        inn.data[o] = (-dx / l * 0.5 + 0.5) * 255;
        inn.data[o + 1] = (dy / l * 0.5 + 0.5) * 255;
        inn.data[o + 2] = (1 / l * 0.5 + 0.5) * 255;
        inn.data[o + 3] = 255;
        const s = shade[k];
        im.data[o] = 20 + s * 26;
        im.data[o + 1] = 21 + s * 27;
        im.data[o + 2] = 24 + s * 30;
        im.data[o + 3] = 255;
        const r = 0.34 + (1 - hgt[k]) * 0.22;
        ir.data[o] = ir.data[o + 1] = ir.data[o + 2] = r * 255;
        ir.data[o + 3] = 255;
      }
    }
    gm.putImageData(im, 0, 0);
    gn.putImageData(inn, 0, 0);
    gr.putImageData(ir, 0, 0);
    cache.cMap = tex(cm, true);
    cache.cNrm = tex(cn, false);
    cache.cRough = tex(cr, false);
    // UVs are in metres: one 8-tow tile every 2 cm (≈2.5 mm tows, 3K twill).
    for (const t of [cache.cMap, cache.cNrm, cache.cRough]) t.repeat.set(50, 50);
  }
  return { map: cache.cMap, normalMap: cache.cNrm, roughnessMap: cache.cRough };
}

/** Fine noise used as a roughness/bump breakup for anodised metal, paint and plastics. */
export function grainTexture(): THREE.Texture {
  if (!cache.grain) {
    const S = 128;
    const [c, g] = canvas(S);
    const im = g.createImageData(S, S);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < S * S; i++) {
      const v = 200 + rnd() * 40 + Math.sin(i * 0.013) * 6;
      im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v;
      im.data[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    cache.grain = tex(c, false);
    cache.grain.repeat.set(12, 12);
  }
  return cache.grain;
}

// ---------------------------------------------------------------------------------- decals
/** Cell (col,row) -> width/height aspect. Mirrors DECAL_ASPECT in tools/blender/drone_lib.py. */
const ASPECT: Record<string, number> = {
  '0,0': 4, '1,0': 2, '2,0': 4, '3,0': 4, '0,1': 4, '1,1': 4, '2,1': 3, '3,1': 1,
  '0,2': 4, '1,2': 3, '2,2': 0.5, '3,2': 3, '0,3': 4, '1,3': 4, '2,3': 3, '3,3': 2,
};

type Painter = (g: CanvasRenderingContext2D, w: number, h: number) => void;

const font = (px: number, weight = 700) => `${weight} ${px}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;

function label(text: string, color: string, outline: string | null, px: number, sub?: string): Painter {
  return (g, w, h) => {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = font(px, 800);
    const cy = sub ? h * 0.4 : h / 2;
    if (outline) {
      g.lineWidth = px * 0.14;
      g.strokeStyle = outline;
      g.strokeText(text, w / 2, cy, w * 0.94);
    }
    g.fillStyle = color;
    g.fillText(text, w / 2, cy, w * 0.94);
    if (sub) {
      g.font = font(px * 0.42, 600);
      g.fillText(sub, w / 2, h * 0.8, w * 0.94);
    }
  };
}

function plate(bg: string, fg: string, lines: [string, number][], border?: string): Painter {
  return (g, w, h) => {
    g.fillStyle = bg;
    g.beginPath();
    g.roundRect(2, 2, w - 4, h - 4, h * 0.12);
    g.fill();
    if (border) {
      g.strokeStyle = border;
      g.lineWidth = h * 0.05;
      g.stroke();
    }
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const step = h / (lines.length + 1);
    lines.forEach(([t, s], i) => {
      g.font = font(h * s, 800);
      g.fillText(t, w / 2, step * (i + 1), w * 0.9);
    });
  };
}

const CELLS: Record<string, Painter> = {
  '0,0': (g, w, h) => { // hazard stripes
    g.fillStyle = '#f2b90f';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#111';
    for (let x = -h; x < w + h; x += h * 0.9) {
      g.beginPath();
      g.moveTo(x, h); g.lineTo(x + h * 0.45, h); g.lineTo(x + h * 0.45 + h, 0); g.lineTo(x + h, 0);
      g.fill();
    }
  },
  '1,0': (g, w, h) => { // JEV mark
    g.fillStyle = 'rgba(12,16,20,0.92)';
    g.beginPath(); g.roundRect(3, 3, w - 6, h - 6, h * 0.2); g.fill();
    g.fillStyle = '#eef3f6';
    g.beginPath(); g.moveTo(w * 0.1, h * 0.28); g.lineTo(w * 0.2, h * 0.5); g.lineTo(w * 0.1, h * 0.72); g.lineTo(w * 0.15, h * 0.72); g.lineTo(w * 0.25, h * 0.5); g.lineTo(w * 0.15, h * 0.28); g.fill();
    label('JEV', '#eef3f6', null, h * 0.5, 'RESCUE SWARM')(g, w * 1.08, h);
  },
  '2,0': label('SCOUT', '#ffffff', 'rgba(0,0,0,0.75)', 44),
  '3,0': label('SUPPRESSION', '#ffffff', 'rgba(0,0,0,0.75)', 44),
  '0,1': label('LOGISTICS', '#ffffff', 'rgba(0,0,0,0.75)', 44),
  '1,1': label('RELAY · MESH', '#ffffff', 'rgba(0,0,0,0.75)', 44),
  '2,1': plate('#1d2a3a', '#dfe7ee', [['LiPo 4S  14.8 V', 0.26], ['5000 mAh  ·  74 Wh', 0.2], ['DO NOT PUNCTURE · CHARGE ATTENDED', 0.1]], '#f2b90f'),
  '3,1': (g, w, h) => { // GNSS forward arrow
    g.fillStyle = 'rgba(30,34,38,0.9)';
    g.beginPath(); g.arc(w / 2, h / 2, w * 0.45, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f4f6f7';
    g.beginPath(); g.moveTo(w / 2, h * 0.14); g.lineTo(w * 0.74, h * 0.5); g.lineTo(w * 0.58, h * 0.5); g.lineTo(w * 0.58, h * 0.84);
    g.lineTo(w * 0.42, h * 0.84); g.lineTo(w * 0.42, h * 0.5); g.lineTo(w * 0.26, h * 0.5); g.fill();
  },
  '0,2': plate('#f2b90f', '#111111', [['RELEASE HOOK · KEEP CLEAR', 0.34]]),
  '1,2': plate('#161a1e', '#dfe7ee', [['SMART BATTERY 14S', 0.24], ['51.8 V  ·  30 Ah  ·  HOT-SWAP', 0.16]], '#6f7c88'),
  '2,2': (g, w, h) => { // tank level scale
    g.fillStyle = 'rgba(20,22,24,0.85)';
    for (let i = 0; i <= 20; i++) {
      const y = h * 0.95 - (i / 20) * h * 0.9;
      const long = i % 5 === 0;
      g.fillRect(w * 0.1, y - h * 0.004, long ? w * 0.45 : w * 0.25, h * 0.008);
      if (long && i > 0) {
        g.font = font(w * 0.26, 800);
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(String(i), w * 0.6, y);
      }
    }
  },
  '3,2': label('NO STEP', '#ffffff', 'rgba(0,0,0,0.6)', 60),
  '0,3': (g, w, h) => {
    g.fillStyle = '#c4452c';
    g.fillRect(0, h * 0.78, w, h * 0.14);
    label('FIRE SUPPRESSANT · 20 L', '#1b1d20', null, 40)(g, w, h * 0.8);
  },
  '1,3': label('HL-8  HEAVY LIFT', '#ffffff', 'rgba(0,0,0,0.7)', 44),
  '2,3': plate('rgba(12,14,16,0.9)', '#e8ecef', [['UAS  JEV-RS', 0.28], ['CONCEPT AIRFRAME', 0.16]]),
  '3,3': label('1.5 L', '#1b1d20', null, 70, 'SUPPRESSANT'),
};

/** 4x4 decal atlas (flipY=false to match glTF UVs). */
export function decalAtlas(): THREE.Texture {
  if (!cache.decal) {
    const S = 1024, C = S / 4;
    const [c, g] = canvas(S);
    for (const [key, paint] of Object.entries(CELLS)) {
      const [col, row] = key.split(',').map(Number);
      const a = ASPECT[key] ?? 1;
      g.save();
      g.beginPath();
      g.rect(col * C, row * C, C, C);
      g.clip();
      g.translate(col * C, row * C);
      g.scale(1, a);
      paint(g, C, C / a);
      g.restore();
    }
    const t = tex(c, true, false);
    t.flipY = false;
    t.generateMipmaps = true;
    cache.decal = t;
  }
  return cache.decal;
}

/** Radial rotor-blur texture: faint disc, denser toward mid-span, clear hub. */
export function rotorBlurTexture(): THREE.Texture {
  if (!cache.blur) {
    const S = 256;
    const [c, g] = canvas(S);
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(20,22,24,0)');
    grd.addColorStop(0.1, 'rgba(20,22,24,0.05)');
    grd.addColorStop(0.35, 'rgba(24,26,28,0.55)');
    grd.addColorStop(0.75, 'rgba(24,26,28,0.35)');
    grd.addColorStop(0.95, 'rgba(40,42,44,0.28)');
    grd.addColorStop(1, 'rgba(40,42,44,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 40; i++) {
      g.strokeStyle = `rgba(0,0,0,${0.08 + (i % 3) * 0.04})`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(S / 2, S / 2, S * (0.12 + i * 0.0095), 0, Math.PI * 2);
      g.stroke();
    }
    cache.blur = tex(c, true, false);
  }
  return cache.blur;
}

/** Tiny HDR sky/ground equirect matching the smoky field lighting (for PBR reflections). */
export function fieldEnvironment(): THREE.Texture {
  if (!cache.env) {
    const W = 128, H = 64;
    const data = new Float32Array(W * H * 4);
    const sun = new THREE.Vector3(-0.7, 0.18, 0.3).normalize();
    const top = new THREE.Color(0x2c3c52), hor = new THREE.Color(0xb49e8a), gnd = new THREE.Color(0x2e2822);
    const c = new THREE.Color(), d = new THREE.Vector3();
    for (let j = 0; j < H; j++) {
      const el = ((j + 0.5) / H - 0.5) * Math.PI;
      for (let i = 0; i < W; i++) {
        const az = ((i + 0.5) / W - 0.5) * Math.PI * 2;
        d.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
        if (d.y >= 0) c.copy(hor).lerp(top, Math.pow(Math.min(1, d.y / 0.6), 0.6));
        else c.copy(hor).lerp(gnd, Math.min(1, -d.y * 6));
        const s = Math.max(0, d.dot(sun));
        const o = (j * W + i) * 4;
        data[o] = c.r + Math.pow(s, 200) * 40 + Math.pow(s, 8) * 0.4;
        data[o + 1] = c.g + Math.pow(s, 200) * 28 + Math.pow(s, 8) * 0.25;
        data[o + 2] = c.b + Math.pow(s, 200) * 16 + Math.pow(s, 8) * 0.12;
        data[o + 3] = 1;
      }
    }
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.LinearSRGBColorSpace;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    cache.env = t;
  }
  return cache.env;
}
