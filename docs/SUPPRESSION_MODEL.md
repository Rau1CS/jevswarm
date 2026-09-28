# Suppression model: platforms, agents, delivery and cost

The suppression layer turns the simulator into a test bench for **what a drone swarm can
actually deliver** to a fire, and what that costs. It is a simulation of trade-offs, not a
validated engineering tool: every number is tagged with its provenance, and most suppression
physics is `SIM` (a modelling assumption, uncalibrated).

The design principle comes from the background research:

> Make the swarm effective by arriving early, putting suppressant precisely where it matters,
> and replenishing quickly, rather than assuming a lightweight chemical can replace water.

## Provenance tags

| Tag | Meaning |
| --- | --- |
| `PUBLIC` | Published figure with a source link (e.g. X500 V2 payload and hover endurance). |
| `SIM` | Modelling assumption chosen for this simulation; uncalibrated. |
| `CONCEPT` | Hypothetical platform class, not a specific product. |
| `ASSUMPTION` | Placeholder, mostly costs; replace with real quotes. |

All values are in `src/sim/loadout/catalogue.ts`. The in-app **CATALOGUE & SOURCES** page shows
them with their tags, notes and links.

## Three quantities, never confused

1. **Released**: agent leaving the nozzle. Capacity per sortie =
   `(payload allowance − dispenser hardware) ÷ mixture density`.
   - X500-class light quad: (1.5 − 0.45) / 1.0 ≈ **1.1 L**.
   - Heavy-lift concept: (28 − 8) / 1.0 = **20 L**, matching the research's illustrative example.
2. **On target**: released × landing fraction.
   - Landing fraction = platform aim × agent cohesion × wind penalty.
   - Wind lowers it; gel drifts less and powder drifts more.
3. **Effective**: the on-target part that landed on flaming fuel (direct attack), or on
   unburned fuel (retardant).
   - Agent that arrives after the cell is already out, or that misses, is wasted.

Foam expansion is **never** a multiplier. Finished foam is mostly air; capacity and cooling
come from the liquid carried.

## Fire interaction (`src/sim/suppression.ts`, `src/sim/fire.ts`)

- **Knockdown density.** Plain water needs `1 L/m²` to knock down flaming fuel at full
  intensity.
  - The requirement scales with intensity and is divided by the agent's contact efficiency.
  - 1 L/m² is the research's *test loading*, not a validated extinguishment threshold.
  - It is the most influential uncalibrated parameter; the lab lets you set 0.5, 1 or 2 L/m².
- **Sub-cell coverage.** A drop is much smaller than a 15.6 m (≈ 244 m²) fire cell.
  - Aimed discharges build up a treated fraction of the cell (`cover`), which caps that cell's
    flaming intensity.
  - Coverage dries out: half-life 180 s for water, scaled by agent retention.
  - A cell is knocked down at ≥ 93 % coverage.
  - With a 20 L drone at 1 L/m² it takes about 6–10 concentrated drops to knock one cell down.
- **Thermal targeting.** On the run-in the drone re-aims at the hottest, least-treated flaming
  cell within ~90 m of its planned target (plans can be a minute or more old). At the drop it
  picks the hottest cell within 24 m.
- **Knockdown ≠ extinguishment.**
  - A knocked-down cell keeps residual heat (per agent).
  - Heat decays faster when wet. If it stays hot and dry, the cell can rekindle.
  - Dry chemical knocks down flame but leaves heat and adds no cooling, so it rekindles.
  - Metrics: **knockdowns**, **reignitions**, and **cooled-out** cells (extinguished).
- **Retardant.**
  - Salts accumulate as a dose (L/m² of mixture). They reduce spread into the cell by up to
    85 %, with half effect at 0.8 L/m² (≈ US coverage level 2).
  - The effect persists after the water evaporates.
  - Treated fuel resists embers but is never immune.
- **Containment.** Share of the burning perimeter that is no longer adjacent to unburned fuel.
  **Fire out** means no burning cells.

## Agents

