/**
 * TECH / REAL-WORLD DESIGN: exploded 3D drone + specification table. Every value is
 * tagged PUBLIC SPECIFICATION, SIMULATION ASSUMPTION or CONCEPTUAL DESIGN.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DRONE } from '../config';
import { capacity, loadout } from '../sim/loadout/catalogue';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Role } from '../sim/drone';
import { AIRFRAMES, buildDroneAssembly, ROLE_COLOR, type Airframe } from '../render/droneRender';
import { currentDroneModels, loadDroneModels, type DroneModels } from '../render/drone/models';
import { createDroneMaterials, type DroneMaterials } from '../render/drone/materials';
import { disposeMaterials } from '../render/drone/assembly';

type Tag = 'pub' | 'sim' | 'con';
const TAGNAME: Record<Tag, string> = { pub: 'PUBLIC SPEC', sim: 'SIM ASSUMPTION', con: 'CONCEPT' };

const SPECS: [string, string, Tag][] = [
  ['AIRFRAME', 'Holybro X500 V2 class quadcopter, 500 mm wheelbase, carbon-fibre plates & 16 mm arms', 'pub'],
  ['FRAME WEIGHT', '610 g (kit, per manufacturer)', 'pub'],
  ['MOTORS', '2216 KV920 brushless ×4, 20 A BLHeli S ESCs', 'pub'],
  ['PROPELLERS', '1045 (10 in × 4.5 in pitch)', 'pub'],
  ['BATTERY', '4S LiPo 3000–5000 mAh (manufacturer recommendation)', 'pub'],
  ['HOVER ENDURANCE', '~18 min, no payload, 5000 mAh (manufacturer test)', 'pub'],
  ['PAYLOAD CAPACITY', '1500 g without battery at 70 % throttle (manufacturer)', 'pub'],
  ['SIM ENDURANCE', `${DRONE.enduranceMin} min nominal, reduced by speed and payload`, 'sim'],
  ['SIM MAX SPEED', `${DRONE.maxSpeed} m/s horizontal, ${DRONE.maxClimb} m/s climb, ${DRONE.maxAccel} m/s² accel`, 'sim'],
  ['SIM RANGE', 'Command post radio 820 m; airborne relay +650 m per hop', 'sim'],
  ['SUPPRESSANT PAYLOAD', `Set per loadout (title screen → SUPPRESSION LOADOUT / CATALOGUE). Agent per sortie = (payload − dispenser hardware) ÷ density: an X500-class quad carries ≈ ${capacity(loadout('X500', 'WATER')).toFixed(1)} L of water; the heavy-lift concept ≈ ${capacity(loadout('HEAVY', 'WATER')).toFixed(0)} L. The cinematic demo keeps the legacy "120 L equivalent" abstraction`, 'sim'],
  ['SIM BATTERY SWAP', `${DRONE.batterySwapSec} s hot-swap at command post`, 'sim'],
  ['AUTOPILOT', 'PX4 flight stack on a Pixhawk-class controller (PX4 X500 V2 dev-kit configuration)', 'con'],
  ['COMPANION COMPUTER', 'Onboard Linux computer (ROS 2 / MAVLink bridge) running local autonomy; Jev tasks arrive as missions', 'con'],
  ['THERMAL CAMERA', 'Radiometric LWIR core, ~640×512 class, on 2-axis gimbal', 'con'],
  ['RGB CAMERA', 'Global-shutter RGB for verification and mapping', 'con'],
  ['DEPTH SENSOR', 'Forward stereo depth for low-altitude obstacle avoidance', 'con'],
  ['GNSS', 'Multi-band GNSS + compass on mast', 'con'],
  ['RADIO', 'Telemetry radio + mesh data link (relay role adds high-gain mesh node)', 'con'],
  ['PAYLOAD MODULE', 'Swappable rail-mounted modules: gimbal, supply pod, relay mast, suppression tank', 'con'],
];

const REFS: [string, string][] = [
  ['PX4 Autopilot — documentation', 'https://docs.px4.io/main/en/'],
  ['PX4 — Holybro X500 V2 + Pixhawk 6C dev kit', 'https://docs.px4.io/main/en/frames_multicopter/holybro_x500v2_pixhawk6c.html'],
  ['Holybro X500 V2 kit (manufacturer page)', 'https://holybro.com/products/x500-v2-kits'],
  ['PX4 ROS 2 user guide', 'https://docs.px4.io/main/en/ros2/'],
  ['ArduPilot Copter', 'https://ardupilot.org/copter/'],
  ['MAVLink protocol', 'https://mavlink.io/en/'],
  ['ROS 2 documentation', 'https://docs.ros.org/en/rolling/'],
  ['Gazebo simulator', 'https://gazebosim.org/'],
  ['OpenDroneMap', 'https://www.opendronemap.org/'],
  ['TypeSafe Jev (System One) API', 'https://docs.typesafe.ai/api'],
];

interface Part { name: string; label: string; mesh: THREE.Object3D; explode: THREE.Vector3; anchor: THREE.Vector3 }

export class TechPage {
  private root = document.getElementById('tech-page')!;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.01, 80);
  private controls: OrbitControls | null = null;
  private parts: Part[] = [];
  private labels: HTMLDivElement[] = [];
  private raf = 0;
  private t = 0;
  private airframe: Airframe = 'LIGHT';
  private role: Role = 'SUPPRESSION';
  private models: DroneModels = currentDroneModels();
  private model = new THREE.Group();
  private mats: DroneMaterials | null = null;
  private grid: THREE.GridHelper | null = null;
  private shadow: THREE.Mesh | null = null;
  private view!: HTMLDivElement;
  onClose: (() => void) | null = null;

  open(): void {
    this.root.classList.remove('hidden');
    if (!this.renderer) this.build();
    this.resize();
    cancelAnimationFrame(this.raf);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  close(): void {
    this.root.classList.add('hidden');
    cancelAnimationFrame(this.raf);
    this.onClose?.();
  }

  /**
   * Show an airframe on the exploded view: 'LIGHT' (X500-class quad + role payload) or
   * 'HEAVY' (coaxial X8 heavy-lift suppression platform, shown beside a LIGHT quad for scale).
   */
  setModel(airframe: Airframe, role: Role = this.role): void {
    this.airframe = airframe;
    this.role = role;
    if (!this.renderer) return;
    this.scene.remove(this.model);
    if (this.mats) disposeMaterials(this.mats);
    for (const l of this.labels) l.remove();
    this.labels = [];
    this.parts = [];
    this.model = new THREE.Group();
    this.scene.add(this.model);
    this.mats = createDroneMaterials({ tint: ROLE_COLOR[airframe === 'HEAVY' ? 'SUPPRESSION' : role] });
    const a = buildDroneAssembly(this.models, airframe, role, this.mats);
    this.model.add(a.group);
    for (const p of a.parts) this.parts.push({ name: p.name, label: p.label, mesh: p.object, explode: p.explode, anchor: p.anchor });
    const spec = AIRFRAMES[airframe];
    if (airframe === 'HEAVY') {
      const ref = buildDroneAssembly(this.models, 'LIGHT', 'SUPPRESSION', this.mats);
      ref.group.position.set(-(a.radius + 0.55), AIRFRAMES.LIGHT.footDepth - spec.footDepth, -0.4);
      ref.group.userData.fixed = true;
      this.model.add(ref.group);
      this.parts.push({ name: 'scale-ref', label: 'X500-CLASS QUAD · SCALE REFERENCE', mesh: ref.group, explode: new THREE.Vector3(), anchor: ref.group.position.clone().add(new THREE.Vector3(0, 0.3, 0)) });
    }
    for (const p of this.parts) {
      if (!p.label) continue;
      const l = document.createElement('div');
      l.className = 'tp-label';
      l.textContent = p.label;
      this.view.append(l);
      this.labels.push(l);
      p.mesh.userData.labelEl = l;
    }
    // Ground, 10 cm grid and camera framing at real-world scale.
    const floor = -spec.footDepth;
    this.grid!.position.y = floor;
    this.shadow!.position.y = floor + 0.001;
    const dist = a.radius * (airframe === 'HEAVY' ? 3.3 : 4.2);
    const dir = this.camera.position.clone().sub(this.controls!.target).normalize();
    if (dir.lengthSq() < 0.5) dir.set(0.62, 0.38, 0.69);
    this.controls!.target.set(airframe === 'HEAVY' ? -0.35 : 0, -0.03, 0);
    this.camera.position.copy(this.controls!.target).addScaledVector(dir, dist);
    this.controls!.minDistance = a.radius * 1.2;
    this.controls!.maxDistance = a.radius * 8;
    const cap = this.root.querySelector('.tp-caption') as HTMLDivElement;
    cap.textContent = `${spec.label} · WHEELBASE ${Math.round(spec.wheelbase * 1000)} MM · PROPS ${Math.round(spec.propDiameter / 0.0254)} IN · GRID 10 CM${this.models.detailed ? '' : ' · LOADING DETAIL...'}`;
    this.root.querySelectorAll<HTMLButtonElement>('.tp-models button').forEach((b) => {
      b.classList.toggle('on', b.dataset.af ? b.dataset.af === airframe : b.dataset.role === role);
      if (b.dataset.role) b.style.display = airframe === 'HEAVY' ? 'none' : '';
    });
    this.t = 0;
  }

  private build(): void {
    const tagHtml = (t: Tag) => `<i class="tag ${t}">${TAGNAME[t]}</i>`;
    const btn = (attr: string, text: string) => `<button class="tog" ${attr}>${text}</button>`;
    const roles: Role[] = ['SCOUT', 'SUPPRESSION', 'LOGISTICS', 'RELAY'];
    this.root.innerHTML = `
      <div class="tp-view"><button class="tog tp-close">← BACK TO SIMULATION</button>
        <div class="tp-models" style="position:absolute;top:18px;right:18px;z-index:2;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:70%">
          ${btn('data-af="LIGHT"', 'LIGHT QUAD')}${btn('data-af="HEAVY"', 'HEAVY X8')}${roles.map((r) => btn(`data-role="${r}"`, r)).join('')}
        </div>
        <div class="tp-caption" style="position:absolute;left:22px;bottom:18px;z-index:2;font-family:var(--mono);font-size:10.5px;letter-spacing:0.1em;color:var(--muted)"></div>
      </div>
      <div class="tp-side">
        <h2>TECH / REAL-WORLD DESIGN</h2>
        <div class="tp-sub">How the simulated aircraft could map onto open, publicly documented hardware and software. This is a concept reference, not build or certification guidance.</div>
        <div class="tp-legend">${tagHtml('pub')} manufacturer / project documentation ${tagHtml('sim')} value used by this simulation ${tagHtml('con')} proposed architecture</div>
        <table class="tp-table">${SPECS.map(([k, v, t]) => `<tr><td>${k}</td><td>${v}</td><td>${tagHtml(t)}</td></tr>`).join('')}</table>
        <h3>SOFTWARE ARCHITECTURE</h3>
        <div class="tp-note">Deterministic layers fly the aircraft: PX4 handles stabilisation and waypoint following; the companion computer runs sensing, collision avoidance and task execution. Jev sits above them as a coordinator: it receives a structured summary of the incident (objectives, fire prediction, swarm status) and returns typed judgments — a Choice of top priority and a Score of urgency per objective — which ordinary code turns into task assignments. Jev never controls motors or flight paths.</div>
        <h3>REFERENCES</h3>
        <ul>${REFS.map(([n, u]) => `<li><a href="${u}" target="_blank" rel="noopener">${n}</a></li>`).join('')}</ul>
      </div>`;
    this.root.querySelector('.tp-close')!.addEventListener('click', () => this.close());
    this.root.querySelectorAll<HTMLButtonElement>('.tp-models button').forEach((b) =>
      b.addEventListener('click', () => this.setModel((b.dataset.af as Airframe | undefined) ?? this.airframe, (b.dataset.role as Role | undefined) ?? this.role)));
    this.view = this.root.querySelector('.tp-view') as HTMLDivElement;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.view.append(r.domElement);
    // Procedural studio environment so metals, clear-coat carbon and lenses read correctly.
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    pmrem.dispose();
    this.camera.position.set(1.25, 0.75, 1.45);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.6;
    this.scene.add(new THREE.HemisphereLight(0xdfe8ef, 0x303030, 0.9));
    const rim = new THREE.DirectionalLight(0x9fd8e6, 1.4);
    rim.position.set(-2, 1.5, -2);
    this.scene.add(rim);
    const key = new THREE.DirectionalLight(0xfff4e8, 2.4);
    key.position.set(2, 4, 1.5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 12 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.01;
    this.scene.add(key);
    this.grid = new THREE.GridHelper(8, 80, 0x2a3238, 0x161b1f);
    this.scene.add(this.grid);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.35 }));
    this.shadow.receiveShadow = true;
    this.scene.add(this.shadow);
    this.setModel(this.airframe, this.role);
    void loadDroneModels().then((m) => {
      this.models = m;
      this.setModel(this.airframe, this.role);
    });
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    if (!this.renderer) return;
    const w = this.view.clientWidth, h = this.view.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    if (!this.renderer) return;
    this.t += 1 / 60;
    const k = (0.5 - 0.5 * Math.cos(Math.min(1, Math.max(0, this.t - 0.6) / 2.2) * Math.PI)) * (this.airframe === 'LIGHT' ? 0.75 : 1);
    const w = this.view.clientWidth, h = this.view.clientHeight;
    const v = new THREE.Vector3();
    for (const p of this.parts) {
      const fixed = !!p.mesh.userData.fixed;
      if (!fixed) p.mesh.position.copy(p.explode).multiplyScalar(k);
      if (p.name.startsWith('props')) p.mesh.children.forEach((c) => c.rotateY(0.025 * (c.userData.spin ?? 1)));
      const l = p.mesh.userData.labelEl as HTMLDivElement | undefined;
      if (!l) continue;
      v.copy(p.anchor).addScaledVector(p.explode, fixed ? 0 : k).project(this.camera);
      l.style.left = `${((v.x + 1) / 2) * w}px`;
      l.style.top = `${((1 - v.y) / 2) * h}px`;
      l.style.opacity = this.t > 2.4 && v.z < 1 ? '1' : '0';
    }
    this.controls!.update();
    this.renderer.render(this.scene, this.camera);
  }
}
