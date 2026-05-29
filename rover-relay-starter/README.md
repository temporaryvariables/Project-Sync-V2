# Rover Relay (Starter)

Welcome, engineer. This is your rover relay. Mission Control sends commands here, and your job is to make sure all three ground stations (**NASA**, **ESA**, **JAXA**) end up with the exact same command, in the right order, even when deep space gets noisy.

## What it does today

`POST /replicate` receives a command:

```json
{ "selector": "cmd-4821", "payload": "fire_thruster", "sequence_number": 12 }
```

It then writes that command to each station, one after another:

```
PUT /groundstation/nasa/cmd-4821
PUT /groundstation/esa/cmd-4821
PUT /groundstation/jaxa/cmd-4821
```

That is it. No retries, no parallelism, no persistence, no ordering safeguards.

## Why it breaks

The ground station API runs chaos scenarios. The starter ignores all of them:

| Chaos | What happens to the starter | What you should add |
|-------|-----------------------------|---------------------|
| **Station Blackout** (HTTP 500) | The write just fails and is forgotten. | Retry with exponential backoff. Don't drop pending work. |
| **Bandwidth Throttle** (HTTP 429 + `retry_after_ms`) | Treated as a normal failure. | Read `Retry-After`, queue, and pace your traffic. |
| **Signal Delay** (2 to 5s latency) | Sequential writes stack up and time out. | Write to the three stations in parallel. Set timeouts. |
| **Incorrect Ordering** (HTTP 409 on stale `sequence_number`) | Old commands overwrite new ones. | Keep sequence numbers monotonic. Use `if_match`. |

## Run it locally

```bash
npm install
GROUND_STATION_URL=http://localhost:3001 npm run dev
```

Then point the **Deep Space Network** tab at `http://localhost:4000` (or your deployed URL).

## Auth

The Deep Space Network forwards a PocketBase Bearer token in the `Authorization` header. Pass it straight through to the ground station API on every call, exactly as the starter already does.

## Your mission

Fork this folder and improve it. Suggested upgrades, roughly in order of impact:

1. Write to the three stations in parallel with `Promise.allSettled`.
2. Add retry with exponential backoff for 500s.
3. Respect `Retry-After` / `retry_after_ms` on 429s.
4. Track and resend the latest sequence number on 409s.
5. Add a small in memory (or persisted) queue so nothing is lost mid flight.

Good luck. The stations are waiting.
