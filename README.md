# Project Sync

An educational distributed systems platform with a space mission theme. Students build a relay service that replicates commands from **Mission Control** to three Earth ground stations (**NASA**, **ESA**, **JAXA**) while surviving chaos scenarios: blackouts, throttling, signal delay, and out of order commands.

> This is a teaching platform, not a production system. Everything is intentionally small and readable.

## Architecture

```
                         ┌────────────────────┐
                         │   Mission Control   │  React + Vite SPA (port 3000)
                         │      (frontend)     │
                         └─────────┬──────────┘
              ┌────────────────────┼─────────────────────┐
              │                    │                     │
     ┌────────▼────────┐  ┌────────▼────────┐  ┌─────────▼────────┐
     │ ground-station  │  │ flight-director │  │ deep-space-      │
     │      api        │  │      api        │  │ network          │
     │  (port 3001)    │  │  (port 3002)    │  │  (port 3003)     │
     └────────┬────────┘  └────────┬────────┘  └─────────┬────────┘
              │                    │                     │
              └──────────┬─────────┘                     │
                         │                               │
                  ┌──────▼──────┐                ┌───────▼────────┐
                  │  Postgres   │                │ student relay  │
                  │ (port 5432) │                │ /replicate     │
                  └─────────────┘                └───────┬────────┘
                                                         │
                  ┌─────────────┐                ┌───────▼────────┐
                  │ PocketBase  │  auth          │ ground-station │
                  │ (port 8090) │◄───────────────│      api       │
                  └─────────────┘                └────────────────┘
```

## Services

| Folder | Purpose | Port |
|--------|---------|------|
| `mission-control` | The single web UI (Guide, API Reference, Deep Space Network, Team Dashboard, Admin). | 3000 |
| `ground-station-api` | The three sources of truth that students target. Applies chaos rules. | 3001 |
| `flight-director-api` | Admin API: reset, table info, chaos CRUD, team records. | 3002 |
| `deep-space-network` | Traffic generator that runs scenarios against a student relay URL. | 3003 |
| `rover-relay-starter` | Student starter template. A naive `/replicate` that breaks under chaos. | 4000 |
| `pocketbase` | Authentication, users, teams. | 8090 |
| `postgres` | Single shared database. | 5432 |

## Quick start (local, Docker)

```bash
cp .env.example .env
docker compose up --build
```

Then open:

- Mission Control UI: http://localhost:3000
- PocketBase admin: http://localhost:8090/_/

### First time PocketBase setup

1. Open http://localhost:8090/_/ and create the first superuser account.
2. The `users` collection auth is created automatically on boot by `pocketbase/pb_migrations`. It adds a `team_id` text field.
3. Register a student user from the Mission Control login page, or create one in the PocketBase admin and set its `team_id`.

## Running a single service for development

Each backend is a single `server.js` plus a `package.json`:

```bash
cd ground-station-api
npm install
npm run dev
```

Environment variables are documented in `.env.example`.

## Deployment (Coolify)

This is a monorepo. Each folder is deployed as its own application. Use Coolify **watch paths** so only the changed service rebuilds:

- `ground-station-api/**`
- `flight-director-api/**`
- `deep-space-network/**`
- `mission-control/**`
- `rover-relay-starter/**`
- `pocketbase/**`

Postgres and PocketBase are deployed from their official images.

## The student journey

1. Read the **Guide** tab. Understand the story and the API contract.
2. Fork `rover-relay-starter`. It works under perfect conditions and breaks under chaos.
3. Improve it: add retries, parallelism, persistence, sequence number handling.
4. Deploy it somewhere reachable.
5. Point the **Deep Space Network** at the relay URL and watch the **Team Dashboard** to see whether all three stations stay in sync.
