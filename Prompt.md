# Project Sync — AI Implementation Specification

## Overview

**Project Sync** is an educational distributed systems platform with a space mission theme. Students build a relay service that replicates commands from Mission Control to three Earth ground stations (NASA, ESA, JAXA) while handling chaos scenarios like outages, throttling, signal delay, and out-of-order commands.

This is **not a production system**. Prioritize simplicity, learning value, and clear visibility over realism or enterprise architecture. Where a design choice becomes complex, choose the simpler path that still teaches the concept.

## Repository Structure (Monorepo)

Single Git repository with one folder per service. Coolify deploys each folder as a separate application. Use watch paths so only the changed service rebuilds.

## Services

| Service | Purpose | Port | Public Endpoints (high level) |
|---------|---------|:---:|------|
| **mission-control** (frontend) | The single web UI — guide, API reference, transmitter controls, team observability, admin tools. Auth-gated via PocketBase. | 3000 | Static SPA |
| **ground-station-api** | The "three sources of truth" API students target. Exposes per-station write/read/delete endpoints (`nasa`, `esa`, `jaxa`) plus a mission-log endpoint used internally for the expected value. Applies chaos rules on station endpoints only. | 3001 | `/health`, `/groundstation/<nasa\|esa\|jaxa>/:selector` (GET/PUT/DELETE), `/missionlog/:selector` (GET/PUT/DELETE — internal), `/commands` (paginated list) |
| **flight-director-api** | Admin/dashboard API. Handles DB lifecycle (reset), chaos rule CRUD, and aggregated visibility data for the frontend. | 3002 | `/health`, `/reset`, `/tables`, `/chaos` (CRUD), `/teams/:teamId/records` |
| **deep-space-network** (transmitter / requester) | Generates traffic against student relay services using configurable scenarios. Stores per-request timing and status in memory. | 3003 | `/health`, `/scenarios` (list), `/start`, `/stop`, `/status`, `/requests` (timeline data) |
| **pocketbase** | Authentication, user accounts, team memberships. Single binary, separate deployment. | 8090 | PocketBase native API |
| **postgres** | Single shared database. One table per concept. | 5432 | Internal only |
| **rover-relay-starter** | Student starter template (provided code). Minimal Express app with a `/replicate` endpoint that loops over the three stations. Students fork this and improve it. | 4000 | `/health`, `/replicate` |

The AI may rename services if a better space-themed name exists, but keep names consistent across docs, code, UI, and deployment.

## Authentication

- PocketBase handles all auth. Frontend uses the PocketBase JS SDK; backends validate Bearer tokens by calling PocketBase's auth refresh endpoint.
- The `users` collection has standard email/password registration plus a `team_id` field linking each user to a team.
- All API endpoints require a Bearer token except healthchecks. The user's team is derived from the token — never trusted from the request body.
- Frontend login page leads to the dashboard. Token persists across refresh via PocketBase's built-in `localStorage` handling.

## Teams

- A team is a group of students working on one relay implementation.
- Every PocketBase user belongs to one team (`team_id` field).
- Data isolation: all records, chaos rules, and queries are scoped by `team_id` automatically (derived from the auth token).
- Teams can see their own data on the dashboard. The platform does **not** expose cross-team scoring, ranking, or comparison views — evaluation is handled separately by the instructor.

## Data Model

Single Postgres database. One main table representing the three sources of truth as columns on the same row:

- `replication_records`: `id`, `team_id`, `selector`, `expected_payload`, `nasa_payload`, `esa_payload`, `jaxa_payload`, `sequence_number`, `if_match`, computed `expected_status` (`full_match` / `partial_match` / `no_match` / `null`), computed `data_in_sync` (boolean / null), timestamps.
- `chaos_rules`: stations + mode + config + enabled flag.

The synchronization status is computed at write time based on the three station columns vs. the expected value. Dashboard reads this status directly — no separate aggregation pipeline needed.

## Chaos Scenarios

Configurable via the flight-director-api admin endpoints. Each rule targets a station (or all), optionally a team (or all), and has an enabled flag. Chaos only applies to ground-station endpoints, never to the mission-log endpoint.

