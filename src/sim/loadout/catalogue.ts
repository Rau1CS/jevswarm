/**
 * Platform + suppressant catalogue. Every parameter carries its provenance:
 *   PUBLIC      published figure (source given)
 *   SIM         modelling assumption chosen for this simulation (uncalibrated)
 *   CONCEPT     hypothetical platform class, not a specific product
 *   ASSUMPTION  placeholder (mostly costs) to be replaced with real quotes
 * Nothing here is a manufacturer claim unless tagged PUBLIC. See docs/SUPPRESSION_MODEL.md.
 */

export type Prov = 'PUBLIC' | 'SIM' | 'CONCEPT' | 'ASSUMPTION';
export interface P<T = number> { v: T; tag: Prov; note?: string; src?: string }
const p = <T>(v: T, tag: Prov, note?: string, src?: string): P<T> => ({ v, tag, note, src });

export const SRC = {
  x500: 'https://holybro.com/products/x500-v2-kits',
  redbook: 'https://www.nifc.gov/standards/guides/red-book',
  wfcs: 'https://www.fs.usda.gov/rm/fire/wfcs/',
  fsChem: 'https://www.fs.usda.gov/science-technology/fire/wildland-fire-chemicals',
  rothermel: 'https://research.fs.usda.gov/treesearch/55928',
  seneca: 'https://seneca.com/',
  senecaAspen: 'https://www.militaryaerospace.com/uncrewed/article/55359690/aspen-fire-acquires-autonomous-wildfire-suppression-system-from-seneca',
  rain: 'https://www.rain.aero/updates/autonomous-wildfire-suppression-in-california',
  cord: 'https://cord.ethz.ch/',
  stanfordGel: 'https://news.stanford.edu/stories/2024/08/new-gels-could-protect-buildings-during-wildfires',
} as const;

/** Real systems the concept is compared against (context only — none of their figures drive the physics). */
export const REFERENCE_SYSTEMS: { name: string; what: string; src: string }[] = [
  { name: 'Seneca', what: 'Purpose-built suppression drones in five-aircraft strike teams: thermal detection + directed aerated Class A foam. Aspen Fire Protection District acquisition announced 2026.', src: SRC.senecaAspen },
  { name: 'Rain + Sikorsky', what: 'Autonomous targeting and water drops from an optionally piloted Black Hawk, incl. live brush-pile tests in California (2025). Helicopter-scale payload, not a small-drone swarm.', src: SRC.rain },
  { name: 'ETH Zürich CORD', what: 'Student research prototype: two drones tethered to a fire truck by a line carrying water, power and data (high-rise focus). Design targets, not delivered specs.', src: SRC.cord },
  { name: 'Stanford aerogel gel (2024)', what: 'Water-enhancing gel that leaves an insulating silica aerogel after drying; tested as a protective coating on plywood, not dropped by drones.', src: SRC.stanfordGel },
];

// ───────────────────────── Suppressants ─────────────────────────

export type AgentId = 'WATER' | 'FOAM_A' | 'GEL' | 'LTR' | 'DRY_CHEM' | 'ABSTRACT';
/** DIRECT = attack burning fuel; PRETREAT = treat unburned fuel ahead of the fire. */
export type Mission = 'DIRECT' | 'PRETREAT';
export type RefillSource = 'LAKE_OR_STATION' | 'STATION';

export interface Agent {
  id: AgentId;
  name: string;
  unit: 'L' | 'kg';
  mission: Mission;
  /** Ready-to-apply density (kg per L of carried mixture). */
  density: P;
  /** Multiplier on the fraction of released agent that lands on the intended fuel (drift/cohesion). */
  landing: P;
  /** Contact efficiency: 1 = plain water. >1 needs less agent per m² for the same knockdown. */
  contact: P;
  /** Water carried per L of mixture (cooling / moisture). 0 for dry chemical. */
  water: P;
  /** Evaporation half-life multiplier for deposited water (retention on fuel). */
  retention: P;
  /** Persistent retardant salts per L of mixture (effect remains after the water dries). */
  salts: P;
  /** Residual heat left in a knocked-down cell (0..1): high = likely to rekindle without cooling. */
  residualHeat: P;
  refill: RefillSource;
  cost: P; // $ per unit of ready-to-apply agent
  notes: string[];
}

