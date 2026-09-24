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

Other scripts: `npm test` (vitest), `npm run typecheck`, `npm run build` + `npm run preview`.

## What to try

| Control | What it does |
| --- | --- |
| **RUN CINEMATIC DEMO** | Curated ~2:40 scenario for screen recording (live simulation, scripted beats). |
| **START SIMULATION** | Randomised fire origin, wind, civilians, sensor noise, failures. |
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
            sensors (uncertain detections), vehicles, events, recorder, simulation hub
  jev/      objectives (from observable state) → judge (Jev or fallback) → allocator → tasks
            planner (search patterns, safe corridors, relays), commander command parsing
  render/   Three.js stage + post, terrain/forest/buildings, fire/smoke particles, instanced
            drones, paths + replan animation, JEV VIEW overlay, camera rig, thermal patch
  ui/       HUD, decision stream, labels, results + replay, tech page
  demo/     cinematic director
  app/      application shell, scenarios, label builder
server/     Vite middleware proxy for the TypeSafe API (server-side key)
tests/      fire calibration, Jev request shape, allocator rules, headless demo storyline
docs/       SIMULATION.md (abstractions & parameters), JEV_INTEGRATION.md
```

Jev makes **strategic** decisions only (priority and urgency judgments, command parsing),
periodically and on significant events. Flight, collision avoidance, sensing, fire and task
execution are deterministic code. See [docs/JEV_INTEGRATION.md](docs/JEV_INTEGRATION.md).