| Agent | Mission | Refill | Modelled benefit (SIM) | Modelled drawback |
| --- | --- | --- | --- | --- |
| Plain water | direct | lake or station | baseline | baseline |
| Wet Class A foam | direct | mixing station | contact 1.25×, retention 1.3× | slight extra drift; aerial-use restrictions in some jurisdictions (see catalogue note) |
| Water-enhancing gel | direct | mixing station | less drift (1.12×), retention 2× | cost; mixing station needed |
| Long-term retardant | treat ahead | mixing station | persistent spread reduction | weak direct attack; denser mixture means fewer litres |
| ABC dry chemical | direct (experimental) | mixing station | fast knockdown (1.8×) | no cooling, high rekindling, drift |

## Logistics (`src/sim/logistics.ts`)

Refill stations have finite slots and FIFO queues. All slot counts are SIM.

| Station | Slots | Supplies |
| --- | --- | --- |
| Lake dip point | 3 | water only |
| Command-post station | 4 | any agent; swaps batteries while refilling |
| Forward refill truck | 2 | any agent; placed about 350 m from the fire toward the command post |

- **Refill time** = capacity ÷ pump rate.
- **Discharge time** = capacity ÷ discharge rate, spent hovering over the target.
- **Delivery cycle** is measured between drops: transit, approach, discharge, climb-out,
  transit, queue and refill.

## Tasking policies and the lab

| Policy | Suppression aircraft |
| --- | --- |
| `NONE` | Stay on the pad. This is the baseline. |
| `NEAREST` | Each attacks the burning front cell nearest to itself (retardant: 60 m downwind of it). |
| `COORDINATOR` | Objectives → judgment → allocation. Objectives: `ATTACK` head and flanks of the main fire, `ATTACK` spot fires (separate clusters of ≤ 16 cells), fronts threatening people, the village or the evacuation road, and `TREAT` a retardant line ahead of the head. Jev judges these live; the lab uses the deterministic fallback judge. |

**SUPPRESSION LAB** (title screen) and `npm run lab` run the same seeds under all three policies.

- **Scenario settings:** detection delay, fuel dryness and knockdown density.
- **Reported per policy:**
  - Fire outcome: area burned, fire-out rate, hectares saved vs `NONE`.
  - Delivery: on-target and effective agent, throughput (L/min), cycle and queue times, time
    to first effective drop, knockdowns and reignitions.
  - Cost: assumption-based cost and cost per hectare saved.
- **What the lab leaves out:**
  - Jev is **not** called, so nothing is spent on tokens.
  - There are no random disruption events. Differences come from the policy.
  - Use several seeds: the fire model is stochastic.
- **Paired seeds.** Physical-loadout runs use *common random numbers*.
  - Every stochastic fire event draws from hash(seed, tick, cell, event) rather than a shared
    sequence.
  - Two policies on the same seed therefore face an identical fire until suppression changes
    it, so differences are not just the random-number stream diverging.
  - This is tested in `tests/suppression.test.ts`.
  - The cinematic demo keeps the legacy sequential RNG so its storyline is unchanged.

```bash
npm run lab
LAB_CASES=HEAVY:WATER:1,HEAVY:GEL:1 LAB_SEEDS=1,2,3,4 LAB_SEC=600 LAB_DETECT=30 LAB_DRY=0.2 LAB_KD=1 LAB_OUT=lab.txt npm run lab
```

`LAB_CASES` entries are `PLATFORM:AGENT:FORWARD(0|1)`.

## Scenarios

- **Initial attack.**
  - A small ignition, detected and dispatched after 60 s by default, in moderate fuel moisture
    (spread × 0.45) and 2.5–4 m/s wind.
  - Two spot fires start downwind at about 2:40 and 5:20.
  - Fleet mix: 25 % scouts, 59 % suppression, 4 % logistics, 12 % relay.
- **Established fire.** The original free simulation with the chosen loadout.
- **Cinematic demo.** Always uses the legacy "120 L concept platform" with the abstract effect,
  so the curated storyline is unchanged.

## Costs (all `ASSUMPTION`)

- **Fleet cost** = suppression-drone flight hours × (unit cost ÷ service life + operating cost
  per hour).
