// deep-space-network
// -----------------------------------------------------------------------------
// Generates traffic against a student relay service using configurable
// scenarios. For each command it:
//   1. picks a space themed selector + payload
//   2. sets the expected value via the ground-station mission log
//   3. POSTs the command to the student's /replicate endpoint
//   4. records the timestamp, latency, and status code
//
// The caller's PocketBase token is forwarded to BOTH the ground-station API and
// the student relay. Run state and the request timeline live in memory, scoped
// per team.
// -----------------------------------------------------------------------------

import express from "express";
import cors from "cors";

const PORT = process.env.PORT || 3003;
const POCKETBASE_URL = normalizeUrl(process.env.POCKETBASE_URL, "http://localhost:8090");
const GROUND_STATION_URL = normalizeUrl(process.env.GROUND_STATION_URL, "http://localhost:3001");
const FLIGHT_DIRECTOR_URL = normalizeUrl(process.env.FLIGHT_DIRECTOR_URL, "http://localhost:3002");

// Accept service URLs with or without a scheme. A bare host like
// "auth.example.com" becomes "https://auth.example.com", while explicit
// internal URLs like "http://ground-station-api:3001" are left untouched.
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

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// Space themed command vocabulary
// -----------------------------------------------------------------------------
const COMMANDS = [
  "fire_thruster",
  "deploy_solar_array",
  "extend_antenna",
  "capture_image",
  "run_diagnostics",
  "adjust_orbit",
  "sample_regolith",
  "transmit_telemetry",
  "rotate_panel",
  "enter_safe_mode",
];

function randomCommand() {
  const id = Math.floor(1000 + Math.random() * 9000);
  const action = COMMANDS[Math.floor(Math.random() * COMMANDS.length)];
  return { selector: `cmd-${id}`, payload: action };
}

// Scrambled orbit reuses a small pool of selectors so out-of-order writes
// actually collide on the same record. For each selector it emits a NEWER
// command (high sequence) followed by a STALE command (lower sequence) that
// arrives afterwards. A naive last-write-wins relay ends up with the stale
// payload at the stations while the expected value stays pinned to the newer
// one -> no_match. A relay that respects sequence numbers drops the stale write
// and stays in sync -> full_match. No chaos rule is required.
const SCRAMBLE_SELECTORS = ["cmd-7001", "cmd-7002", "cmd-7003", "cmd-7004"];

function nextTransmission(run, scenarioKey) {
  if (scenarioKey === "scrambled_orbit") {
    if (!run.scrambleQueue || run.scrambleQueue.length === 0) {
      run.scrambleIdx = (run.scrambleIdx ?? -1) + 1;
      const selector = SCRAMBLE_SELECTORS[run.scrambleIdx % SCRAMBLE_SELECTORS.length];
      run.seq += 2;
      const high = run.seq; // newer command
      const low = run.seq - 1; // stale command, transmitted afterwards
      const newest = COMMANDS[Math.floor(Math.random() * COMMANDS.length)];
      let stale = COMMANDS[Math.floor(Math.random() * COMMANDS.length)];
      if (stale === newest) {
        stale = COMMANDS[(COMMANDS.indexOf(newest) + 1) % COMMANDS.length];
      }
      run.scrambleQueue = [
        { selector, payload: newest, sequence_number: high },
        { selector, payload: stale, sequence_number: low },
      ];
    }
    return run.scrambleQueue.shift();
  }

  // Default: a unique selector with a monotonically increasing sequence.
  run.seq += 1;
  const { selector, payload } = randomCommand();
  return { selector, payload, sequence_number: run.seq };
}

