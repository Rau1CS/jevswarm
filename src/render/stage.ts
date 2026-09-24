/**
 * Renderer, scene, lights, sky and post-processing. View modes change grading:
 * WORLD (cinematic), JEV (desaturated command view), THERMAL (ironbow palette).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type ViewMode = 'WORLD' | 'JEV' | 'THERMAL';
export type Quality = 'HIGH' | 'MEDIUM' | 'LOW';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uMode: { value: 0 }, // 0 world, 1 jev, 2 thermal
    uTime: { value: 0 },
    uVignette: { value: 0.9 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uMode; uniform float uTime; uniform float uVignette;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    vec3 ironbow(float t){
      t = clamp(t, 0.0, 1.0);
      vec3 c0 = vec3(0.02,0.01,0.06), c1 = vec3(0.30,0.02,0.45), c2 = vec3(0.80,0.10,0.25),
           c3 = vec3(0.98,0.45,0.05), c4 = vec3(1.0,0.85,0.25), c5 = vec3(1.0,1.0,0.92);
      if (t < 0.2) return mix(c0,c1,t/0.2);
      if (t < 0.45) return mix(c1,c2,(t-0.2)/0.25);
      if (t < 0.7) return mix(c2,c3,(t-0.45)/0.25);
      if (t < 0.88) return mix(c3,c4,(t-0.7)/0.18);
      return mix(c4,c5,(t-0.88)/0.12);
    }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      float l = dot(col, vec3(0.299,0.587,0.114));
      if (uMode > 1.5) {
        col = ironbow(pow(l, 1.3) * 1.08);
        col += (hash(vUv * 900.0 + uTime) - 0.5) * 0.035;
      } else if (uMode > 0.5) {
        vec3 g = vec3(l);
        col = mix(g, col, 0.35) * vec3(0.78, 0.86, 0.9);
        col = mix(col, col * vec3(0.9,1.0,1.02), 0.5);
      } else {
        // Subtle filmic grade: warm highlights, cool shadows.
        col = mix(col, col * vec3(0.92, 0.97, 1.06), 1.0 - smoothstep(0.0, 0.5, l));
        col = mix(col, col * vec3(1.05, 1.0, 0.94), smoothstep(0.5, 1.0, l));
        col += (hash(vUv * 1300.0 + uTime) - 0.5) * 0.012;
      }
      vec2 d = vUv - 0.5;
      col *= mix(1.0, 1.0 - dot(d, d) * 1.2, uVignette);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const SkyShader = {
  uniforms: {
    uTop: { value: new THREE.Color(0x223044) },
    uHorizon: { value: new THREE.Color(0x9c8878) },
    uSmoke: { value: new THREE.Color(0x5a4638) },
    uSunDir: { value: new THREE.Vector3(-0.7, 0.18, 0.3).normalize() },
    uThermal: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uTop, uHorizon, uSmoke, uSunDir; uniform float uThermal; varying vec3 vDir;
    void main(){
      float h = clamp(vDir.y, -0.1, 1.0);
      vec3 col = mix(uHorizon, uTop, pow(smoothstep(-0.02, 0.55, h), 0.7));
      float smokeBand = smoothstep(0.35, -0.02, h) * (0.55 + 0.45 * smoothstep(-0.2, 0.8, dot(normalize(vDir.xz), vec2(-0.8, -0.2))));
      col = mix(col, uSmoke, smokeBand * 0.6);
      float s = max(dot(normalize(vDir), uSunDir), 0.0);
      col += vec3(1.0, 0.6, 0.3) * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.25);
      col = mix(col, vec3(0.03), uThermal);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fireLights: THREE.PointLight[] = [];
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  mode: ViewMode = 'WORLD';
  quality: Quality = 'HIGH';
  private fog: THREE.FogExp2;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.3;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 9000);
    this.camera.position.set(-1500, 900, 1400);
    this.fog = new THREE.FogExp2(0x8c7b6c, 0.00022);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0x3a3a40);

    this.skyMat = new THREE.ShaderMaterial({ ...SkyShader, side: THREE.BackSide, depthWrite: false, fog: false });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(6000, 32, 16), this.skyMat);
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffc9a0, 2.4);
    this.sun.position.set(-1400, 450, 600);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -520;
    sc.right = sc.top = 520;
    sc.near = 10;
    sc.far = 4000;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 1.2;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xa9bacb, 0x4a3a2a, 1.15);
    this.scene.add(this.hemi);
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xff7a2a, 0, 420, 1.2);
      this.fireLights.push(l);
      this.scene.add(l);
    }

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.42, 0.5, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  /** Pixel-size factor for point sprites: pixels per world unit at distance 1. */
  get pointScale(): number {
    return (this.renderer.domElement.height) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  setMode(m: ViewMode): void {
    this.mode = m;
    this.grade.uniforms.uMode.value = m === 'WORLD' ? 0 : m === 'JEV' ? 1 : 2;
    this.skyMat.uniforms.uThermal.value = m === 'THERMAL' ? 1 : 0;
    this.fog.color.set(m === 'THERMAL' ? 0x050508 : m === 'JEV' ? 0x2a3038 : 0x8c7b6c);
    this.fog.density = m === 'JEV' ? 0.00016 : 0.00022;
    this.hemi.intensity = m === 'THERMAL' ? 0.25 : 1.15;
    this.sun.intensity = m === 'THERMAL' ? 0.3 : m === 'JEV' ? 1.6 : 2.4;
    this.bloom.strength = m === "THERMAL" ? 0.3 : 0.42;
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.renderer.setPixelRatio(q === 'HIGH' ? Math.min(window.devicePixelRatio, 1.5) : q === 'MEDIUM' ? 1 : 0.8);
    this.renderer.shadowMap.enabled = q !== 'LOW';
    this.sun.castShadow = q !== 'LOW';
    this.bloom.enabled = q !== 'LOW';
    this.resize();
  }

  /** Keep the shadow frustum centred on what the camera is looking at. */
  focusShadow(target: THREE.Vector3): void {
    const off = new THREE.Vector3(-1400, 450, 600).normalize().multiplyScalar(1600);
    this.sun.position.copy(target).add(off);
    this.sun.target.position.copy(target);
  }

  render(t: number): void {
    this.grade.uniforms.uTime.value = t % 100;
    this.sky.position.copy(this.camera.position);
    this.composer.render();
  }
}
