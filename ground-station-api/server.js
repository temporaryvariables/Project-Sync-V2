// ground-station-api
// -----------------------------------------------------------------------------
// The "three sources of truth" that student relay services target. It exposes a
// write/read/delete endpoint per station (nasa, esa, jaxa) plus an internal
// mission-log endpoint that holds the expected value for each command.
//
// Chaos rules (blackout, throttle, signal delay, incorrect ordering) are applied
// ONLY to the station endpoints, never to the mission log.
//
// Every write recomputes the synchronization status of the row and stores it so
// the dashboard can read it cheaply.
// -----------------------------------------------------------------------------

import express from "express";
import cors from "cors";
import pg from "pg";

const PORT = process.env.PORT || 3001;
const POCKETBASE_URL = normalizeUrl(process.env.POCKETBASE_URL, "http://localhost:8090");
const STATIONS = ["nasa", "esa", "jaxa"];

// Accept service URLs with or without a scheme. A bare host like
// "auth.example.com" becomes "https://auth.example.com", while explicit
// internal URLs like "http://pocketbase:8090" are left untouched. Not used for
// the database connection string.
function normalizeUrl(value, fallback) {
  const v = (value || fallback || "").trim();
  if (!v) return v;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

// Safety net: the dev only auth bypass must never run in production. Real
// protection is simply not setting AUTH_BYPASS; this guard makes a mistake fatal.
if (process.env.AUTH_BYPASS === "true" && process.env.NODE_ENV === "production") {
  console.error("FATAL: AUTH_BYPASS must not be enabled when NODE_ENV=production");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// Auth: validate the Bearer token against PocketBase and derive team_id.
// The team is NEVER trusted from the request body.
// -----------------------------------------------------------------------------
async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  // Local development bypass. When AUTH_BYPASS=true the team is taken directly
  // from the Bearer token string instead of being validated against PocketBase.
  // This lets the stack run end to end without an auth server. Never enable in
  // a real deployment.
  if (process.env.AUTH_BYPASS === "true") {
    req.teamId = token || "local-team";
    req.userId = "dev-user";
    return next();
  }

  if (!token) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }
  try {
    const r = await fetch(
      `${POCKETBASE_URL}/api/collections/users/auth-refresh`,
      { method: "POST", headers: { Authorization: token } }
    );
    if (!r.ok) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    const data = await r.json();
    const teamId = data?.record?.team_id;
    if (!teamId) {
      return res
        .status(403)
        .json({ error: "Your account is not assigned to a team" });
    }
    req.teamId = teamId;
    req.userId = data.record.id;
    next();
  } catch (err) {
    console.error("auth error", err);
    res.status(502).json({ error: "Auth service unreachable" });
  }
}

// -----------------------------------------------------------------------------
// Chaos engine. Returns the active rules for a given team + station, then a tiny
// helper applies them. Throttle state is kept in memory per team+station.
// -----------------------------------------------------------------------------
const throttleBuckets = new Map(); // key: team|station -> { windowStart, count }

