// rover-relay-starter
// -----------------------------------------------------------------------------
// This is your starting point. It receives a command on /replicate and forwards
// it to the three ground stations (NASA, ESA, JAXA) one after another.
//
// It is intentionally naive:
//   - sequential writes (slow when signal delay is active)
//   - no retries (gives up the moment a station blacks out)
//   - no rate limit handling (ignores 429 throttle responses)
//   - no sequence number safeguards (loses races on ordering chaos)
//   - no persistence (a crash loses everything in flight)
//
// It works under perfect conditions and breaks under chaos. Your mission is to
// fork this and make it survive: add retries with backoff, write to the three
// stations in parallel, respect Retry-After, and keep sequence numbers monotonic.
// -----------------------------------------------------------------------------

import express from "express";
import cors from "cors";

const PORT = process.env.PORT || 4000;
const GROUND_STATION_URL = normalizeUrl(process.env.GROUND_STATION_URL, "http://localhost:3001");
// Where to send your own log lines so they show up in Mission Control,
// interleaved with the platform's logs for the same command. You normally do
// NOT need to set this: the Deep Space Network tells the relay where to log via
// the X-Flight-Director-Url header on every command. Setting this env var just
// overrides that default. Set RELAY_LOGGING=false to turn your logs off.
const FLIGHT_DIRECTOR_URL = process.env.FLIGHT_DIRECTOR_URL
  ? normalizeUrl(process.env.FLIGHT_DIRECTOR_URL)
  : "";
const RELAY_LOGGING = process.env.RELAY_LOGGING !== "false"; // on by default
const STATIONS = ["nasa", "esa", "jaxa"];

// Accept the ground station URL with or without a scheme. A bare host like
// "stations.example.com" becomes "https://stations.example.com", while an
// explicit "http://ground-station-api:3001" is left untouched.
function normalizeUrl(value, fallback) {
  const v = (value || fallback || "").trim();
  if (!v) return v;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// Log your own story to Mission Control. This is ON by default.
//
// Call missionLog(...) anywhere in your relay to add a line to the trace for a
// command. It is fire and forget: it never slows down or breaks a replication.
// The Deep Space Network tells the relay where to log (X-Flight-Director-Url),
// so this just works with no setup. Set RELAY_LOGGING=false to turn it off.
//
// level: "info" | "success" | "warn" | "error"
// properties: any extra key/values you want to see in the dashboard.
// -----------------------------------------------------------------------------
function missionLog(ctx, { level = "info", step, selector, station, message, properties = {} }) {
  const { token, correlationId, flightDirectorUrl } = ctx;
  if (!RELAY_LOGGING || !token || !correlationId || !flightDirectorUrl) return;
  const auth = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  fetch(`${flightDirectorUrl}/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      ts: new Date().toISOString(),
      service: "rover-relay",
      level,
      step: step || "relay.note",
      selector,
      station,
      message,
      correlation_id: correlationId,
      meta: properties,
    }),
  }).catch(() => {});
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "rover-relay-starter" }));

// Forwards the incoming command to each station, in order, with no resilience.
app.post("/replicate", async (req, res) => {
  const { selector, payload, sequence_number } = req.body || {};
  if (!selector || payload === undefined) {
    return res.status(400).json({ error: "selector and payload are required" });
  }

  // The Deep Space Network forwards the caller's PocketBase token. We pass it
  // straight through to the ground station API.
  const auth = req.headers.authorization || "";

  // Propagate the trace context. The X-Correlation-Id header ties every hop of
  // this command together so the dashboard can show one end to end trace.
  // Forwarding it is good distributed-systems hygiene; keep doing it as you
  // make this relay resilient.
  const correlationId = req.headers["x-correlation-id"] || "";

  // The Deep Space Network tells us where to send our own log lines. An env var
  // (FLIGHT_DIRECTOR_URL) overrides it if you ever want to point somewhere else.
  const flightDirectorUrl = FLIGHT_DIRECTOR_URL || normalizeUrl(req.headers["x-flight-director-url"]);
  const log = { token: auth, correlationId, flightDirectorUrl };

  // Example of your own logging. Add, remove, or change these freely.
  missionLog(log, {
    level: "info",
    step: "relay.received",
    selector,
    message: `Relay received ${selector} ("${payload}") and will fan out to all three stations.`,
    properties: { payload, sequence_number },
  });

  const results = {};
  for (const station of STATIONS) {
    try {
      const r = await fetch(`${GROUND_STATION_URL}/groundstation/${station}/${selector}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
          ...(correlationId ? { "X-Correlation-Id": correlationId } : {}),
        },
        body: JSON.stringify({ payload, sequence_number }),
      });
      results[station] = r.status;
      missionLog(log, {
        level: r.ok ? "success" : "warn",
        step: "relay.station_result",
        selector,
        station,
        message: r.ok
          ? `Relay delivered ${selector} to ${station.toUpperCase()} (HTTP ${r.status}).`
          : `Relay got HTTP ${r.status} from ${station.toUpperCase()} for ${selector}. A resilient relay would retry or back off here.`,
        properties: { http_status: r.status },
      });
    } catch (err) {
      results[station] = "error";
      missionLog(log, {
        level: "error",
        step: "relay.station_result",
        selector,
        station,
        message: `Relay could not reach ${station.toUpperCase()} for ${selector}.`,
        properties: {},
      });
    }
  }

  res.json({ selector, relayed: results });
});

app.listen(PORT, () => {
  console.log(`rover-relay-starter listening on ${PORT}`);
  console.log(`forwarding to ground station at ${GROUND_STATION_URL}`);
});
