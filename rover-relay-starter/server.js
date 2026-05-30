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
    } catch (err) {
      results[station] = "error";
    }
  }

  res.json({ selector, relayed: results });
});

app.listen(PORT, () => {
  console.log(`rover-relay-starter listening on ${PORT}`);
  console.log(`forwarding to ground station at ${GROUND_STATION_URL}`);
});
