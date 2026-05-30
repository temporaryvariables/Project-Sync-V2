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
const MODES = ["blackout", "throttle", "signal_delay", "incorrect_ordering"];

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
    res.json({
      reset: true,
      team_id: req.teamId,
      records_deleted: records.rowCount,
      chaos_rules_deleted: chaosDeleted,
      logs_deleted: logsDeleted,
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
const LOG_LEVELS = ["info", "warn", "error"];

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