async function activeRules(teamId, station) {
  const { rows } = await pool.query(
    `SELECT * FROM chaos_rules
       WHERE enabled = true
         AND (station = $1 OR station = 'all')
         AND (team_id IS NULL OR team_id = $2)`,
    [station, teamId]
  );
  return rows;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Applies chaos for a station write/read. Returns null when the request may
// proceed normally, or an object describing how to short circuit the response.
async function applyChaos(teamId, station, rules) {
  for (const rule of rules) {
    const cfg = rule.config || {};

    if (rule.mode === "blackout") {
      return {
        status: 500,
        body: { error: `Station ${station.toUpperCase()} blackout. No signal.` },
      };
    }

    if (rule.mode === "throttle") {
      const limit = cfg.requests_per_second ?? 2;
      const retryAfterMs = cfg.retry_after_ms ?? 1000;
      const key = `${teamId}|${station}`;
      const now = Date.now();
      let bucket = throttleBuckets.get(key);
      if (!bucket || now - bucket.windowStart >= 1000) {
        bucket = { windowStart: now, count: 0 };
      }
      bucket.count += 1;
      throttleBuckets.set(key, bucket);
      if (bucket.count > limit) {
        return {
          status: 429,
          headers: { "Retry-After": Math.ceil(retryAfterMs / 1000) },
          body: {
            error: `Bandwidth throttle on ${station.toUpperCase()}.`,
            retry_after_ms: retryAfterMs,
          },
        };
      }
    }

    if (rule.mode === "signal_delay") {
      const min = cfg.min_ms ?? 2000;
      const max = cfg.max_ms ?? 5000;
      const delay = Math.floor(min + Math.random() * Math.max(0, max - min));
      await sleep(delay);
      // proceeds normally after the delay
    }
  }
  return null;
}

// Decides whether a write is rejected for ordering reasons. With an active
// "incorrect_ordering" rule, a write with a missing or stale sequence_number is
// rejected so students learn to send monotonic sequence numbers / if-match.
function orderingRejection(rules, incomingSeq, currentSeq) {
  const rule = rules.find((r) => r.mode === "incorrect_ordering");
  if (!rule) return null;
  if (incomingSeq === null || incomingSeq === undefined) {
    return {
      status: 409,
      body: {
        error: "Command rejected: missing sequence_number. Order not guaranteed.",
      },
    };
  }
  if (currentSeq !== null && currentSeq !== undefined && incomingSeq <= currentSeq) {
    return {
      status: 409,
      body: {
        error: `Command rejected: stale sequence_number ${incomingSeq} (current ${currentSeq}).`,
        current_sequence_number: currentSeq,
      },
    };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Synchronization status computation.
// expected_status: full_match | partial_match | no_match | null
// data_in_sync: true when all three stations equal the expected payload.
// -----------------------------------------------------------------------------
function computeStatus(row) {
  const expected = row.expected_payload;
  if (expected === null || expected === undefined) {
    return { expected_status: null, data_in_sync: null };
  }
  const stations = [row.nasa_payload, row.esa_payload, row.jaxa_payload];
  const matches = stations.filter((s) => s === expected).length;
  let expected_status;
  if (matches === 3) expected_status = "full_match";
  else if (matches === 0) expected_status = "no_match";
  else expected_status = "partial_match";
  return { expected_status, data_in_sync: matches === 3 };
}

// Loads the row for (team, selector) or returns a blank shell.
async function loadRow(client, teamId, selector) {
  const { rows } = await client.query(
    `SELECT * FROM replication_records WHERE team_id = $1 AND selector = $2`,
    [teamId, selector]
  );
  return rows[0] || null;
}

// Upserts a single column (a station payload, or the expected payload from the
// mission log) and recomputes the synchronization status.
async function writeColumn(teamId, selector, column, payload, extra = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await loadRow(client, teamId, selector);
    const base = existing || {
      nasa_payload: null,
      esa_payload: null,
      jaxa_payload: null,
      expected_payload: null,
      sequence_number: null,
      if_match: null,
    };
    const merged = {
      ...base,
      [column]: payload,
      sequence_number:
        extra.sequence_number !== undefined
          ? extra.sequence_number
          : base.sequence_number,
      if_match: extra.if_match !== undefined ? extra.if_match : base.if_match,
    };
    const status = computeStatus(merged);

    const { rows } = await client.query(
      `INSERT INTO replication_records
         (team_id, selector, nasa_payload, esa_payload, jaxa_payload,
          expected_payload, sequence_number, if_match,
          expected_status, data_in_sync, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (team_id, selector) DO UPDATE SET
         nasa_payload = EXCLUDED.nasa_payload,
         esa_payload = EXCLUDED.esa_payload,
         jaxa_payload = EXCLUDED.jaxa_payload,
         expected_payload = EXCLUDED.expected_payload,
         sequence_number = EXCLUDED.sequence_number,
         if_match = EXCLUDED.if_match,
         expected_status = EXCLUDED.expected_status,
         data_in_sync = EXCLUDED.data_in_sync,
         updated_at = now()
       RETURNING *`,
      [
        teamId,
        selector,
        merged.nasa_payload,
        merged.esa_payload,
        merged.jaxa_payload,
        merged.expected_payload,
        merged.sequence_number,
        merged.if_match,
        status.expected_status,
        status.data_in_sync,
      ]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ status: "ok", service: "ground-station-api" }));

// All other routes require auth.
app.use(authenticate);

// --- Station endpoints (chaos applies) ---------------------------------------

// List every command stored at a single station (paginated). Chaos applies, so
// a blackout/throttle here behaves the same as on the per selector endpoints.
app.get("/groundstation/:station", async (req, res) => {
  const station = req.params.station.toLowerCase();
  if (!STATIONS.includes(station)) return res.status(404).json({ error: "Unknown station" });
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage) || 50));
  const offset = (page - 1) * perPage;
  try {
    const rules = await activeRules(req.teamId, station);
    const chaos = await applyChaos(req.teamId, station, rules);
    if (chaos) return res.status(chaos.status).set(chaos.headers || {}).json(chaos.body);

    // station is whitelisted above, so the column name is safe to interpolate.
    const col = `${station}_payload`;
    const totalQ = await pool.query(
      `SELECT count(*)::int AS total FROM replication_records
         WHERE team_id = $1 AND ${col} IS NOT NULL`,
      [req.teamId]
    );
    const { rows } = await pool.query(
      `SELECT selector, ${col} AS payload, sequence_number, updated_at
         FROM replication_records
         WHERE team_id = $1 AND ${col} IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT $2 OFFSET $3`,
      [req.teamId, perPage, offset]
    );
    res.json({ station, page, perPage, total: totalQ.rows[0].total, items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.get("/groundstation/:station/:selector", async (req, res) => {
  const station = req.params.station.toLowerCase();
  if (!STATIONS.includes(station)) return res.status(404).json({ error: "Unknown station" });
  try {
    const rules = await activeRules(req.teamId, station);
    const chaos = await applyChaos(req.teamId, station, rules);
    if (chaos) return res.status(chaos.status).set(chaos.headers || {}).json(chaos.body);

    const row = await loadRow(pool, req.teamId, req.params.selector);
    const value = row ? row[`${station}_payload`] : null;
    if (value === null || value === undefined) return res.status(404).json({ error: "Not found" });
    res.json({ selector: req.params.selector, station, payload: value, sequence_number: row.sequence_number });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.put("/groundstation/:station/:selector", async (req, res) => {
  const station = req.params.station.toLowerCase();
  if (!STATIONS.includes(station)) return res.status(404).json({ error: "Unknown station" });
  const { payload, sequence_number, if_match } = req.body || {};
  if (payload === undefined) return res.status(400).json({ error: "payload is required" });

  try {
    const rules = await activeRules(req.teamId, station);
    const chaos = await applyChaos(req.teamId, station, rules);
    if (chaos) return res.status(chaos.status).set(chaos.headers || {}).json(chaos.body);

    const existing = await loadRow(pool, req.teamId, req.params.selector);
    const reject = orderingRejection(rules, sequence_number ?? null, existing?.sequence_number ?? null);
    if (reject) return res.status(reject.status).json(reject.body);

    const row = await writeColumn(req.teamId, req.params.selector, `${station}_payload`, payload, {
      sequence_number: sequence_number ?? existing?.sequence_number ?? null,
      if_match: if_match ?? existing?.if_match ?? null,
    });
    res.json({
      selector: row.selector,
      station,
      payload,
      expected_status: row.expected_status,
      data_in_sync: row.data_in_sync,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.delete("/groundstation/:station/:selector", async (req, res) => {
  const station = req.params.station.toLowerCase();
  if (!STATIONS.includes(station)) return res.status(404).json({ error: "Unknown station" });
  try {
    const rules = await activeRules(req.teamId, station);
    const chaos = await applyChaos(req.teamId, station, rules);
    if (chaos) return res.status(chaos.status).set(chaos.headers || {}).json(chaos.body);

    const row = await writeColumn(req.teamId, req.params.selector, `${station}_payload`, null);
    res.json({ selector: row.selector, station, deleted: true, data_in_sync: row.data_in_sync });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- Mission log endpoint (internal, NO chaos) -------------------------------
// Holds the expected value for each command. Used by the deep-space-network to
// set the target before transmitting to the student relay.
app.get("/missionlog/:selector", async (req, res) => {
  try {
    const row = await loadRow(pool, req.teamId, req.params.selector);
    if (!row || row.expected_payload === null) return res.status(404).json({ error: "Not found" });
    res.json({ selector: req.params.selector, payload: row.expected_payload, sequence_number: row.sequence_number });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.put("/missionlog/:selector", async (req, res) => {
  const { payload, sequence_number, if_match } = req.body || {};
  if (payload === undefined) return res.status(400).json({ error: "payload is required" });
  try {
    const row = await writeColumn(req.teamId, req.params.selector, "expected_payload", payload, {
      sequence_number: sequence_number ?? null,
      if_match: if_match ?? null,
    });
    res.json({
      selector: row.selector,
      payload,
      sequence_number: row.sequence_number,
      expected_status: row.expected_status,
      data_in_sync: row.data_in_sync,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.delete("/missionlog/:selector", async (req, res) => {
  try {
    const row = await writeColumn(req.teamId, req.params.selector, "expected_payload", null);
    res.json({ selector: row.selector, deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

// --- Paginated command list --------------------------------------------------
app.get("/commands", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(200, Math.max(1, parseInt(req.query.perPage) || 50));
  const offset = (page - 1) * perPage;
  try {
    const totalQ = await pool.query(
      `SELECT count(*)::int AS total FROM replication_records WHERE team_id = $1`,
      [req.teamId]
    );
    const { rows } = await pool.query(
      `SELECT * FROM replication_records
         WHERE team_id = $1
         ORDER BY updated_at DESC
         LIMIT $2 OFFSET $3`,
      [req.teamId, perPage, offset]
    );
    res.json({ page, perPage, total: totalQ.rows[0].total, items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.listen(PORT, () => {
  console.log(`ground-station-api listening on ${PORT}`);
});
