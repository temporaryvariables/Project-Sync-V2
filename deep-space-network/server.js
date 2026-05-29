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
const POCKETBASE_URL = process.env.POCKETBASE_URL || "http://localhost:8090";
const GROUND_STATION_URL = process.env.GROUND_STATION_URL || "http://localhost:3001";

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
    description: "Sends sequence numbers out of order on purpose. Tests ordering safeguards.",
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
    startedAt: null,
    stoppedAt: null,
    sent: 0,
    success: 0,
    fail: 0,
    timer: null,
    seq: 0,
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
  const { selector, payload } = randomCommand();

  // Scrambled orbit deliberately jitters the sequence number around.
  let sequence_number;
  if (scenarioKey === "scrambled_orbit") {
    run.seq += 1;
    sequence_number = run.seq + Math.floor(Math.random() * 7) - 3; // +/- jitter
  } else {
    run.seq += 1;
    sequence_number = run.seq;
  }

  const auth = `Bearer ${token}`;

  // 1. Set expected value via mission log (internal, no chaos).
  try {
    await fetch(`${GROUND_STATION_URL}/missionlog/${selector}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ payload, sequence_number }),
    });
  } catch (err) {
    // If the mission log can't be set, still record the attempt as a failure.
    recordResult(run, selector, payload, 0, 0, false, "mission log unreachable");
    return;
  }

  // 2. Transmit to the student relay.
  const started = Date.now();
  try {
    const r = await fetch(`${run.relayUrl.replace(/\/$/, "")}/replicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ selector, payload, sequence_number }),
    });
    const latency = Date.now() - started;
    recordResult(run, selector, payload, latency, r.status, r.ok, r.ok ? null : `relay returned ${r.status}`);
  } catch (err) {
    const latency = Date.now() - started;
    recordResult(run, selector, payload, latency, 0, false, "relay unreachable");
  }
}

function recordResult(run, selector, payload, latencyMs, status, ok, error) {
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

app.post("/start", (req, res) => {
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
  startRun(req.teamId, req.bearer, scenario, relayUrl, config || {});
  res.json({ started: true, ...statusOf(getRun(req.teamId)) });
});

app.post("/stop", (req, res) => {
  const run = getRun(req.teamId);
  if (!run.running) return res.json({ stopped: true, ...statusOf(run) });
  stopRun(req.teamId);
  res.json({ stopped: true, ...statusOf(getRun(req.teamId)) });
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