// -----------------------------------------------------------------------------
// Scenarios. Each describes how many ticks, the gap between them, and an
// optional twist (burst grouping, ramping interval, or out of order sequence).
// -----------------------------------------------------------------------------
const SCENARIOS = {
  steady_transmission: {
    name: "Steady Transmission",
    description: "One command every N seconds for a fixed duration. The calm baseline.",
    defaults: { intervalMs: 3000, durationMs: 60000 },
  },
  signal_burst: {
    name: "Signal Burst",
    description: "Short rapid bursts of commands with quiet gaps in between. Tests batching and pacing.",
    defaults: { intervalMs: 400, durationMs: 60000, burst: 5, burstGapMs: 4000 },
  },
  ramp_up: {
    name: "Ramp Up",
    description: "Starts slow and steadily accelerates. Tests how the relay copes as load climbs.",
    defaults: { startIntervalMs: 4000, endIntervalMs: 500, durationMs: 60000 },
  },
  scrambled_orbit: {
    name: "Scrambled Orbit",
    description:
      "Reuses selectors and delivers a newer command followed by a stale one out of order. A relay that ignores sequence numbers ends up with the wrong value. Tests ordering safeguards.",
    defaults: { intervalMs: 2000, durationMs: 60000 },
  },
};

// -----------------------------------------------------------------------------
// Per team run state (in memory)
// -----------------------------------------------------------------------------
const runs = new Map(); // team_id -> run

function emptyRun() {
  return {
    running: false,
    scenario: null,
    relayUrl: null,
    relayTimeoutMs: 0, // 0 = no timeout (set from a relay_timeout chaos rule)
    startedAt: null,
    stoppedAt: null,
    sent: 0,
    success: 0,
    fail: 0,
    timer: null,
    seq: 0,
    scrambleQueue: [],
    scrambleIdx: -1,
    requests: [], // { ts, selector, payload, latencyMs, status, ok, error }
  };
}

function getRun(teamId) {
  if (!runs.has(teamId)) runs.set(teamId, emptyRun());
  return runs.get(teamId);
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  // Local development bypass (see ground-station-api for details). The token is
  // still forwarded downstream so the same team flows through the relay.
  if (process.env.AUTH_BYPASS === "true") {
    req.teamId = token || "local-team";
    req.bearer = token || "local-team";
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
    req.bearer = token;
    next();
  } catch (err) {
    console.error("auth error", err);
    res.status(502).json({ error: "Auth service unreachable" });
  }
}

// -----------------------------------------------------------------------------
// One tick: set the mission log, then transmit to the student relay.
// -----------------------------------------------------------------------------
async function tick(teamId, token, scenarioKey) {
  const run = getRun(teamId);
  const { selector, payload, sequence_number } = nextTransmission(run, scenarioKey);

  // A correlation id ties every step of this one command together across all
  // services, so the dashboard can render an end to end trace. Human readable
  // on purpose so students can eyeball it.
  const correlationId = `txn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const auth = `Bearer ${token}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: auth,
    "X-Correlation-Id": correlationId,
  };
  const trace = []; // collected log events, flushed once at the end of the tick

  // 1. Set expected value via mission log (internal, no chaos). The mission log
  // ignores stale sequences, so the expected value tracks the newest command.
  const mlStart = Date.now();
  try {
    const r = await fetch(`${GROUND_STATION_URL}/missionlog/${selector}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ payload, sequence_number }),
    });
    trace.push({
      ts: new Date(mlStart).toISOString(),
      correlation_id: correlationId,
      level: r.ok ? "info" : "error",
      step: "dsn.missionlog_set",
      selector,
      http_status: r.status,
      latency_ms: Date.now() - mlStart,
      message: r.ok
        ? `Mission Control logged the target for ${selector}: every station should end up holding "${payload}" (sequence ${sequence_number}).`
        : `Mission Control could not log the target for ${selector} (the ground station replied ${r.status}).`,
      meta: { payload, sequence_number },
    });
  } catch (err) {
    trace.push({
      ts: new Date(mlStart).toISOString(),
      correlation_id: correlationId,
      level: "error",
      step: "dsn.missionlog_set",
      selector,
      latency_ms: Date.now() - mlStart,
      message: `Mission Control could not reach the ground station to log the target for ${selector}.`,
      meta: { payload, sequence_number },
    });
    recordResult(run, selector, payload, 0, 0, false, "mission log unreachable", correlationId);
    flushTrace(token, trace);
    return;
  }

  // 2. Transmit to the student relay.
  const started = Date.now();
  // If a relay_timeout chaos rule is active, Mission Control aborts the call
  // once it takes too long instead of waiting forever.
  const ac = new AbortController();
  const timeoutMs = run.relayTimeoutMs || 0;
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const r = await fetch(`${run.relayUrl.replace(/\/$/, "")}/replicate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ selector, payload, sequence_number }),
      signal: ac.signal,
    });
    if (timer) clearTimeout(timer);
    const latency = Date.now() - started;
    trace.push({
      ts: new Date(started).toISOString(),
      correlation_id: correlationId,
      level: r.ok ? "success" : "error",
      step: "dsn.relay_transmit",
      selector,
      http_status: r.status,
      latency_ms: latency,
      message: r.ok
        ? `Transmitted ${selector} to your relay and it accepted the command in ${latency} ms.`
        : `Transmitted ${selector} to your relay but it answered with HTTP ${r.status} after ${latency} ms.`,
      meta: { payload, sequence_number, relayUrl: run.relayUrl },
    });
    recordResult(run, selector, payload, latency, r.status, r.ok, r.ok ? null : `relay returned ${r.status}`, correlationId);
  } catch (err) {
    if (timer) clearTimeout(timer);
    const latency = Date.now() - started;
    const timedOut = err.name === "AbortError";
    trace.push({
      ts: new Date(started).toISOString(),
      correlation_id: correlationId,
      level: "error",
      step: "dsn.relay_transmit",
      selector,
      latency_ms: latency,
      message: timedOut
        ? `Mission Control gave up on ${selector}: the relay did not respond within ${timeoutMs} ms (relay timeout chaos).`
        : `Could not reach your relay at ${run.relayUrl}. Is it running and reachable from the internet?`,
      meta: { relayUrl: run.relayUrl, ...(timedOut ? { timeout_ms: timeoutMs } : {}) },
    });
    recordResult(run, selector, payload, latency, 0, false, timedOut ? "relay timeout" : "relay unreachable", correlationId);
  }

  flushTrace(token, trace);
}

