const STARTER_SNIPPET = `// rover-relay-starter — an empty scaffold. The forwarding is YOUR job.
app.post("/replicate", async (req, res) => {
  const { selector, payload, sequence_number } = req.body || {};

  // Pass these straight through on every station call you make.
  const auth = req.headers.authorization || "";
  const correlationId = req.headers["x-correlation-id"] || "";

  // One example log line so you can see your story in the trace.
  missionLog(auth, correlationId, {
    level: "info",
    step: "relay.received",
    selector,
    message: \`Relay received \${selector} — implement forwarding next.\`,
    properties: { payload, sequence_number },
  });

  // TODO (your mission): forward to NASA, ESA and JAXA, e.g.
  //   PUT \`\${GROUND_STATION_URL}/groundstation/<station>/\${selector}\`
  //   headers: Authorization: auth, X-Correlation-Id: correlationId
  //   body:    { payload, sequence_number }
  // Start simple, then add retries, parallelism, Retry-After and
  // sequence-number safeguards to survive chaos.

  // For now, just acknowledge. Replace this with your real logic.
  res.status(200).end();
});`;

const AUTH_SNIPPET = `// The Deep Space Network forwards a PocketBase Bearer token.
// Pass it straight through to the ground station on every call.
const auth = req.headers.authorization; // "Bearer <token>"

await fetch(url, {
  headers: { Authorization: auth, "Content-Type": "application/json" },
  // ...
});`;

const SCENARIOS = [
  {
    title: "Station Blackout",
    desc: "The station returns HTTP 500 on every request. Learn to retry with backoff and never drop pending work.",
  },
  {
    title: "Bandwidth Throttle",
    desc: "Over the rate limit you get HTTP 429 with a retry_after_ms hint. Learn to pace and queue your traffic.",
  },
  {
    title: "Signal Delay",
    desc: "Responses arrive 2 to 5 seconds late. Learn to set timeouts and write to the three stations in parallel.",
  },
  {
    title: "Incorrect Ordering",
    desc: "Writes with a missing or stale sequence_number are rejected. Learn to keep sequence numbers monotonic.",
  },
];

export default function Guide() {
  return (
    <div>
      <div className="panel">
        <h2>Welcome to Project Sync</h2>
        <p className="muted">
          Mission Control transmits commands to a rover. Every command must reach three Earth ground stations,
          NASA, ESA and JAXA, exactly the same and in the right order. Deep space is noisy. Stations black out,
          bandwidth throttles, signals lag, and commands arrive scrambled. Your job is to build the relay that
          keeps all three sources of truth in sync no matter what.
        </p>

        <h3>The world map</h3>
        <div className="world-map">
          <div className="station-led" style={{ left: "22%", top: "42%" }}>
            <span className="led" />
            NASA
          </div>
          <div className="station-led" style={{ left: "52%", top: "32%" }}>
            <span className="led" />
            ESA
          </div>
          <div className="station-led" style={{ left: "78%", top: "60%" }}>
            <span className="led" />
            JAXA
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>How a command flows</h2>
        <div className="flow">
          <div className="flow-node">Mission Control</div>
          <div className="flow-arrow"><span className="packet" /></div>
          <div className="flow-node relay">Your Relay<br /><small className="muted">/replicate</small></div>
          <div className="flow-arrow"><span className="packet" style={{ animationDelay: "0.4s" }} /></div>
          <div className="flow-node stations">
            <span>NASA</span>
            <span>ESA</span>
            <span>JAXA</span>
          </div>
        </div>
        <p className="muted">
          The Deep Space Network generates traffic against your relay. For each command it posts to your{" "}
          <span className="inline-code">/replicate</span> endpoint. Your relay fans the command out to all three
          stations, and the dashboard shows whether the three sources of truth ended up in sync.
        </p>
      </div>

      <div className="grid cols-2">
        <div className="panel">
          <h2>Starter code</h2>
          <p className="muted">
            You begin with <span className="inline-code">rover-relay-starter</span>. It's an empty scaffold: it
            acknowledges each command and logs one line, but doesn't talk to the stations yet. Fork it and build
            the forwarding so all three stay in sync under chaos.
          </p>
          <pre><code>{STARTER_SNIPPET}</code></pre>
        </div>

        <div className="panel">
          <h2>Authentication</h2>
          <p className="muted">
            Sign in through PocketBase. Your team is derived from your token, never from a request body. When the
            Deep Space Network calls your relay it includes a Bearer token. Forward it unchanged to the ground station.
          </p>
          <pre><code>{AUTH_SNIPPET}</code></pre>
        </div>
      </div>

      <div className="panel">
        <h2>Chaos scenarios</h2>
        <p className="muted">The instructor can enable these against your team from the Admin tab.</p>
        <div className="grid cols-2">
          {SCENARIOS.map((s) => (
            <div className="scenario-card" key={s.title}>
              <h4>{s.title}</h4>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>{s.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h2>Good luck, commander</h2>
        <p className="muted">
          Start simple. Get a single command landing at all three stations. Then make it resilient: parallel writes,
          retries with backoff, respect for rate limits, and monotonic sequence numbers. Watch the Deep Space Network to
          see your three sources of truth converge. The stations are waiting.
        </p>
      </div>
    </div>
  );
}
