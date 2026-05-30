# Rover Relay (Starter)

Welcome, engineer. This is your rover relay. Mission Control sends commands here, and your job is to make sure all three ground stations (**NASA**, **ESA**, **JAXA**) end up with the exact same command, in the right order, even when deep space gets noisy.

## What it does today

`POST /replicate` receives a command:

```json
{ "selector": "cmd-4821", "payload": "fire_thruster", "sequence_number": 12 }
```

Right now this is an **empty scaffold**. It reads the command and the trace
context (auth token + correlation id), writes a single example log line to
Mission Control, and returns an empty `200` response. It does **not** talk to the
stations yet — that part is your job.

Your mission is to forward every command to all three stations so they end up
holding the same value:

```
PUT /groundstation/nasa/cmd-4821
PUT /groundstation/esa/cmd-4821
PUT /groundstation/jaxa/cmd-4821
```

(forwarding the `Authorization` and `X-Correlation-Id` headers and a
`{ payload, sequence_number }` body on each). Start simple, then make it survive
chaos.

## Why it's hard

The ground station API runs chaos scenarios. A naive relay ignores all of them:

| Chaos | What goes wrong | What you should add |
|-------|-----------------|---------------------|
| **Station Blackout** (HTTP 500) | The write fails and is forgotten. | Retry with exponential backoff. Don't drop pending work. |
| **Bandwidth Throttle** (HTTP 429 + `retry_after_ms`) | Treated as a normal failure. | Read `Retry-After`, queue, and pace your traffic. |
| **Signal Delay** (2 to 5s latency) | Sequential writes stack up and time out. | Write to the three stations in parallel. Set timeouts. |
| **Incorrect Ordering** (HTTP 409 on stale `sequence_number`) | Old commands overwrite new ones. | Keep sequence numbers monotonic. Use `if_match`. |
| **Relay Timeout** | Mission Control gives up if you respond too slowly. | Acknowledge quickly; do slow work without blocking the response. |

## Run it locally

```bash
npm install
GROUND_STATION_URL=http://localhost:3001 npm run dev
```

Then point the **Deep Space Network** tab at `http://localhost:4000` (or your deployed URL).

## Auth

The Deep Space Network forwards a PocketBase Bearer token in the `Authorization` header. Pass it straight through to the ground station API on every call, exactly as the starter already does.

## Logging your own story to Mission Control

Mission Control has a **Mission logs** table that reads like a story: every step of
every command, in order. The platform writes its own lines, and the relay adds yours
so they show up interleaved on the same trace.

To enable it, set `FLIGHT_DIRECTOR_URL` so the relay knows where Mission Control's logs
live (use the **same** Flight Director URL Mission Control uses). The starter's
`missionLog(...)` helper then sends fire-and-forget log lines there — it never slows
down or breaks a replication.

```bash
GROUND_STATION_URL=http://localhost:3001 \
FLIGHT_DIRECTOR_URL=http://localhost:3002 \
npm run dev
```

| Variable | Required? | What it does |
|----------|-----------|--------------|
| `GROUND_STATION_URL` | Yes | Where to forward commands. |
| `FLIGHT_DIRECTOR_URL` | For logging | Where to send your log lines. Same URL Mission Control uses. |
| `RELAY_LOGGING` | No | Set to `false` to turn your logs off entirely. |

Call `missionLog(token, correlationId, { level, message, properties })` anywhere in
your relay. The `token` and `correlationId` both arrive on the incoming request:

```js
missionLog(auth, correlationId, {
  level: "success",            // "info" | "success" | "warn" | "error"
  message: "Relay finished fanning out the command.",
  properties: { retries: 2 }, // any extra key/values to show in the table
});
```

## Your mission

Fork this folder and improve it. Suggested upgrades, roughly in order of impact:

1. Write to the three stations in parallel with `Promise.allSettled`.
2. Add retry with exponential backoff for 500s.
3. Respect `Retry-After` / `retry_after_ms` on 429s.
4. Track and resend the latest sequence number on 409s.
5. Add a small in memory (or persisted) queue so nothing is lost mid flight.

Good luck. The stations are waiting.