export const AGENTS: Record<AgentId, Agent> = {
  WATER: {
    id: 'WATER', name: 'Plain water (baseline)', unit: 'L', mission: 'DIRECT',
    density: p(1.0, 'PUBLIC', '≈1 kg per litre (physical constant)'),
    landing: p(1.0, 'SIM', 'baseline'),
    contact: p(1.0, 'SIM', 'baseline'),
    water: p(1.0, 'SIM', 'all carried liquid is water'),
    retention: p(1.0, 'SIM', 'baseline evaporation'),
    salts: p(0, 'SIM'),
    residualHeat: p(0.45, 'SIM', 'knocked-down fuel still holds heat; cooling decides rekindling'),
    refill: 'LAKE_OR_STATION',
    cost: p(0, 'ASSUMPTION', 'water treated as free; pumping/transport not costed'),
    notes: ['Clean performance baseline for every comparison.'],
  },
  FOAM_A: {
    id: 'FOAM_A', name: 'Wet Class A foam', unit: 'L', mission: 'DIRECT',
    density: p(1.0, 'SIM', 'carried as liquid foam solution — expanded foam is mostly air and is NOT counted as extra water'),
    landing: p(0.95, 'SIM', 'aerated discharge drifts slightly more than a solid stream (uncalibrated)'),
    contact: p(1.25, 'SIM', 'wetting agent improves penetration/adhesion; UNCALIBRATED placeholder, not a published multiplier', SRC.fsChem),
    water: p(1.0, 'SIM'),
    retention: p(1.3, 'SIM', 'foam holds water on surfaces a little longer; benefit ends once the water evaporates', SRC.fsChem),
    salts: p(0, 'SIM', 'not a long-term retardant'),
    residualHeat: p(0.4, 'SIM'),
    refill: 'STATION',
    cost: p(0.05, 'ASSUMPTION', '$/L of finished solution — placeholder'),
    notes: [
      'Needs proportioning at a refill station (concentrate + water) and heavier dispensing hardware.',
      'Jurisdiction: the 2026 US Interagency Red Book (p. 166) states aerial application of foam is no longer approved on Federal jurisdictional lands — do not assume it is allowed everywhere.',
    ],
  },
  GEL: {
    id: 'GEL', name: 'Water-enhancing gel', unit: 'L', mission: 'DIRECT',
    density: p(1.0, 'SIM', 'still fundamentally water; mixture density ≈ water'),
    landing: p(1.12, 'SIM', 'more cohesive → less drift during aerial delivery (direction per USFS; magnitude uncalibrated)', SRC.wfcs),
    contact: p(1.1, 'SIM', 'adheres to fuel; UNCALIBRATED'),
    water: p(1.0, 'SIM'),
    retention: p(2.0, 'SIM', 'retains water on fuel longer; conventional gels still dry out (uncalibrated)', SRC.wfcs),
    salts: p(0, 'SIM'),
    residualHeat: p(0.4, 'SIM'),
    refill: 'STATION',
    cost: p(0.4, 'ASSUMPTION', '$/L mixed — placeholder'),
    notes: ['Useful for payload-limited drones: wasting less of each load can matter as much as carrying more.'],
  },
  LTR: {
    id: 'LTR', name: 'Long-term retardant', unit: 'L', mission: 'PRETREAT',
    density: p(1.1, 'SIM', 'mixed retardant is denser than water; exact value depends on product (uncalibrated)'),
    landing: p(1.05, 'SIM'),
    contact: p(0.8, 'SIM', 'not designed for direct flame attack'),
    water: p(0.85, 'SIM'),
    retention: p(1.0, 'SIM'),
    salts: p(1.0, 'SIM', 'salts alter combustion and remain effective after the water evaporates', SRC.fsChem),
    residualHeat: p(0.45, 'SIM'),
    refill: 'STATION',
    cost: p(0.5, 'ASSUMPTION', '$/L mixed — placeholder'),
    notes: [
      'Used to treat unburned fuel ahead of the fire; dose-dependent spread reduction, never guaranteed nonflammable; embers can still jump a treated strip.',
      'Coverage levels are specified in US gal / 100 ft² (1 ≈ 0.41 L/m²).',
    ],
  },
  DRY_CHEM: {
    id: 'DRY_CHEM', name: 'ABC dry chemical (experimental)', unit: 'kg', mission: 'DIRECT',
    density: p(1.0, 'SIM', 'capacity accounted in kg of powder'),
    landing: p(0.75, 'SIM', 'powder drifts in wind (uncalibrated)'),
    contact: p(1.8, 'SIM', 'fast flame knockdown on exposed surfaces (uncalibrated)'),
    water: p(0, 'SIM', 'no cooling, no fuel wetting'),
    retention: p(0, 'SIM'),
    salts: p(0, 'SIM'),
    residualHeat: p(0.85, 'SIM', 'flames out ≠ heat removed → high rekindle risk'),
    refill: 'STATION',
    cost: p(4, 'ASSUMPTION', '$/kg — placeholder'),
    notes: ['Experimental option for compact, exposed fires; knocking down visible flame is not extinguishment.'],
  },
  ABSTRACT: {
    id: 'ABSTRACT', name: 'Abstract suppressant (legacy demo)', unit: 'L', mission: 'DIRECT',
    density: p(1.0, 'CONCEPT'),
    landing: p(1.0, 'CONCEPT'),
    contact: p(1.0, 'CONCEPT'),
    water: p(1.0, 'CONCEPT'),
    retention: p(1.0, 'CONCEPT'),
    salts: p(0, 'CONCEPT'),
    residualHeat: p(0, 'CONCEPT'),
    refill: 'LAKE_OR_STATION',
    cost: p(0, 'ASSUMPTION'),
    notes: ['Original demo abstraction: a fixed −85 % intensity effect over ~40 m, NOT derived from delivered litres.'],
  },
};