- **Agent cost** = released units × cost per unit.
- These are placeholders to be replaced with quotes. The structure (per flight hour, per litre,
  per hectare saved) is the part meant to last.

## Known limitations (read before quoting any number)

- **Grid resolution.**
  - The fire grid is 15.6 m, so the smallest fire it can represent is about 250 m² burning at once.
  - A truly incipient ignition (a few m²) is below resolution. This biases *against* drone
    initial attack.
  - The next step is a sub-cell burning fraction or local grid refinement.
- **Fire spread** is a SIM cellular automaton tuned for plausibility. It is not Rothermel,
  FARSITE or ELMFIRE.
- **Agent effects** are not calibrated against experiments. Contact, retention, residual heat
  and knockdown density are all placeholders.
- **Flight** is a kinematic controller.
  - No downwash, plume, turbulence or icing.
  - Endurance comes from a simple drain model.
  - No hose-fed (tethered) applicator yet (see ETH CORD in the catalogue references).
- **Regulation** (BVLOS, SORA, manned-aircraft deconfliction, jurisdictional limits on agents)
  appears only as notes, not as constraints.

## Reference systems (context, not physics inputs)

- **Seneca**: suppression-drone strike teams using aerated Class A foam. Aspen Fire Protection
  District acquisition announced 2026.
- **Rain + Sikorsky**: autonomous Black Hawk water drops, including live brush-pile tests in 2025.
- **ETH Zürich CORD**: tethered two-drone hose research prototype.
- **Stanford (2024)**: heat-activated silica-aerogel gel.

Links are in the catalogue.

## First results (paired sweep, 2026-09-28)

Conditions:

- **Fleet:** 24 drones, of which 14 are heavy-lift suppression drones at 20 L each.
- **Fire:** initial attack, 30 s detection, damp fuel (0.2×), knockdown density 1 L/m².
- **Logistics:** forward refill truck, unless noted.
- **Runs:** 10 min each, 6 paired seeds, fallback coordinator.

Area burned is in ha; "out" is the share of runs with no fire left at 10 min. These are
comparisons *inside this uncalibrated model*, not field predictions.

| Case | NONE | NEAREST | COORDINATOR | Notes |
| --- | --- | --- | --- | --- |
| Water | 1.73 (out 33 %) | 1.40 (50 %) | 1.39 (67 %) | coordinator: 69 % of agent on flaming fuel vs 52 %, cycle 145 s vs 174 s |
| Water, no forward truck | 1.73 | 1.44 | 1.46 | cycle ≈ 240 s; throughput ≈ 60–66 L/min vs 76–78 |
| Class A foam | 1.73 | 1.44 | 1.41 | ≈ water: no hidden multiplier |
| Water-enhancing gel | 1.73 | 1.42 | 1.40 | slightly more effective delivery; costs more |
| ABC dry chemical | 1.73 | 1.64 | 1.50 | weakest direct agent here; rekindling; high agent cost |
| Long-term retardant | 1.73 | 1.72 | 1.72 | too little per sortie to build a line at this scale |
| X500-class quad, water | 1.73 | 1.72 | 1.72 | ≈ 45 L on target in 10 min: no measurable effect |
| Detection 120 s | 2.11 | 1.63 | 1.71 | a later start leaves a larger fire |
| Moderate fuel (0.45×), 60 s detection | 16.65 | 16.06 | 15.42 | swarm only trims 4–7 % once the fire is running |
| Knockdown 0.5 L/m² | 1.73 | 1.22 | 1.18 | the most sensitive parameter |
| Knockdown 2 L/m² | 1.73 | 1.52 | 1.53 | |

Takeaways:

1. **What decides the outcome.** Early detection, damp fuel and a close refill point matter
   more than the choice of agent.
2. **Payload class dominates.** A light quad is irrelevant for suppression.
3. **Coordinator vs rule.** The heuristic coordinator matches the nearest-fire rule on area
   burned but puts its agent on flaming fuel more often and queues less.
4. **What to measure next.** Whether Jev's live judgments beat the heuristic is the next
   experiment.
