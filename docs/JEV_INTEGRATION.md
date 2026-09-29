# Jev integration

Jev is TypeSafe's System One model: it takes `state` plus typed questions and returns typed
answers with probabilities (Noul / Choice / Score). It does not generate text or plans.
Contract: [docs.typesafe.ai/api](https://docs.typesafe.ai/api) — `POST /v1/systemone`,
`model: "jev-latest"`.

## Division of labour

Each decision in the app's decision stream is tagged **JEV**, **CODE** or **HUMAN**.

| Deterministic code | Jev | Human |
| --- | --- | --- |
| Fire spread + arrival prediction, wind response, flight control, separation, terrain following | **Emergency-call triage** (one request per call, below) | Approves large (≥ 3 aircraft) or uncertain life-safety dispatches |
| Sensors, detections, verification, coverage | Which objective is the top priority right now (Choice) | Listens back to unclear calls and sets their location |
| Candidate objectives from *observable* state; the dispatch policy over Jev's answers | How urgent each objective is (Score, 5 levels) | Plain-language orders (parsed by Jev) |
| Allocation (capability, distance, battery, stickiness), payload swaps, relays, corridors, refills | Parsing commander commands into a typed directive | — |

**Why this split.**

- Anything computable exactly stays in code: physics, geometry, scheduling, flight.
- Jev handles the step where input is messy human language and a fast, calibrated judgment is needed.
- The benchmark in [research/triage](../research/triage/README.md) shows Jev beating keyword
  rules, local models and a classifier trained on past disasters at exactly that step.

**What Jev never gets.**

- It never flies a drone.
- It never sees ground truth. Civilians enter the state only as detections or call transcripts,
  and only confirmed people contribute position facts.

## Emergency-call triage (one fan-out request per call)

`src/calls/`. Calls are generated from hidden truth (`generator.ts`):

- people in danger, some of whom cannot leave on their own
- repeat calls
- fire sightings
- information requests
- non-emergencies
- garbled calls

Each call goes to Jev once, with `state = { transcript, local_places, open_incidents }` and six
questions:

| id | type | question |
| --- | --- | --- |
| `kind` | Choice | person in danger / fire report / info request / not an emergency / unclear |
| `urgency` | Score (5) | life risk right now |
| `place` | Choice | which **known** place (gazetteer) or `UNKNOWN`. Code never lets Jev invent a location |
| `cannot_leave` | Noul | is anyone unable to get out on their own? |
| `duplicate` | Choice | one of the open incidents, or `NEW` |
| `response` | Choice | a fixed response package code can execute (verify · verify + route · full rescue · check fire · reply · human) |

**Dispatch policy** (`callCenter.ts`, code, thresholds in `POLICY`):

| Condition | Action |
| --- | --- |
| Confident info or non-emergency | Automatic reply |
| Confident repeat | Merge into the open incident and raise its priority |
| Unclear, or place unknown | Operator listen-back |
| Package of 3 or more aircraft, or an uncertain life-safety call | **Commander approval ping** |
| Otherwise | Automatic dispatch |

**Execution is code.** It creates the incident on the map at the reported place and tasks drones
through the normal coordinator. The incident's objective carries the call facts, so Jev's
priority judgments see them.

**Live spot-check** (30 generated calls, jev-1.13.0):

- Call type and place right on 25 of 30.
- Garbled calls were read as "person in danger, location unknown", which the policy sends to an
  operator.
- One garbled call ("my husband went back for the horses") was associated with a farm. The full
  rescue it proposed requires approval, which is why that gate exists.

**Demo.**

- 0:38: a family member's call about the trapped grandmother.
- 0:44: the commander approves. Scripted, and labelled as such.
- 0:58: an info call is auto-replied.
- 1:38: a repeat call is merged.

The free simulation receives random calls every 22–40 s.

## Strategic judgment (one fan-out request per replan)

`src/jev/judge.ts` → `buildJevRequest()`:

- `state`: mission time, commander intent, wind (with shift note), fire summary, swarm
  summary, and up to 16 `objectives` `{ id, kind, sector, facts }`. `facts` is a one-line
  natural-language summary built in code (e.g. *"Unverified thermal signature that may be a
  person in D4, thermal confidence 0.64. Predicted fire arrival there: 4.2 min."*).
- `priority` — Choice over objective ids (criteria = each objective's facts).
- `urgency.<id>` — Score per objective, referencing `` `objectives[i]` ``, with five concrete
  levels from *Routine* to *Critical: a person is likely to be in danger within about 5 minutes*.

All questions go in a single request (speculative fan-out). Code then:

1. re-derives objectives at apply time (the world moved during the call),
2. weights each objective by `urgency + commander boost + 0.8 if priority`,
3. allocates drones greedily (`src/jev/allocator.ts`),
4. logs the decisions and animates the replan.

Replans run every 10 simulated seconds and immediately on events (detection, verification,
wind shift, drop, drone lost, commander directive…). At most one request is in flight.

## Commander commands

`src/jev/commands.ts` follows the function-calling cookbook pattern: the directive's closed
sets are Choices — `intent` (8 options), `area` (8 options), `count` — plus a Noul
`count_stated`. Low confidence or `UNKNOWN` is reported as "not understood" instead of acted on.

## Fallback

If no key is configured or a call fails, `fallbackJudge()` produces the same `Judgment` shape
from transparent rules (urgency bands by predicted fire arrival and objective kind) and
`parseFallback()` handles commands with keywords. The UI shows **SIMULATION COORDINATOR**,
and the results screen reports "coordinator decisions" rather than "Jev decisions".

## Proxy

`server/jevProxy.ts` is Vite middleware (dev and preview). It validates the body
(question count ≤ 64, known types, ≤ 256 KB), forces the model name, adds the bearer key from
`TYPESAFE_API_KEY`, and retries 429/529 with backoff (honouring `retry-after`).
`GET /api/jev/status` reports whether a key is configured.

## Validating in your domain

Thresholds here (e.g. urgency ≥ 3.4 = critical) are demo choices. Before relying on them,
inspect real answers and confidences for representative incident states.
