# Jev integration

Jev is TypeSafe's System One model: it takes `state` plus typed questions and returns typed
answers with probabilities (Noul / Choice / Score). It does not generate text or plans.
Contract: [docs.typesafe.ai/api](https://docs.typesafe.ai/api) — `POST /v1/systemone`,
`model: "jev-latest"`.

## Division of labour

| Deterministic code | Jev |
| --- | --- |
| Fire spread + arrival prediction, flight control, separation, terrain following | Which objective is the top priority right now (Choice) |
| Sensors, detections, verification, coverage | How urgent each objective is (Score, 5 levels) |
| Candidate objectives from *observable* state | Parsing commander commands into a typed directive (Choices + Noul) |
| Allocation (capability, distance, battery, stickiness), payload swaps, relays, corridors | — |

Jev never flies a drone, and never sees ground truth: civilians enter the state only as
detections, and only confirmed people contribute position facts.

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
