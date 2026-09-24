/**
 * TECH / REAL-WORLD DESIGN: exploded 3D drone + specification table. Every value is
 * tagged PUBLIC SPECIFICATION, SIMULATION ASSUMPTION or CONCEPTUAL DESIGN.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DRONE } from '../config';
import { buildDroneParts } from '../render/droneRender';

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
  ['SIM SUPPRESSANT', `${DRONE.suppressantLitres} L "equivalent" per sortie — represents a heavy-lift suppression platform, NOT an X500 (≈1.5 kg payload)`, 'sim'],
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

interface Part { name: string; mesh: THREE.Object3D; explode: THREE.Vector3; anchor: THREE.Vector3 }

export class TechPage {
  private root = document.getElementById('tech-page')!;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.01, 50);
  private controls: OrbitControls | null = null;
  private parts: Part[] = [];
  private labels: HTMLDivElement[] = [];
  private raf = 0;
  private t = 0;
  onClose: (() => void) | null = null;

  open(): void {
    this.root.classList.remove('hidden');
    if (!this.renderer) this.build();
    this.resize();
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

  private build(): void {
    const tagHtml = (t: Tag) => `<i class="tag ${t}">${TAGNAME[t]}</i>`;
    this.root.innerHTML = `
      <div class="tp-view"><button class="tog tp-close">← BACK TO SIMULATION</button></div>
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
    const view = this.root.querySelector('.tp-view') as HTMLDivElement;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    view.append(this.renderer.domElement);
    this.camera.position.set(1.25, 0.75, 1.45);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.6;
    this.controls.target.set(0, 0.02, 0);
    this.scene.add(new THREE.HemisphereLight(0xdfe8ef, 0x303030, 2.2));
    const rim = new THREE.DirectionalLight(0x9fd8e6, 1.6);
    rim.position.set(-2, 1.5, -2);
    this.scene.add(rim);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 3, 1.5);
    this.scene.add(key);
    const grid = new THREE.GridHelper(2, 20, 0x2a3238, 0x161b1f);
    grid.position.y = -0.3;
    this.scene.add(grid);

    const g = buildDroneParts();
    const mat = (c: number, m = 0.2) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: m });
    const add = (name: string, geo: THREE.BufferGeometry, color: number, explode: [number, number, number], anchor: [number, number, number]) => {
      const mesh = new THREE.Mesh(geo, mat(color));
      this.scene.add(mesh);
      this.parts.push({ name, mesh, explode: new THREE.Vector3(...explode), anchor: new THREE.Vector3(...anchor) });
    };
    add('FRAME', g.frame, 0x1c1e22, [0, 0, 0], [0.18, 0.0, -0.18]);
    const props = new THREE.Group();
    for (const [x, z] of g.motors) {
      const p = new THREE.Mesh(g.prop, mat(0x111214));
      p.position.set(x, 0.045, z);
      p.rotation.y = x * z > 0 ? 0.5 : -0.5;
      props.add(p);
    }
    this.scene.add(props);
    this.parts.push({ name: 'PROPELLERS', mesh: props, explode: new THREE.Vector3(0, 0.16, 0), anchor: new THREE.Vector3(0.177, 0.05, 0.177) });
    this.parts.push({ name: 'MOTORS', mesh: new THREE.Object3D(), explode: new THREE.Vector3(), anchor: new THREE.Vector3(-0.177, 0.02, 0.177) });
    add('BATTERY', new THREE.BoxGeometry(0.14, 0.045, 0.07), 0x3a4a5c, [0, 0.13, 0], [0, 0.1, 0]);
    add('FLIGHT CONTROLLER', new THREE.BoxGeometry(0.05, 0.016, 0.08), 0xd8d6d0, [0, 0.07, -0.02], [0, 0.04, 0]);
    add('COMPANION COMPUTER', new THREE.BoxGeometry(0.09, 0.02, 0.07), 0x2f6b4a, [0, -0.05, -0.14], [0, -0.02, -0.1]);
    add('RGB CAMERA', new THREE.BoxGeometry(0.03, 0.03, 0.03), 0x24272b, [0.06, -0.08, 0.14], [0.02, -0.07, 0.12]);
    add('THERMAL CAMERA', new THREE.BoxGeometry(0.034, 0.034, 0.03), 0x5a3a2a, [-0.06, -0.08, 0.14], [-0.02, -0.07, 0.12]);
    add('DEPTH SENSOR', new THREE.BoxGeometry(0.09, 0.022, 0.02), 0x30353a, [0, 0.02, 0.2], [0, 0.0, 0.15]);
    add('GPS', new THREE.CylinderGeometry(0.03, 0.03, 0.012, 16), 0xe0e0e0, [0, 0.2, -0.08], [0, 0.15, -0.08]);
    add('RADIO', new THREE.CylinderGeometry(0.004, 0.004, 0.12, 6), 0x9aa6b0, [0.1, 0.1, -0.14], [0.08, 0.06, -0.12]);
    add('PAYLOAD MODULE', g.payload.SUPPRESSION, 0xa8321f, [0, -0.16, 0], [0, -0.12, 0]);
    add('BODY', g.body, 0xd4d8db, [0, 0, 0], [0, 0, 0]);
    this.parts = this.parts.filter((p) => p.name !== 'BODY');
    for (const p of this.parts) {
      const l = document.createElement('div');
      l.className = 'tp-label';
      l.textContent = p.name;
      view.append(l);
      this.labels.push(l);
    }
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    if (!this.renderer) return;
    const view = this.root.querySelector('.tp-view') as HTMLDivElement;
    const w = view.clientWidth, h = view.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    if (!this.renderer) return;
    this.t += 1 / 60;
    const k = 0.5 - 0.5 * Math.cos(Math.min(1, this.t / 2.5) * Math.PI);
    const view = this.root.querySelector('.tp-view') as HTMLDivElement;
    const w = view.clientWidth, h = view.clientHeight;
    const v = new THREE.Vector3();
    this.parts.forEach((p, i) => {
      p.mesh.position.copy(p.explode).multiplyScalar(k * 1.6);
      if (p.name === 'PROPELLERS') p.mesh.children.forEach((c) => (c.rotation.y += 0.02));
      v.copy(p.anchor).add(p.explode.clone().multiplyScalar(k * 1.6));
      if (p.name === 'PAYLOAD MODULE') v.set(0, -0.12 - 0.16 * k * 1.6, 0);
      v.project(this.camera);
      this.labels[i].style.left = `${((v.x + 1) / 2) * w}px`;
      this.labels[i].style.top = `${((1 - v.y) / 2) * h}px`;
      this.labels[i].style.opacity = k > 0.6 ? '1' : '0';
    });
    this.controls!.update();
    this.renderer.render(this.scene, this.camera);
  }
}
