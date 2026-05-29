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
const POCKETBASE_URL = process.env.POCKETBASE_URL || "http://localhost:8090";
const STATIONS = ["nasa", "esa", "jaxa", "all"];
const MODES = ["blackout", "throttle", "signal_delay", "incorrect_ordering"];

// Safety net: the dev only auth bypass must never run in production.
if (process.env.AUTH_BYPASS === "true" && process.env.NODE_ENV === "production") {
  console.error("FATAL: AUTH_BYPASS must not be enabled when NODE_ENV=production");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

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

// --- Reset: wipe this team's records and chaos rules -------------------------
app.post("/reset", async (req, res) => {
  try {
    const records = await pool.query(
      `DELETE FROM replication_records WHERE team_id = $1`,
      [req.teamId]
    );
    const chaos = await pool.query(
      `DELETE FROM chaos_rules WHERE team_id = $1`,
      [req.teamId]
    );
    res.json({
      reset: true,
      team_id: req.teamId,
      records_deleted: records.rowCount,
      chaos_rules_deleted: chaos.rowCount,
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

app.listen(PORT, () => {
  console.log(`flight-director-api listening on ${PORT}`);
});
