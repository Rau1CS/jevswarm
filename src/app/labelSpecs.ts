/** Builds the world-anchored label set for the current frame. */
import { BASE_POS, LAKE, SAFE_ZONE } from '../config';
import { heightAt, VILLAGE } from '../world/layout';
import type { Simulation } from '../sim/simulation';
import type { Drone } from '../sim/drone';
import type { LabelSpec } from '../ui/labels';
import type { ViewMode } from '../render/stage';
import { objectiveWeight } from '../jev/allocator';

const PLACES = [
  { key: 'p-base', x: BASE_POS.x + 40, z: BASE_POS.z - 60, text: 'COMMAND POST' },
  { key: 'p-safe', x: SAFE_ZONE.x, z: SAFE_ZONE.z - SAFE_ZONE.r - 10, text: 'SAFE ZONE' },
  { key: 'p-lake', x: LAKE.x, z: LAKE.z, text: 'WATER SOURCE' },
  { key: 'p-vil', x: VILLAGE.x + 60, z: VILLAGE.z - 160, text: 'VILLAGE' },
];

export function buildLabels(sim: Simulation, view: ViewMode, selected: Drone | null, hovered: Drone | null, highlight: Map<string, number>, now: number, replay: boolean): LabelSpec[] {
  const out: LabelSpec[] = [];
  for (const p of PLACES) out.push({ key: p.key, x: p.x, y: heightAt(p.x, p.z) + 40, z: p.z, html: p.text, cls: 'place', maxDist: 2600, priority: 1, w: p.text.length * 8 + 10 });

  for (const d of sim.drones) {
    const hi = (highlight.get(d.id) ?? 0) > now;
    const show = d === selected || d === hovered || hi || (view === 'JEV' && d.airborne);
    if (!show || d.status === 'CHARGING' || (d.status === 'LANDED' && d !== selected)) continue;
    const label = view === 'JEV' || hi || d === selected ? `${d.id} · ${d.task.label}` : d.id;
    out.push({ key: `d-${d.id}`, x: d.x, y: d.y + 8, z: d.z, html: label, cls: `drone${hi || d === selected ? ' hi' : ''}`, maxDist: view === 'JEV' ? 1700 : 1400, priority: d === selected ? 9 : hi ? 5 : 2, w: label.length * 6.4, h: 22 });
  }

  for (const det of sim.sensors.detections) {
    if (det.status === 'DISMISSED') continue;
    const y = heightAt(det.x, det.z) + 14;
    if (det.status === 'POSSIBLE') {
      const verifying = !replay && sim.drones.some((d) => d.task.detectionId === det.id && d.task.kind === 'VERIFY' && d.phase >= 1);
      out.push({
        key: `t-${det.id}`, x: det.x, y, z: det.z, cls: 'det', maxDist: 2200, priority: 6 + det.conf, w: 190, h: verifying ? 56 : 44,
        html: `<div class="t">POSSIBLE HUMAN</div>THERMAL CONFIDENCE ${Math.round(det.conf * 100)}%${verifying ? '<br/>VERIFYING…' : ''}`,
      });
    } else {
      const civ = sim.civilians.find((c) => c.id === det.truthCivId);
      if (civ?.behavior === 'SAFE') continue;
      const recent = !!civ && sim.t - civ.confirmedAt < 14;
      if (!recent && view !== 'JEV' && civ?.behavior !== 'GUIDED') continue;
      out.push({
        key: `t-${det.id}`, x: civ?.x ?? det.x, y: y + 16, z: civ?.z ?? det.z, cls: 'det conf', maxDist: 2200, priority: recent ? 8 : 3, w: 170, h: 44,
        html: `<div class="t">${recent ? 'HUMAN CONFIRMED' : 'CONFIRMED'}</div>${civ?.behavior === 'GUIDED' ? 'GUIDED TO SAFE ZONE' : det.sector}`,
      });
    }
  }

  if (view === 'JEV' && sim.coordinator.judgment && !replay) {
    const j = sim.coordinator.judgment;
    const objs = [...sim.coordinator.objectives]
      .filter((o) => o.kind !== 'SEARCH')
      .sort((a, b) => objectiveWeight(b, j) - objectiveWeight(a, j))
      .slice(0, 6);
    for (const o of objs) {
      const u = j.urgency[o.id] ?? 0;
      out.push({ key: `o-${o.id}`, x: o.x, y: heightAt(o.x, o.z) + 55, z: o.z, cls: `obj${u >= 3.4 ? ' crit' : ''}`, html: `${o.kind} ${o.sector} · U${u.toFixed(1)}`, maxDist: 3000, priority: 4 + u / 4, w: 150, h: 22 });
    }
  }
  return out;
}
