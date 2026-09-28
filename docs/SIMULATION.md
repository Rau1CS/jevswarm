# Simulation abstractions

Everything below is a **simulation abstraction (SIM)** chosen for a legible, plausible demo.
None of it is a validated fire-behaviour, sensor or airworthiness model.

## World

- 2 km × 2 km area, sectors A–H (north→south) × 1–8 (west→east), 250 m each.
- Procedural terrain, forest, fields, 25 buildings, roads (two evacuation routes), lake
  (suppressant refill), command post (south-west), safe zone (south-east).
- Drones are drawn at **5× scale** and people at 2.6× so they stay visible on a 2 km map.

## Fire (`src/sim/fire.ts`)

- 128 × 128 cellular grid (15.6 m cells); fuel from vegetation density.
- Ignition probability per neighbour per tick ∝ fuel term `(0.35 + 0.65·fuel)` ·
  `exp(0.24·windSpeed·alignment)` · `exp(2.2·slope)` · source intensity · `(1 − wetness)`.
- Intensity peaks early and decays to smouldering as fuel burns; embers spot 4–11 cells downwind.
- Tuned so a head fire in forest with 6 m/s wind advances ≈ 2 m/s (tested across seeds).
- **Arrival predictor**: Dijkstra over the grid with a directional spread-rate estimate,
  calibrated against the cellular model in forest (`tests/fire.test.ts`). It is deliberately
  **conservative in light fuels** (gardens, grass): it may predict arrival earlier than the
  cellular fire actually manages — the safe direction for an emergency planner.
- **Containment (SIM metric)**: share of burning perimeter no longer adjacent to unburned fuel.

## Suppression

Two modes (see [SUPPRESSION_MODEL.md](SUPPRESSION_MODEL.md)):

- **Physical loadouts** (free simulation, lab): platform + agent from the catalogue; capacity =
  (payload − dispenser) ÷ density; released → on target → effective accounting; sub-cell
  coverage, residual heat and rekindling, dose-dependent retardant; finite refill slots.
- **Legacy abstraction** (cinematic demo, "120 L concept platform"): one sortie = "120 L
  equivalent", a drop reduces intensity inside ~40 m (up to 85 %) and wets fuel. Not derived
  from delivered litres. An X500-class airframe carries ≈ 1.5 kg; it could not do this.

## Drones (`src/sim/drone.ts`)

| Parameter | Value (SIM) |
| --- | --- |
| Max horizontal speed / accel / climb | 17 m/s · 5 m/s² · 5 m/s |
| Endurance | 18 min nominal (public X500 V2 hover figure), drained faster by speed and payload |
| Battery swap at command post | 18 s |
| Search / verify / suppression / relay altitude AGL | 85 / 38 / 22 / 120 m |
| Thermal detection radius | ≈ 0.9 × AGL (oblique viewing), 20–95 m |
| Command-post radio range / relay range | 820 m / +650 m |

Roles (scout, suppression, logistics, relay) are payload configurations; drones can swap at
the command post when Jev's priorities make it worthwhile.

## Sensors & civilians

- Civilians have hidden ground truth (sheltering, evacuating, trapped, wandering).
- Thermal hit probability falls with distance, smoke and being indoors; confidence accumulates
  but search passes cap at 0.82 — only a low verification orbit (RGB + thermal) confirms.
- False positives appear near hot ground; verification dismisses them.

## Events (free simulation)

Wind shift (guaranteed once), communication lost, battery critical, thermal false positive,
sensor failure, road blocked, new civilian reported, fire jump, drone lost.

## Cinematic demo curation

The demo is a live simulation with a fixed seed. The director cues camera shots and captions,
forces the hero detection at ~0:48, the wind shift at 1:15 (210° → 265°), holds the hero's
verification as "inconclusive (smoke)" until ~1:53, and nudges a drop / corridor if the live
swarm hasn't produced them by their cue. Assignments, escalations and callouts come from the
coordinator. Free simulation has no such curation.