// Sends this tick's own log events to the flight-director logs database in a
// single batched call. Fire and forget: never blocks or fails a transmission.
function flushTrace(token, events) {
  if (!events.length || !token) return;
  const auth = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  fetch(`${FLIGHT_DIRECTOR_URL}/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ events: events.map((e) => ({ ...e, service: "deep-space-network" })) }),
  }).catch(() => {});
}

function recordResult(run, selector, payload, latencyMs, status, ok, error, correlationId) {
  run.sent += 1;
  if (ok) run.success += 1;
  else run.fail += 1;
  run.requests.push({
    ts: new Date().toISOString(),
    selector,
    payload,
    latencyMs,
    status,
    ok,
    error,
    correlationId: correlationId || null,
  });
  // Keep the timeline bounded.
  if (run.requests.length > 500) run.requests.splice(0, run.requests.length - 500);
}

// -----------------------------------------------------------------------------
// Scheduler. Each scenario computes the delay until the next tick.
// -----------------------------------------------------------------------------
function startRun(teamId, token, scenarioKey, relayUrl, overrides) {
  const scenario = SCENARIOS[scenarioKey];
  const cfg = { ...scenario.defaults, ...overrides };
  const run = getRun(teamId);

  Object.assign(run, emptyRun(), {
    running: true,
    scenario: scenarioKey,
    relayUrl,
    relayTimeoutMs: cfg.relayTimeoutMs || 0,
    startedAt: Date.now(),
    config: cfg,
  });

  let tickIndex = 0;

  const schedule = () => {
    if (!run.running) return;
    const elapsed = Date.now() - run.startedAt;
    if (elapsed >= cfg.durationMs) {
      stopRun(teamId);
      return;
    }

    tick(teamId, token, scenarioKey).catch((e) => console.error("tick error", e));
    tickIndex += 1;

    // Decide the delay to the next tick based on the scenario.
    let nextDelay;
    if (scenarioKey === "signal_burst") {
      const positionInBurst = tickIndex % cfg.burst;
      nextDelay = positionInBurst === 0 ? cfg.burstGapMs : cfg.intervalMs;
    } else if (scenarioKey === "ramp_up") {
      const progress = Math.min(1, elapsed / cfg.durationMs);
      nextDelay = cfg.startIntervalMs + (cfg.endIntervalMs - cfg.startIntervalMs) * progress;
    } else {
      nextDelay = cfg.intervalMs;
    }

    run.timer = setTimeout(schedule, nextDelay);
  };

  schedule();
}

function stopRun(teamId) {
  const run = getRun(teamId);
  if (run.timer) clearTimeout(run.timer);
  run.timer = null;
  run.running = false;
  run.stoppedAt = Date.now();
}

function statusOf(run) {
  const now = run.running ? Date.now() : run.stoppedAt || Date.now();
  return {
    running: run.running,
    scenario: run.scenario,
    relayUrl: run.relayUrl,
    elapsedMs: run.startedAt ? now - run.startedAt : 0,
    sent: run.sent,
    success: run.success,
    fail: run.fail,
  };
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ status: "ok", service: "deep-space-network" }));

app.use(authenticate);

app.get("/scenarios", (_req, res) => {
  res.json({
    items: Object.entries(SCENARIOS).map(([key, s]) => ({
      key,
      name: s.name,
      description: s.description,
      defaults: s.defaults,
    })),
  });
});

app.post("/start", async (req, res) => {
  const { scenario, relayUrl, config } = req.body || {};
  if (!SCENARIOS[scenario]) {
    return res.status(400).json({ error: `Unknown scenario. Choose from ${Object.keys(SCENARIOS).join(", ")}` });
  }
  if (!relayUrl || !/^https?:\/\//.test(relayUrl)) {
    return res.status(400).json({ error: "relayUrl must be a valid http(s) URL" });
  }
  const run = getRun(req.teamId);
  if (run.running) {
    return res.status(409).json({ error: "A run is already in progress. Stop it first." });
  }
  // The "relay timeout" chaos rule lives in the flight director. Read it once at
  // start: if enabled, Mission Control gives up on the relay after timeout_ms.
  const relayTimeoutMs = await fetchRelayTimeout(req.bearer);
  startRun(req.teamId, req.bearer, scenario, relayUrl, { ...(config || {}), relayTimeoutMs });
  res.json({ started: true, ...statusOf(getRun(req.teamId)) });
});

// Looks up an enabled relay_timeout chaos rule for this team and returns its
// timeout in ms (0 when none). Best effort: never blocks a start on failure.
async function fetchRelayTimeout(token) {
  try {
    const auth = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
    const r = await fetch(`${FLIGHT_DIRECTOR_URL}/chaos`, { headers: { Authorization: auth } });
    if (!r.ok) return 0;
    const data = await r.json();
    const rule = (data.items || []).find((c) => c.enabled && c.mode === "relay_timeout");
    const ms = rule ? Number(rule.config?.timeout_ms) : 0;
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch {
    return 0;
  }
}

app.post("/stop", (req, res) => {
  const run = getRun(req.teamId);
  if (!run.running) return res.json({ stopped: true, ...statusOf(run) });
  stopRun(req.teamId);
  res.json({ stopped: true, ...statusOf(getRun(req.teamId)) });
});

// Clears this team's in-memory request timeline and counters. Used by the
// dashboard's "Clear data" button. Refuses while a run is in progress.
app.post("/clear", (req, res) => {
  const run = getRun(req.teamId);
  if (run.running) {
    return res.status(409).json({ error: "Stop the transmission before clearing data." });
  }
  runs.set(req.teamId, emptyRun());
  res.json({ cleared: true, ...statusOf(getRun(req.teamId)) });
});

app.get("/status", (req, res) => {
  res.json(statusOf(getRun(req.teamId)));
});

app.get("/requests", (req, res) => {
  const run = getRun(req.teamId);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const items = run.requests.slice(-limit);
  res.json({ count: items.length, items });
});

app.listen(PORT, () => {
  console.log(`deep-space-network listening on ${PORT}`);
});
