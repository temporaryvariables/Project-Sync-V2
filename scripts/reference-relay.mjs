// reference-relay (e2e only)
// -----------------------------------------------------------------------------
// A complete, working relay used by the end-to-end test harness in place of the
// student scaffold (rover-relay-starter), which is intentionally left empty.
//
// It mirrors what a basic correct relay does: forward each /replicate command to
// all three ground stations, passing through the auth token and correlation id.
// Written with Node's built-in `http` module and global `fetch` so it has ZERO
// dependencies and runs anywhere `node` runs.
// -----------------------------------------------------------------------------

import http from "node:http";

const PORT = process.env.PORT || 4000;
const GROUND_STATION_URL = (process.env.GROUND_STATION_URL || "http://localhost:3001").replace(/\/$/, "");
const FLIGHT_DIRECTOR_URL = (process.env.FLIGHT_DIRECTOR_URL || "http://localhost:3002").replace(/\/$/, "");
const STATIONS = ["nasa", "esa", "jaxa"];

// Fire-and-forget log line so the harness can verify relay logging works.
function missionLog(token, correlationId, event) {
  if (!token || !correlationId) return;
  const auth = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  fetch(`${FLIGHT_DIRECTOR_URL}/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ ts: new Date().toISOString(), service: "rover-relay", correlation_id: correlationId, ...event }),
  }).catch(() => {});
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { status: "ok", service: "reference-relay" });
  }

  if (req.method === "POST" && req.url === "/replicate") {
    const { selector, payload, sequence_number } = await readBody(req);
    if (!selector || payload === undefined) {
      return send(res, 400, { error: "selector and payload are required" });
    }
    const auth = req.headers["authorization"] || "";
    const correlationId = req.headers["x-correlation-id"] || "";
    missionLog(auth, correlationId, {
      level: "info",
      step: "relay.received",
      selector,
      message: `Relay received ${selector} ("${payload}") and will fan out to all three stations.`,
      meta: { payload, sequence_number },
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
      } catch {
        results[station] = "error";
      }
    }
    return send(res, 200, { selector, relayed: results });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`reference-relay listening on ${PORT}`);
  console.log(`forwarding to ground station at ${GROUND_STATION_URL}`);
});