| Scenario | Trigger | What Students Learn |
|---------|---------|---------------------|
| **Station Blackout** | Returns HTTP 500 on every request to the affected station. | Implementing retry with backoff; not losing pending work when a downstream is fully down. |
| **Bandwidth Throttle** | Returns HTTP 429 once requests-per-second limit is exceeded. Includes a `retry_after_ms` hint. | Respecting rate limits, queuing, and pacing traffic. |
| **Signal Delay** | Adds artificial latency (e.g. 2–5s) before responding. | Setting timeouts, parallelizing writes across stations instead of sequential calls. |
| **Incorrect Ordering** | The station accepts writes but applies them out of order if `sequence_number` is missing or stale. | Using sequence numbers / if-match tokens to enforce correct command order at each station. |

## Deep Space Network (Request Generator)

- Replaces the old "requester" name. Generates traffic against a student's relay URL.
- Endpoints: start a scenario, stop the current run, fetch status, fetch the per-request timeline.
- At minimum supports a "steady transmission" scenario (one command every N seconds for a fixed duration). The AI should add 2–3 more scenarios that exercise different patterns (burst, ramp-up, out-of-order, etc.).
- Each tick: generate a random selector + payload using space-themed values (e.g. `cmd-4821: fire_thruster`), set the expected value via mission-log, then POST to the student's `/replicate` endpoint. Record timestamp, latency, and status code for each call.
- Forwards the caller's PocketBase token to both the ground-station API and the student API.

## Mission Control (Frontend)

Keep it intentionally simple. Five tabs:

1. **Guide** — Story, world map with blinking station LEDs, animated packet flow diagram (Mission Control → Relay → 3 Stations), starter code snippet, auth setup, chaos scenarios, good-luck closer.
2. **API Reference** — Endpoint contract for the ground-station API. Method badges, request/response examples, parameter tables. Mission-log endpoint is NOT shown here (internal).
3. **Deep Space Network** — Form to start a scenario against a team's relay URL. Live status (running/stopped, elapsed, sent, success/fail counts). Auto-refreshing.
4. **Team Dashboard** — Team picker. For the selected team: a line chart of recent request response times, a pie chart of synchronization status, and a table showing each command with its expected value and the value at each station, color-coded so it is immediately obvious whether the three sources are in sync.
5. **Admin** — Database reset, table info, chaos rule management, quick manual command relay.

Dark space theme throughout (deep navy backgrounds, blue/cyan accents, subtle starfield touches). Avoid hyphens and dashes in copy where natural.

## Recommended Stack

- **Frontend**: React via Vite (CRA is deprecated and incompatible with React 19; Vite is simpler and faster). Use the PocketBase JS SDK. Use a lightweight chart library like Recharts. Keep state with React hooks — no Redux needed.
- **Backends**: Node.js + Express. Plain `pg` driver for Postgres. No ORM. Each service is a single `server.js` file plus a `package.json` — small enough that students can read it.
- **Auth**: PocketBase (deployed as a separate Coolify service from the official Docker image).
- **Database**: Single Postgres instance, shared by ground-station-api and flight-director-api.

## Student Starting Point

Day-one deliverables provided to students:

- A working **rover-relay-starter** Express app: receives `/replicate` requests, loops through the three stations, makes naive sequential PUTs. No retries, no persistence, no error handling. It works under perfect conditions and breaks under chaos.
- The Guide tab walks them through the story, API contract, and how to authenticate.
- The Team Dashboard lets them see in real time whether their writes are landing at all three stations.

Students fork the starter and improve it: add retries, parallelism, persistence, sequence-number handling, etc. They deploy their improved version somewhere reachable and point the Deep Space Network at its URL.

## Design Principles (Reminders for the AI)

- Single database, three columns for the sources of truth. No separate AZ databases.
- No scoring, ranking, or leaderboard logic anywhere.
- Team isolation is enforced by deriving `team_id` from the auth token, never trusting request bodies.
- Synchronization status is a computed field stored alongside each record so the dashboard can render it cheaply.
- When in doubt, choose the simpler option that still teaches the concept.
- Keep service boundaries clean: students only ever talk to the ground-station API. The flight-director-api and deep-space-network are admin/instructor tools.
- All copy and UI uses the consistent space theme: rover, mission control, ground stations (NASA / ESA / JAXA), commands, transmissions, blackouts, throttle, signal delay.
