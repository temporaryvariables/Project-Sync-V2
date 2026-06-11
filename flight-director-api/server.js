// flight-director-api
// -----------------------------------------------------------------------------
// Admin / dashboard API. Handles database lifecycle (reset), chaos rule CRUD,
// table info, and the aggregated records a team needs for the dashboard.
//
// All data is scoped by team_id derived from the auth token. Reset and chaos
// changes affect only the caller's team.
// -----------------------------------------------------------------------------

import express from "express";
import cors from "cors";
import pg from "pg";

const PORT = process.env.PORT || 3002;
const POCKETBASE_URL = normalizeUrl(process.env.POCKETBASE_URL, "http://localhost:8090");
const STATIONS = ["nasa", "esa", "jaxa", "all"];
const MODES = ["blackout", "throttle", "signal_delay", "incorrect_ordering", "relay_timeout"];

// Accept service URLs with or without a scheme. A bare host like
// "auth.example.com" becomes "https://auth.example.com", while explicit
// internal URLs like "http://pocketbase:8090" are left untouched. Not used for
// the database connection string.
function normalizeUrl(value, fallback) {
  const v = (value || fallback || "").trim();
  if (!v) return v;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

// Safety net: the dev only auth bypass must never run in production.
if (process.env.AUTH_BYPASS === "true" && process.env.NODE_ENV === "production") {
  console.error("FATAL: AUTH_BYPASS must not be enabled when NODE_ENV=production");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Logs live in their OWN, separate Postgres database so request tracing never
// competes with or pollutes the primary records database. Configure it with
// LOGS_DATABASE_URL. If it is not set we fall back to the primary DATABASE_URL
// so local development still works with a single database.
const logsPool = new pg.Pool({
  connectionString: process.env.LOGS_DATABASE_URL || process.env.DATABASE_URL,
});

// Database schema, kept in sync with postgres/init.sql. Every statement is
// idempotent (IF NOT EXISTS), so running it is safe on every reset: on a fresh
// database it creates the tables, and afterwards it is a harmless no op. This
// means the platform never needs a manual psql step to initialize.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS replication_records (
    id              BIGSERIAL PRIMARY KEY,
    team_id         TEXT        NOT NULL,
    selector        TEXT        NOT NULL,
    expected_payload TEXT,
    nasa_payload    TEXT,
    esa_payload     TEXT,
    jaxa_payload    TEXT,
    sequence_number BIGINT,
    nasa_seq        BIGINT,
    esa_seq         BIGINT,
    jaxa_seq        BIGINT,
    if_match        TEXT,
    expected_status TEXT,
    data_in_sync    BOOLEAN,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, selector)
);
-- Migrate older databases that predate the per station sequence columns.
ALTER TABLE replication_records ADD COLUMN IF NOT EXISTS nasa_seq BIGINT;
ALTER TABLE replication_records ADD COLUMN IF NOT EXISTS esa_seq BIGINT;
ALTER TABLE replication_records ADD COLUMN IF NOT EXISTS jaxa_seq BIGINT;
-- Links a command record to the most recent end to end trace for that command.
ALTER TABLE replication_records ADD COLUMN IF NOT EXISTS correlation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_replication_records_team
    ON replication_records (team_id);
