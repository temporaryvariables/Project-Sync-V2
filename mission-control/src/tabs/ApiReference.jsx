const ENDPOINTS = [
  {
    method: "GET",
    path: "/health",
    auth: false,
    desc: "Liveness check. No authentication required.",
    response: `{ "status": "ok", "service": "ground-station-api" }`,
  },
  {
    method: "PUT",
    path: "/groundstation/:station/:selector",
    auth: true,
    desc: "Write a command payload to one station (nasa, esa or jaxa).",
    request: `{
  "payload": "fire_thruster",
  "sequence_number": 12,
  "if_match": "optional-token"
}`,
    response: `{
  "selector": "cmd-4821",
  "station": "nasa",
  "payload": "fire_thruster",
  "expected_status": "partial_match",
  "data_in_sync": false
}`,
  },
  {
    method: "GET",
    path: "/groundstation/:station/:selector",
    auth: true,
    desc: "Read the current payload stored at one station.",
    response: `{
  "selector": "cmd-4821",
  "station": "nasa",
  "payload": "fire_thruster",
  "sequence_number": 12
}`,
  },
  {
    method: "GET",
    path: "/groundstation/:station",
    auth: true,
    desc: "List every command currently stored at one station (paginated).",
    response: `{
  "station": "nasa",
  "page": 1,
  "perPage": 50,
  "total": 42,
  "items": [
    { "selector": "cmd-4821", "payload": "fire_thruster", "sequence_number": 12 }
  ]
}`,
  },
  {
    method: "DELETE",
    path: "/groundstation/:station/:selector",
    auth: true,
    desc: "Clear the payload at one station.",
    response: `{ "selector": "cmd-4821", "station": "nasa", "deleted": true, "data_in_sync": false }`,
  },
];

const PARAMS = [
  ["station", "path", "One of nasa, esa, jaxa."],
  ["selector", "path", "The command id, for example cmd-4821."],
  ["payload", "body", "The command value to store, for example fire_thruster."],
  ["sequence_number", "body", "Monotonic counter used to enforce ordering."],
  ["if_match", "body", "Optional concurrency token for ordering safeguards."],
];

const ERRORS = [
  ["401", "Missing or invalid Bearer token."],
  ["403", "Your account is not assigned to a team."],
  ["404", "Unknown station or selector not found."],
  ["409", "Ordering chaos rejected a missing or stale sequence_number."],
  ["429", "Bandwidth throttle. Includes retry_after_ms. Honor it and retry."],
  ["500", "Station blackout. Retry with backoff."],
];

export default function ApiReference() {
  return (
    <div>
      <div className="panel">
        <h2>Ground Station API</h2>
        <p className="muted">
          This is the only API your relay talks to. Every request needs an
          <span className="inline-code">Authorization: Bearer &lt;token&gt;</span> header except the healthcheck.
          Your team is derived from the token.
        </p>
      </div>

      {ENDPOINTS.map((e) => (
        <div className="panel" key={e.method + e.path}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className={`badge ${e.method.toLowerCase()}`}>{e.method}</span>
            <code style={{ fontSize: 15 }}>{e.path}</code>
            <span className="pill" style={{ marginLeft: "auto" }}>
              {e.auth ? "Auth required" : "No auth"}
            </span>
          </div>
          <p className="muted" style={{ marginBottom: 8 }}>{e.desc}</p>
          {e.request && (
            <>
              <h3>Request body</h3>
              <pre><code>{e.request}</code></pre>
            </>
          )}
          <h3>Response</h3>
          <pre><code>{e.response}</code></pre>
        </div>
      ))}

      <div className="grid cols-2">
        <div className="panel">
          <h2>Parameters</h2>
          <table className="param-table">
            <thead>
              <tr><th>Name</th><th>In</th><th>Description</th></tr>
            </thead>
            <tbody>
              {PARAMS.map(([name, loc, desc]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td className="muted">{loc}</td>
                  <td>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <h2>Status codes</h2>
          <table>
            <thead>
              <tr><th>Code</th><th>Meaning</th></tr>
            </thead>
            <tbody>
              {ERRORS.map(([code, desc]) => (
                <tr key={code}>
                  <td><code>{code}</code></td>
                  <td>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