// ───────────────────────── Platforms ─────────────────────────

export type PlatformId = 'X500' | 'HEAVY' | 'CONCEPT120';

export interface Platform {
  id: PlatformId;
  name: string;
  airframe: 'LIGHT' | 'HEAVY';
  /** Scouts can swap onto this platform's suppression module at base (same airframe). */
  modular: boolean;
  payloadKg: P;
  /** Tank, pump, nozzle, mounts — subtracted from payload before any agent is carried. */
  dispenserKg: P;
  enduranceMin: P;
  maxSpeed: P;
  /** Refill pump rate (L/s) at a station or lake dip. */
  pumpLps: P;
  /** Directed discharge rate (L/s) while hovering over the target. */
  dischargeLps: P;
  /** Fraction of released agent landing on the intended fuel at zero wind. */
  aim: P;
  unitCost: P; // $
  lifeHours: P;
  opsPerHour: P; // $ per flight hour: crew share, maintenance, batteries
  notes: string[];
}

export const PLATFORMS: Record<PlatformId, Platform> = {
  X500: {
    id: 'X500', name: 'X500 V2-class light quad', airframe: 'LIGHT', modular: true,
    payloadKg: p(1.5, 'PUBLIC', '1500 g without battery at 70 % throttle (manufacturer)', SRC.x500),
    dispenserKg: p(0.45, 'SIM', 'small tank, pump, nozzle, mounts'),
    enduranceMin: p(18, 'PUBLIC', '~18 min hover, no payload, 5000 mAh (manufacturer); drains faster loaded in sim', SRC.x500),
    maxSpeed: p(17, 'SIM'),
    pumpLps: p(0.5, 'SIM'),
    dischargeLps: p(0.25, 'SIM'),
    aim: p(0.75, 'SIM', 'thermal-guided directed discharge from low hover'),
    unitCost: p(2500, 'ASSUMPTION', 'airframe + autopilot + dispenser, placeholder'),
    lifeHours: p(300, 'ASSUMPTION'),
    opsPerHour: p(40, 'ASSUMPTION'),
    notes: ['Shows the payload limit: about one litre of agent per sortie.'],
  },
  HEAVY: {
    id: 'HEAVY', name: 'Heavy-lift suppression multirotor (concept class)', airframe: 'HEAVY', modular: false,
    payloadKg: p(28, 'CONCEPT', 'class of heavy-lift cargo/spray multirotors; not a specific product'),
    dispenserKg: p(8, 'SIM', 'tank, pump, hose, directed nozzle, mounts'),
    enduranceMin: p(14, 'SIM', 'loaded endurance of the class is short; uncalibrated'),
    maxSpeed: p(14, 'SIM'),
    pumpLps: p(1.5, 'SIM'),
    dischargeLps: p(2, 'SIM'),
    aim: p(0.75, 'SIM'),
    unitCost: p(45000, 'ASSUMPTION', 'placeholder — replace with quotes'),
    lifeHours: p(800, 'ASSUMPTION'),
    opsPerHour: p(120, 'ASSUMPTION'),
    notes: ['≈20 L ready-to-apply water per sortie, matching the research worked example (illustrative, not a spec).'],
  },
  CONCEPT120: {
    id: 'CONCEPT120', name: '120 L concept platform (legacy demo)', airframe: 'LIGHT', modular: true,
    payloadKg: p(150, 'CONCEPT', 'helicopter-scale payload drawn as a small drone — not realistic for a small multirotor'),
    dispenserKg: p(30, 'CONCEPT'),
    enduranceMin: p(18, 'SIM'),
    maxSpeed: p(17, 'SIM'),
    pumpLps: p(15, 'CONCEPT'),
    dischargeLps: p(120, 'CONCEPT', 'instant drop'),
    aim: p(1, 'CONCEPT'),
    unitCost: p(0, 'ASSUMPTION', 'not costed'),
    lifeHours: p(1, 'ASSUMPTION'),
    opsPerHour: p(0, 'ASSUMPTION'),
    notes: ['Kept so the cinematic demo plays as before. Its suppression effect is abstract.'],
  },
};

