/** Generic CPU-simulated, GPU-rendered point-sprite particle pool with procedural styles. */
import * as THREE from 'three';
import { GLOBAL } from './thermal';

export type ParticleStyle = 'flame' | 'smoke' | 'ember' | 'water' | 'steam';

const FRAG: Record<ParticleStyle, string> = {
  flame: `
    vec2 p = gl_PointCoord * 2.0 - 1.0; p.y = -p.y;
    float n = vnoise(p * 3.0 + vec2(vSeed * 17.0, -uTime * 3.5 + vSeed * 5.0));
    float d = length(vec2(p.x * (1.2 + p.y * 0.5), p.y * 0.9 + 0.1)) + (n - 0.5) * 0.55;
    float a = smoothstep(1.0, 0.15, d) * pow(1.0 - vLife, 1.1) * smoothstep(0.0, 0.08, vLife);
    vec3 hot = vec3(1.0, 0.92, 0.65), mid = vec3(1.0, 0.45, 0.08), cool = vec3(0.75, 0.12, 0.03);
    vec3 col = mix(hot, mid, smoothstep(0.0, 0.22, vLife + d * 0.55));
    col = mix(col, cool, smoothstep(0.45, 0.95, vLife));
    gl_FragColor = vec4(col * 1.05, a * 0.62);`,
  smoke: `
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    float n = vnoise(p * 2.2 + vec2(vSeed * 31.0, vSeed * 7.0 + vLife * 1.4)) * 0.6 + vnoise(p * 5.0 + vSeed * 13.0) * 0.4;
    float a = smoothstep(1.0, 0.1, r + (n - 0.5) * 0.7) * smoothstep(0.0, 0.08, vLife) * (1.0 - smoothstep(0.55, 1.0, vLife));
    a *= mix(0.4, 0.08, uThermal);
    vec3 col = mix(vec3(0.16, 0.14, 0.12), vec3(0.46, 0.42, 0.38), smoothstep(0.04, 0.7, vLife) * (0.55 + 0.45 * n));
    col += vec3(0.9, 0.34, 0.08) * (1.0 - smoothstep(0.0, 0.12, vLife)) * 0.55 * (1.0 - uThermal);
    col = mix(col, vec3(0.12), uThermal);
    gl_FragColor = vec4(col, a);`,
  ember: `
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float a = smoothstep(1.0, 0.0, length(p)) * (1.0 - vLife) * (0.6 + 0.4 * sin(uTime * 30.0 + vSeed * 50.0));
    gl_FragColor = vec4(vec3(1.0, 0.55, 0.15) * 1.8, a);`,
  water: `
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float a = smoothstep(1.0, 0.2, length(p)) * 0.55 * (1.0 - vLife * 0.5);
    gl_FragColor = vec4(mix(vec3(0.75, 0.86, 0.95), vec3(0.2), uThermal), a);`,
  steam: `
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float n = vnoise(p * 2.5 + vec2(vSeed * 23.0, vLife * 2.0));
    float a = smoothstep(1.0, 0.1, length(p) + (n - 0.5) * 0.6) * smoothstep(0.0, 0.1, vLife) * (1.0 - vLife) * 0.45;
    gl_FragColor = vec4(mix(vec3(0.85, 0.87, 0.88), vec3(0.3), uThermal), a);`,
};

export class ParticlePool {
  readonly points: THREE.Points;
  readonly cap: number;
  pos: Float32Array; vel: Float32Array;
  life: Float32Array; max: Float32Array;
  s0: Float32Array; s1: Float32Array; seed: Float32Array;
  gravity = 0;
  drag = 0;
  private aLife: Float32Array; private aSize: Float32Array;
  private head = 0;
  private geo: THREE.BufferGeometry;
  readonly mat: THREE.ShaderMaterial;
  alive = 0;

  constructor(cap: number, style: ParticleStyle) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap).fill(1e9);
    this.max = new Float32Array(cap).fill(1);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.seed = new Float32Array(cap);
    this.aLife = new Float32Array(cap).fill(1);
    this.aSize = new Float32Array(cap);
    for (let i = 0; i < cap; i++) this.seed[i] = Math.random();
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aLife', new THREE.BufferAttribute(this.aLife, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    const additive = style === 'flame' || style === 'ember';
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 }, uTime: GLOBAL.uTime, uThermal: GLOBAL.uThermal, uJev: GLOBAL.uJev, uMaxPx: { value: 700 } },
      vertexShader: /* glsl */ `
        attribute float aLife; attribute float aSize; attribute float aSeed;
        uniform float uScale; uniform float uMaxPx;
        varying float vLife; varying float vSeed; varying float vNear;
        void main(){
          vLife = aLife; vSeed = aSeed;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vNear = smoothstep(30.0, 240.0, -mv.z);
          gl_PointSize = aLife >= 1.0 ? 0.0 : min(aSize * uScale / -mv.z, uMaxPx);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uThermal; uniform float uJev;
        varying float vLife; varying float vSeed; varying float vNear;
        float hsh(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5); }
        float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(hsh(i),hsh(i+vec2(1,0)),f.x), mix(hsh(i+vec2(0,1)),hsh(i+vec2(1,1)),f.x), f.y); }
        void main(){ ${FRAG[style]} ${style === 'smoke' || style === 'steam' ? 'gl_FragColor.a *= vNear * mix(1.0, 0.18, uJev);' : ''} if (gl_FragColor.a < 0.004) discard; }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = 0;
    this.max[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
  }

  /** Integrate; `onDeath` lets water spawn steam at impact. */
  update(dt: number, wx: number, wz: number, windCoupling: number, floor?: (x: number, z: number) => number, onHit?: (x: number, y: number, z: number) => void): void {
    let alive = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] >= this.max[i]) {
        this.aLife[i] = 1;
        continue;
      }
      alive++;
      this.life[i] += dt;
      const k = i * 3;
      this.vel[k] += (wx * windCoupling - this.vel[k]) * this.drag * dt;
      this.vel[k + 2] += (wz * windCoupling - this.vel[k + 2]) * this.drag * dt;
      this.vel[k + 1] += this.gravity * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const t = this.life[i] / this.max[i];
      this.aLife[i] = Math.min(t, 0.999);
      this.aSize[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      if (floor && this.pos[k + 1] < floor(this.pos[k], this.pos[k + 2])) {
        this.life[i] = this.max[i];
        onHit?.(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
      }
    }
    this.alive = alive;
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aLife as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
  }
}
