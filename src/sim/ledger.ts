/**
 * Suppression ledger: what was carried, released, landed on target and landed where it
 * mattered, how long delivery cycles took, and what it cost (cost inputs are ASSUMPTION
 * placeholders from the catalogue).
 */
import { capacity, isAbstract, type Loadout } from './loadout/catalogue';
import type { Application } from './suppression';

export interface SuppressionSummary {
  loadout: string;
  unit: string;
  capacityPerSortie: number;
  sorties: number;
  released: number;
  onTarget: number;
  effective: number;
  onTargetPct: number;
  effectivePct: number;
  throughputPerMin: number; // on-target delivery per minute over the active period
  meanCycleSec: number;
  meanQueueSec: number;
  firstEffectiveSec: number;
  knockdowns: number;
  reignitions: number;
  extinguished: number;
  flightHours: number;
  costAgent: number;
  costFleet: number;
  costTotal: number;
  fleetCapex: number;
  abstract: boolean;
}

export class Ledger {
  sorties = 0;
  released = 0;
  onTarget = 0;
  effective = 0;
  firstDropT = Infinity;
  lastDropT = 0;
  firstEffectiveT = Infinity;
  cycles: number[] = [];
  queueSec = 0;
  queueEvents = 0;
  flightSec = 0;
  private lastDrop = new Map<string, number>();

  constructor(readonly lo: Loadout) {}

  record(a: Application, t: number, droneId: string): void {
    this.sorties++;
    this.released += a.released;
    this.onTarget += a.onTarget;
    this.effective += a.effective;
    this.firstDropT = Math.min(this.firstDropT, t);
    this.lastDropT = Math.max(this.lastDropT, t);
    if (a.effective > 0) this.firstEffectiveT = Math.min(this.firstEffectiveT, t);
    const prev = this.lastDrop.get(droneId);
    if (prev !== undefined) this.cycles.push(t - prev);
    this.lastDrop.set(droneId, t);
  }

  queued(sec: number): void {
    this.queueSec += sec;
    this.queueEvents++;
  }

  summary(fire: { knockdowns: number; reignitions: number; extinguished: number }, suppressionDrones: number): SuppressionSummary {
    const { platform: pf, agent: ag } = this.lo;
    const active = Math.max(60, this.lastDropT - this.firstDropT);
    const hours = this.flightSec / 3600;
    const costAgent = this.released * ag.cost.v;
    const costFleet = hours * (pf.unitCost.v / Math.max(1, pf.lifeHours.v) + pf.opsPerHour.v);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    return {
      loadout: `${pf.name} · ${ag.name}`,
      unit: ag.unit,
      capacityPerSortie: capacity(this.lo),
      sorties: this.sorties,
      released: this.released,
      onTarget: this.onTarget,
      effective: this.effective,
      onTargetPct: this.released ? this.onTarget / this.released : 0,
      effectivePct: this.released ? this.effective / this.released : 0,
      throughputPerMin: this.sorties > 1 ? this.onTarget / (active / 60) : this.onTarget,
      meanCycleSec: mean(this.cycles),
      meanQueueSec: this.queueEvents ? this.queueSec / this.queueEvents : 0,
      firstEffectiveSec: this.firstEffectiveT,
      knockdowns: fire.knockdowns,
      reignitions: fire.reignitions,
      extinguished: fire.extinguished,
      flightHours: hours,
      costAgent,
      costFleet,
      costTotal: costAgent + costFleet,
      fleetCapex: suppressionDrones * pf.unitCost.v,
      abstract: isAbstract(this.lo),
    };
  }
}