// ───────────────────────── Loadout ─────────────────────────

export interface Loadout { platform: Platform; agent: Agent }

export function loadout(platform: PlatformId, agent: AgentId): Loadout {
  return { platform: PLATFORMS[platform], agent: AGENTS[agent] };
}

/** Physical agent capacity: (payload − dispenser hardware) / density. Never negative. */
export function capacity(l: Loadout): number {
  return Math.max(0, (l.platform.payloadKg.v - l.platform.dispenserKg.v) / l.agent.density.v);
}

export const isAbstract = (l: Loadout) => l.agent.id === 'ABSTRACT';

/** Loadouts a user can pick (abstract agent only pairs with the concept platform). */
export const PICKABLE_PLATFORMS: PlatformId[] = ['HEAVY', 'X500', 'CONCEPT120'];
export const PICKABLE_AGENTS: AgentId[] = ['WATER', 'FOAM_A', 'GEL', 'LTR', 'DRY_CHEM'];

/** Wind-dependent landing fraction for one release. */
export function landingFraction(l: Loadout, windSpeed: number): number {
  const wind = Math.max(0.4, 1 - 0.045 * Math.max(0, windSpeed - 2) * (2 - l.agent.landing.v));
  return Math.min(0.95, l.platform.aim.v * l.agent.landing.v * wind);
}
