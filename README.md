# JEV RESCUE SWARM

> One AI coordinator. Dozens of autonomous drones. One evolving disaster.

A browser-based, real-time 3D technology demonstrator: a wildfire approaches a small
settlement, and a swarm of 24 (up to 100) autonomous drones searches, verifies, suppresses,
relays and guides people out — coordinated by **Jev**, TypeSafe's System One model.

Civilian emergency-response concept. Values marked **SIM** are simulation abstractions.

## Run

```bash
npm install
npm run dev          # http://localhost:5173
```

Optional — connect the real Jev model (otherwise a clearly-labelled fallback coordinator runs):

```bash
cp .env.example .env.local   # then set TYPESAFE_API_KEY=...
npm run dev
```

The key is read only by the local Vite server (`server/jevProxy.ts`), which forwards
`POST /api/jev` to `https://api.typesafe.ai/v1/systemone`. It is never bundled into browser code.
The top bar shows **JEV CONNECTED** or **SIMULATION COORDINATOR**.

Other scripts: `npm test` (vitest), `npm run typecheck`, `npm run build` + `npm run preview`,
`npm run lab` (headless suppression policy comparison — see [docs/SUPPRESSION_MODEL.md](docs/SUPPRESSION_MODEL.md)).

Drone models are generated in Blender (`tools/blender/`, exported to `public/models/jev_drones.glb`):

```bash
"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe" -b --factory-startup --python tools/blender/build_drones.py
```

## Hosted version (free)

Live at **https://jev-rescue-swarm.pages.dev**, on Cloudflare Pages' free plan.

- **Static site:** static-asset requests are free and unlimited.
- **Pages Function:** `functions/api/jev/`, within the free Workers quota of 100,000
  requests/day. If the quota is exceeded, requests simply fail; there is no billing.
- **Bring your own key:** there is no server key. Visitors paste their own TypeSafe key on the
  title screen. It stays in their browser (session, or "remember") and is sent per request to
  the proxy, which accepts same-origin requests only, forwards to api.typesafe.ai, and never
  stores or logs it. Jev usage is billed to the visitor's own TypeSafe account.
- **Without a key:** everything still runs on the labelled fallback rules; only live Jev
  decisions and the triage console need one.
- **Security headers:** `public/_headers` sets a strict CSP (self, Google Fonts, and the two
  public data sources).

Redeploy after changes:

```bash
npm run deploy     # build + wrangler pages deploy (after a one-time `npx wrangler login`)
```

## What to try

| Control | What it does |
| --- | --- |
| **RUN CINEMATIC DEMO** | Curated ~2:40 scenario for screen recording (live simulation, scripted beats). |
| **START SIMULATION** | Randomised fire origin, wind, civilians, sensor noise, failures — with the chosen suppression loadout. |
| **EMERGENCY CALLS** panel (in the simulation) | Calls from residents are triaged by Jev in one request (kind, urgency, known place, can't-leave, repeat, response package); code applies the dispatch policy; big or uncertain rescues ping the commander to APPROVE / CHANGE / DISMISS; unclear calls go to operator listen-back. Every decision in the stream is tagged JEV / CODE / HUMAN. |
| **MESSAGE TRIAGE** | Real wildfire messages (HumAID / CrisisLexT26, loaded at runtime) streamed through Jev: category + standing questions in one request per message, commander adds new questions live, confidence routing to lanes vs human review, priority inbox, live agreement with human labels, latency and cost. Needs a Jev key. Benchmark behind it: [research/triage](research/triage/README.md). |
| **SUPPRESSION LOADOUT** (title screen) | Scenario (initial attack / established fire), platform, suppressant, forward refill truck. |
| **SUPPRESSION LAB** | Same seeds under NO SUPPRESSION / NEAREST-FIRE RULE / COORDINATOR; area burned, delivery, cycles, cost. |
| **CATALOGUE & SOURCES** | Every platform/agent parameter with its PUBLIC / SIM / CONCEPT / ASSUMPTION tag and source. |
| WORLD / JEV / THERMAL VIEW (`1` `2` `3`) | Cinematic view · Jev's operational picture · ironbow thermal. |
| Click a drone | Follow it: CHASE, DRONE POV, THERMAL CAMERA, MAP VIEW. `Esc` releases. |
| Camera bar | OVERVIEW, FIRE FRONT, SWARM, RESCUE, SELECTED DRONE, COMMAND BASE. |
| COMMANDER box | e.g. "Search the northern forest", "Keep five drones in reserve". |
| TECH MODE / TECH / REAL-WORLD | Technical drone cards · exploded airframe + tagged spec sheet. |
| DRONES 10 / 24 / 50 / 100, TIME 1–4× | Swarm size (restarts the run) and simulation speed. |

## Architecture

```
src/
  sim/      fire CA + arrival predictor, drones (flight + tasks), civilians (hidden truth),
            sensors (uncertain detections), vehicles, events, recorder, simulation hub,
            loadout/catalogue (platforms + agents), suppression (physical application),
            logistics (refill stations + queues), ledger (delivery + cost accounting)
  lab/      headless policy comparison
  jev/      objectives (from observable state) → judge (Jev or fallback) → allocator → tasks
            planner (search patterns, safe corridors, relays), commander command parsing
  render/   Three.js stage + post, terrain/forest/buildings, fire/smoke particles, instanced
            drones, paths + replan animation, JEV VIEW overlay, camera rig, thermal patch
  ui/       HUD, decision stream, labels, results + replay, tech page
  demo/     cinematic director
  app/      application shell, scenarios, label builder
server/     Vite middleware proxy for the TypeSafe API (server-side key)
tests/      fire calibration, Jev request shape, allocator rules, headless demo storyline
docs/       SIMULATION.md (abstractions & parameters), SUPPRESSION_MODEL.md, JEV_INTEGRATION.md
tools/      blender/ — procedural drone models (light X500-class quad, heavy-lift X8)
```

Jev makes **strategic** decisions only (priority and urgency judgments, command parsing),
periodically and on significant events. Flight, collision avoidance, sensing, fire and task
execution are deterministic code. See [docs/JEV_INTEGRATION.md](docs/JEV_INTEGRATION.md).