CREATE INDEX IF NOT EXISTS idx_replication_records_team_updated
    ON replication_records (team_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chaos_rules (
    id          BIGSERIAL PRIMARY KEY,
    station     TEXT        NOT NULL DEFAULT 'all',
    team_id     TEXT,
    mode        TEXT        NOT NULL,
    config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    enabled     BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chaos_rules_enabled
    ON chaos_rules (enabled);

DROP TABLE IF EXISTS crew_members;
CREATE TABLE IF NOT EXISTS crew_members (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#38bdf8',
    message    TEXT,
    seat       INT  NOT NULL,
    created_by TEXT NOT NULL,
    version    INT  NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (seat)
);
`;

// Creates the schema if it does not exist yet. Safe to call repeatedly.
async function ensureSchema() {
  await pool.query(SCHEMA_SQL);
}

// Schema for the SEPARATE logs database. One row per step of a command's end to
// end journey, tied together by a correlation_id. Every statement is idempotent
// so it is safe to run on boot and on every reset.
const LOGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS request_logs (
    id              BIGSERIAL PRIMARY KEY,
    team_id         TEXT        NOT NULL,
    correlation_id  TEXT        NOT NULL,
    ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
    service         TEXT        NOT NULL,
    level           TEXT        NOT NULL DEFAULT 'info',
    step            TEXT        NOT NULL,
    selector        TEXT,
    station         TEXT,
    http_status     INT,
    latency_ms      INT,
    message         TEXT,
    meta            JSONB       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_request_logs_team_corr
    ON request_logs (team_id, correlation_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_team_ts
    ON request_logs (team_id, ts DESC);
`;

// Creates the logs schema in the separate logs database. Safe to call repeatedly.
async function ensureLogsSchema() {
  await logsPool.query(LOGS_SCHEMA_SQL);
}

// Keeps the logs table small: trims a team's logs to the most recent N rows.
// Called best effort after ingest so the table never grows unbounded.
const LOGS_RETENTION_PER_TEAM = 2000;
async function trimTeamLogs(teamId) {
  try {
    await logsPool.query(
      `DELETE FROM request_logs
         WHERE team_id = $1
           AND id NOT IN (
             SELECT id FROM request_logs
              WHERE team_id = $1
              ORDER BY id DESC
              LIMIT $2
           )`,
      [teamId, LOGS_RETENTION_PER_TEAM]
    );
  } catch (err) {
    console.error("log trim failed:", err.message);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  // Local development bypass (see ground-station-api for details).
  if (process.env.AUTH_BYPASS === "true") {
    req.teamId = token || "local-team";
    req.userId = "dev-user";
    req.role = "admin";
    return next();
  }

  if (!token) return res.status(401).json({ error: "Missing Bearer token" });
  try {
    const r = await fetch(`${POCKETBASE_URL}/api/collections/users/auth-refresh`, {
      method: "POST",
      headers: { Authorization: token },
    });
    if (!r.ok) return res.status(401).json({ error: "Invalid or expired token" });
    const data = await r.json();
    const teamId = data?.record?.team_id;
    if (!teamId) return res.status(403).json({ error: "Your account is not assigned to a team" });
    req.teamId = teamId;
    req.userId = data.record.id;
    req.role = (data.record.role || "read").toLowerCase();
    next();
  } catch (err) {
    console.error("auth error", err);
    res.status(502).json({ error: "Auth service unreachable" });
  }
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "flight-director-api" }));

app.use(authenticate);

// --- Reset: create the schema if needed, then wipe this team's data ----------
// On a fresh database the first reset creates the tables (deleting nothing).
// Afterwards it is the usual team scoped wipe. This removes any need for psql.
app.post("/reset", async (req, res) => {
  try {
    await ensureSchema();
    await ensureLogsSchema();
    const records = await pool.query(
      `DELETE FROM replication_records WHERE team_id = $1`,
      [req.teamId]
    );
    // Always clear this team's request logs on reset so traces never bleed
    // across runs (the Start button calls reset for a clean slate).
    let logsDeleted = 0;
    try {
      const logs = await logsPool.query(
        `DELETE FROM request_logs WHERE team_id = $1`,
        [req.teamId]
      );
      logsDeleted = logs.rowCount;
    } catch (err) {
      console.error("log reset failed:", err.message);
    }
    // When keepChaos is set we only clear the command records (used by the Deep
    // Space Network "Start" button for a clean slate) and leave chaos rules in
    // place so the configured scenario still applies.
    const keepChaos = req.query.keepChaos === "true" || req.body?.keepChaos === true;
    let chaosDeleted = 0;
    if (!keepChaos) {
      const chaos = await pool.query(
        `DELETE FROM chaos_rules WHERE team_id = $1`,
        [req.teamId]
      );
      chaosDeleted = chaos.rowCount;
    }
    // Clear the global crew roster (Learn tab).
    let crewDeleted = 0;
    try {
      const crew = await pool.query(`DELETE FROM crew_members`);
      crewDeleted = crew.rowCount;
    } catch { /* table may not exist yet */ }
    res.json({
      reset: true,
      team_id: req.teamId,
      records_deleted: records.rowCount,
      chaos_rules_deleted: chaosDeleted,
      logs_deleted: logsDeleted,
      crew_deleted: crewDeleted,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- Table info: counts and a status breakdown for this team -----------------
app.get("/tables", async (req, res) => {
  try {
    const records = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE expected_status = 'full_match')::int AS full_match,
              count(*) FILTER (WHERE expected_status = 'partial_match')::int AS partial_match,
              count(*) FILTER (WHERE expected_status = 'no_match')::int AS no_match,
              count(*) FILTER (WHERE expected_status IS NULL)::int AS pending
         FROM replication_records WHERE team_id = $1`,
      [req.teamId]
    );
    const chaos = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE enabled)::int AS enabled
         FROM chaos_rules WHERE team_id = $1 OR team_id IS NULL`,
      [req.teamId]
    );
    res.json({
      team_id: req.teamId,
      replication_records: records.rows[0],
      chaos_rules: chaos.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- Chaos rule CRUD ---------------------------------------------------------
app.get("/chaos", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM chaos_rules
         WHERE team_id = $1 OR team_id IS NULL
         ORDER BY created_at DESC`,
      [req.teamId]
    );
    res.json({ items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/chaos", async (req, res) => {
  const { station = "all", mode, config = {}, enabled = true, all_teams = false } = req.body || {};
  if (!MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of ${MODES.join(", ")}` });
  }
  if (!STATIONS.includes(station)) {
    return res.status(400).json({ error: `station must be one of ${STATIONS.join(", ")}` });
  }
  // Rules created here belong to the caller's team unless explicitly global.
  const teamId = all_teams ? null : req.teamId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO chaos_rules (station, team_id, mode, config, enabled)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [station, teamId, mode, config, enabled]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.patch("/chaos/:id", async (req, res) => {
  const { station, mode, config, enabled } = req.body || {};
  if (mode !== undefined && !MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of ${MODES.join(", ")}` });
  }
  if (station !== undefined && !STATIONS.includes(station)) {
    return res.status(400).json({ error: `station must be one of ${STATIONS.join(", ")}` });
  }
  try {
    // Only allow editing rules the team owns (its own or global ones).
    const { rows } = await pool.query(
      `UPDATE chaos_rules SET
         station = COALESCE($2, station),
         mode = COALESCE($3, mode),
         config = COALESCE($4, config),
         enabled = COALESCE($5, enabled),
         updated_at = now()
       WHERE id = $1 AND (team_id = $6 OR team_id IS NULL)
       RETURNING *`,
      [req.params.id, station, mode, config, enabled, req.teamId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Rule not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.delete("/chaos/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM chaos_rules WHERE id = $1 AND (team_id = $2 OR team_id IS NULL)`,
      [req.params.id, req.teamId]
    );
    if (!rowCount) return res.status(404).json({ error: "Rule not found" });
    res.json({ deleted: true, id: Number(req.params.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- Team records for the dashboard ------------------------------------------
// A team may only read its own records. The :teamId in the path must match the
// team derived from the token, otherwise it is rejected.
app.get("/teams/:teamId/records", async (req, res) => {
  if (req.params.teamId !== req.teamId) {
    return res.status(403).json({ error: "You may only read your own team's records" });
  }
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  try {
    const { rows } = await pool.query(
      `SELECT * FROM replication_records
         WHERE team_id = $1
         ORDER BY updated_at DESC
         LIMIT $2`,
      [req.teamId, limit]
    );
    const summary = await pool.query(
      `SELECT
         count(*) FILTER (WHERE expected_status = 'full_match')::int AS full_match,
         count(*) FILTER (WHERE expected_status = 'partial_match')::int AS partial_match,
         count(*) FILTER (WHERE expected_status = 'no_match')::int AS no_match,
         count(*) FILTER (WHERE expected_status IS NULL)::int AS pending
       FROM replication_records WHERE team_id = $1`,
      [req.teamId]
    );
    res.json({ team_id: req.teamId, summary: summary.rows[0], items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- Request logs (separate logs database) -----------------------------------
// One row per step of a command's end to end journey. Every read and write is
// scoped to the team derived from the token, so a team can ONLY ever see or
// write its own logs.
const LOG_LEVELS = ["info", "success", "warn", "error"];

function sanitizeEvent(ev, teamId) {
  if (!ev || typeof ev !== "object") return null;
  const correlation_id = String(ev.correlation_id || "").slice(0, 120);
  const service = String(ev.service || "").slice(0, 60);
  const step = String(ev.step || "").slice(0, 80);
  if (!correlation_id || !service || !step) return null;
  const level = LOG_LEVELS.includes(ev.level) ? ev.level : "info";
  const toIntOrNull = (v) => (v === null || v === undefined || v === "" ? null : Number.parseInt(v, 10));
  return {
    team_id: teamId,
    correlation_id,
    ts: ev.ts ? new Date(ev.ts) : new Date(),
    service,
    level,
    step,
    selector: ev.selector ? String(ev.selector).slice(0, 200) : null,
    station: ev.station ? String(ev.station).slice(0, 20) : null,
    http_status: Number.isFinite(toIntOrNull(ev.http_status)) ? toIntOrNull(ev.http_status) : null,
    latency_ms: Number.isFinite(toIntOrNull(ev.latency_ms)) ? toIntOrNull(ev.latency_ms) : null,
    message: ev.message ? String(ev.message).slice(0, 1000) : null,
    meta: ev.meta && typeof ev.meta === "object" ? ev.meta : {},
  };
}

// Ingest one or many log events. Accepts { events: [...] } or a single event
// object. The team is taken from the token, never from the body.
app.post("/logs", async (req, res) => {
  try {
    await ensureLogsSchema();
    const raw = Array.isArray(req.body?.events) ? req.body.events : [req.body];
    const events = raw.map((e) => sanitizeEvent(e, req.teamId)).filter(Boolean).slice(0, 100);
    if (events.length === 0) return res.status(400).json({ error: "No valid log events" });

    // Build a single multi row insert.
    const cols = [
      "team_id", "correlation_id", "ts", "service", "level",
      "step", "selector", "station", "http_status", "latency_ms", "message", "meta",
    ];
    const values = [];
    const placeholders = events.map((ev, i) => {
      const base = i * cols.length;
      values.push(
        ev.team_id, ev.correlation_id, ev.ts, ev.service, ev.level,
        ev.step, ev.selector, ev.station, ev.http_status, ev.latency_ms, ev.message, ev.meta
      );
      return `(${cols.map((_, c) => `$${base + c + 1}`).join(",")})`;
    });
    await logsPool.query(
      `INSERT INTO request_logs (${cols.join(",")}) VALUES ${placeholders.join(",")}`,
      values
    );
    trimTeamLogs(req.teamId); // best effort, not awaited
    res.status(201).json({ ingested: events.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// Recent logs for this team, newest first. Optional filters: level, selector,
// correlationId, since (ISO timestamp).
app.get("/logs", async (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 200));
  const filters = ["team_id = $1"];
  const params = [req.teamId];
  if (req.query.level && LOG_LEVELS.includes(req.query.level)) {
    params.push(req.query.level);
    filters.push(`level = $${params.length}`);
  }
  if (req.query.selector) {
    params.push(String(req.query.selector));
    filters.push(`selector = $${params.length}`);
  }
  if (req.query.correlationId) {
    params.push(String(req.query.correlationId));
    filters.push(`correlation_id = $${params.length}`);
  }
  if (req.query.since) {
    params.push(new Date(req.query.since));
    filters.push(`ts >= $${params.length}`);
  }
  params.push(limit);
  try {
    await ensureLogsSchema();
    const { rows } = await logsPool.query(
      `SELECT * FROM request_logs
         WHERE ${filters.join(" AND ")}
         ORDER BY ts DESC, id DESC
         LIMIT $${params.length}`,
      params
    );
    res.json({ team_id: req.teamId, count: rows.length, items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// Full ordered trace for a single command (chronological).
app.get("/logs/:correlationId", async (req, res) => {
  try {
    await ensureLogsSchema();
    const { rows } = await logsPool.query(
      `SELECT * FROM request_logs
         WHERE team_id = $1 AND correlation_id = $2
         ORDER BY ts ASC, id ASC`,
      [req.teamId, req.params.correlationId]
    );
    res.json({
      team_id: req.teamId,
      correlation_id: req.params.correlationId,
      count: rows.length,
      items: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// Explicit logs reset for this team (init + wipe). The schema is created if the
// logs database is brand new, then the team's rows are removed.
app.post("/logs/reset", async (req, res) => {
  try {
    await ensureLogsSchema();
    const r = await logsPool.query(`DELETE FROM request_logs WHERE team_id = $1`, [req.teamId]);
    res.json({ reset: true, team_id: req.teamId, logs_deleted: r.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// =============================================================================
// Crew Members — Learn tab (global, shared by all students)
// =============================================================================
// A single shared roster visible to everyone. Chaos behaviors are triggered by
// special name prefixes: blackout*, throttle*, delay<N>.
// Seat 0 = pilot (admin-only). Seats 1-20 = crew.

const MAX_CREW = 21; // 1 pilot + 20 crew
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 ]{0,10}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

// Throttle gate: only one throttle-named member may be created every 5 seconds.
let lastThrottleCreate = 0;

// Validate name: alphanumeric + spaces (no leading/trailing spaces), 1-12 chars.
function validateName(raw) {
  if (!raw || typeof raw !== "string") return { error: "name is required" };
  const name = raw.trim();
  if (!name) return { error: "name cannot be blank" };
  if (name.length > 12) return { error: "name must be at most 12 characters" };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 ]*[a-zA-Z0-9]$/.test(name) && !/^[a-zA-Z0-9]$/.test(name))
    return { error: "name must be alphanumeric (spaces allowed between characters, no leading/trailing spaces)" };
  return { name };
}

// GET /crew — list all members
app.get("/crew", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, color, message, seat, created_by, version, created_at FROM crew_members ORDER BY seat`
    );
    res.json({ count: rows.length, max: MAX_CREW, items: rows, user_id: req.userId, role: req.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// GET /crew/:id — single member
app.get("/crew/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, color, message, seat, created_by, version, created_at FROM crew_members WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Crew member not found" });
    const lowerName = rows[0].name.toLowerCase();
    // Chaos: blackout
    if (lowerName.startsWith("blackout")) {
      return res.status(500).json({ error: `Crew member ${rows[0].name} is lost in deep space — no signal` });
    }
    // Chaos: delay
    const delayMatch = lowerName.match(/^delay(\d+)/);
    if (delayMatch) {
      const delaySec = parseInt(delayMatch[1], 10);
      if (delaySec >= 5) {
        await new Promise((r) => setTimeout(r, 5000));
        return res.status(504).json({ error: `Signal lost — response for ${rows[0].name} took too long (>5s timeout)` });
      }
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// PUT /crew — create a new member
app.put("/crew", async (req, res) => {
  const { color, seat, message } = req.body || {};
  const v = validateName(req.body?.name);
  if (v.error) return res.status(400).json({ error: v.error });
  const name = v.name;
  if (!color || typeof color !== "string") return res.status(400).json({ error: "color is required" });
  if (seat === undefined || seat === null || !Number.isInteger(seat) || seat < 0 || seat >= MAX_CREW)
    return res.status(400).json({ error: `seat must be an integer from 0 to ${MAX_CREW - 1}` });

  // Seat 0 = pilot — admin only
  if (seat === 0 && req.role !== "admin") {
    return res.status(403).json({ error: "Only an admin can assign the pilot seat." });
  }

  const lowerName = name.toLowerCase();

  // Chaos: blackout — member is never created
  if (lowerName.startsWith("blackout")) {
    return res.status(500).json({
      error: `Crew member ${name} is lost in deep space — no signal. The member was never added.`,
    });
  }

  // Chaos: throttle — rate limit to 1 throttle-named member per 5 seconds
  if (lowerName.includes("throttle")) {
    const now = Date.now();
    const elapsed = now - lastThrottleCreate;
    if (elapsed < 5000) {
      const waitMs = 5000 - elapsed;
      return res.status(429).json({
        error: `Throttled — only one throttle-named member may be added every 5 seconds.`,
        retry_after_ms: waitMs,
      });
    }
  }

  // Chaos: delay — artificial latency with 5s server-side timeout
  const delayMatch = lowerName.match(/^delay(\d+)/);
  if (delayMatch) {
    const delaySec = parseInt(delayMatch[1], 10);
    if (delaySec >= 5) {
      await new Promise((r) => setTimeout(r, 5000));
      return res.status(504).json({
        error: `Signal lost — adding ${name} took too long (>5s timeout). The member was not added.`,
      });
    }
    await new Promise((r) => setTimeout(r, delaySec * 1000));
  }

  // Transaction to enforce the cap and seat uniqueness.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const countResult = await client.query(`SELECT count(*)::int AS total FROM crew_members`);
    if (countResult.rows[0].total >= MAX_CREW) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: `Crew is at capacity (${MAX_CREW} seats). Remove someone first.`, max: MAX_CREW });
    }
    const { rows } = await client.query(
      `INSERT INTO crew_members (name, color, message, seat, created_by) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, color, message, seat, created_by, version, created_at`,
      [name, color, message || null, seat, req.userId]
    );
    await client.query("COMMIT");
    if (lowerName.includes("throttle")) lastThrottleCreate = Date.now();
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") {
      const msg = err.constraint?.includes("seat")
        ? `Seat ${seat} is already taken.`
        : `A crew member named "${name}" already exists.`;
      return res.status(409).json({ error: msg });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  } finally {
    client.release();
  }
});

// PATCH /crew/:id — update color/message only (no name/seat changes).
// Requires version for optimistic concurrency. Owner or admin only.
app.patch("/crew/:id", async (req, res) => {
  const { color, message, version } = req.body || {};
  if (version === undefined || version === null)
    return res.status(400).json({ error: "version is required for optimistic concurrency" });

  try {
    const current = await pool.query(
      `SELECT id, name, created_by, version FROM crew_members WHERE id = $1`,
      [req.params.id]
    );
    if (!current.rows[0]) return res.status(404).json({ error: "Crew member not found" });

    // Ownership check: creator or admin
    if (current.rows[0].created_by !== req.userId && req.role !== "admin") {
      return res.status(403).json({ error: "You can only edit crew members you created (or be an admin)." });
    }

    // Chaos: blackout
    if (current.rows[0].name.toLowerCase().startsWith("blackout")) {
      return res.status(500).json({ error: `Crew member ${current.rows[0].name} is lost in deep space — no signal` });
    }
    // Chaos: delay
    const delayMatch = current.rows[0].name.toLowerCase().match(/^delay(\d+)/);
    if (delayMatch) {
      const delaySec = parseInt(delayMatch[1], 10);
      if (delaySec >= 5) {
        await new Promise((r) => setTimeout(r, 5000));
        return res.status(504).json({ error: `Signal lost — updating ${current.rows[0].name} took too long` });
      }
      await new Promise((r) => setTimeout(r, delaySec * 1000));
    }

    // Optimistic concurrency
    const { rows } = await pool.query(
      `UPDATE crew_members SET
         color   = COALESCE($2, color),
         message = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE message END,
         version = version + 1
       WHERE id = $1 AND version = $4
       RETURNING id, name, color, message, seat, created_by, version, created_at`,
      [req.params.id, color ?? null, message !== undefined ? message : null, version]
    );
    if (!rows[0]) {
      const fresh = await pool.query(`SELECT version FROM crew_members WHERE id = $1`, [req.params.id]);
      return res.status(409).json({
        error: `Version conflict — you sent version ${version} but current is ${fresh.rows[0]?.version}. Re-fetch and try again.`,
        current_version: fresh.rows[0]?.version,
      });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// DELETE /crew/:id — remove a member. Owner or admin only.
app.delete("/crew/:id", async (req, res) => {
  try {
    const current = await pool.query(
      `SELECT id, name, created_by FROM crew_members WHERE id = $1`,
      [req.params.id]
    );
    if (!current.rows[0]) return res.status(404).json({ error: "Crew member not found" });
    if (current.rows[0].created_by !== req.userId && req.role !== "admin") {
      return res.status(403).json({ error: "You can only remove crew members you created (or be an admin)." });
    }
    await pool.query(`DELETE FROM crew_members WHERE id = $1`, [req.params.id]);
    res.json({ deleted: true, id: current.rows[0].id, name: current.rows[0].name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

// DELETE /crew — remove all members (admin only)
app.delete("/crew", async (req, res) => {
  if (req.role !== "admin") {
    return res.status(403).json({ error: "Only an admin can clear the entire crew." });
  }
  try {
    const { rowCount } = await pool.query(`DELETE FROM crew_members`);
    res.json({ deleted: true, count: rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`flight-director-api listening on ${PORT}`);
  // Best effort: make sure the tables exist as soon as the service is up, so a
  // fresh deployment is usable without anyone calling /reset first. If the
  // database is briefly unreachable at boot, /reset will create them later.
  ensureSchema()
    .then(() => console.log("schema ready"))
    .catch((err) => console.error("schema init on boot failed (will retry on /reset):", err.message));
  ensureLogsSchema()
    .then(() => console.log("logs schema ready"))
    .catch((err) => console.error("logs schema init on boot failed (will retry on /reset):", err.message));
});
