import { useEffect, useState, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  CartesianGrid,
} from "recharts";
import { flightDirector, deepSpaceNetwork } from "../api";
import { teamId } from "../pb";
import { useRelayUrl } from "../settings";

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const STATUS_COLORS = {
  full_match: "#34d399",
  partial_match: "#fbbf24",
  no_match: "#f87171",
  pending: "#7e8db5",
};

const STATUS_LABELS = {
  full_match: "In sync",
  partial_match: "Partial",
  no_match: "No match",
  pending: "Pending",
};

function StationCell({ value, expected }) {
  if (value === null || value === undefined) {
    return <td className="cell-empty">—</td>;
  }
  const match = value === expected;
  return <td className={match ? "cell-match" : "cell-mismatch"}>{value}</td>;
}

export default function DeepSpaceNetwork() {
  const myTeam = teamId();
  const relayUrl = useRelayUrl();

  // transmitter state
  const [scenarios, setScenarios] = useState([]);
  const [scenario, setScenario] = useState("");
  const [status, setStatus] = useState(null);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // dashboard state
  const [records, setRecords] = useState([]);
  const [summary, setSummary] = useState(null);
  const [latencies, setLatencies] = useState([]);

  useEffect(() => {
    deepSpaceNetwork
      .scenarios()
      .then((d) => {
        setScenarios(d.items);
        if (d.items[0]) setScenario(d.items[0].key);
      })
      .catch((e) => setError(e.message));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        deepSpaceNetwork.status(),
        deepSpaceNetwork.requests(50),
      ]);
      setStatus(s);
      setRequests(r.items.slice().reverse());
      setLatencies(
        r.items.map((req, i) => ({
          idx: i + 1,
          latency: req.latencyMs,
          time: new Date(req.ts).toLocaleTimeString(),
        }))
      );
    } catch (e) {
      // keep last known values
    }
    if (myTeam) {
      try {
        const data = await flightDirector.teamRecords(myTeam, 100);
        setRecords(data.items);
        setSummary(data.summary);
      } catch {
        // dashboard still works without record data
      }
    }
  }, [myTeam]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  async function start() {
    setError("");
    if (!relayUrl) {
      setError('No relay URL set. Click "⚙ Relay" in the top bar to set it.');
      return;
    }
    setBusy(true);
    // Clear everything for a clean slate so no data from a previous run lingers.
    setStatus(null);
    setRequests([]);
    setLatencies([]);
    setRecords([]);
    setSummary(null);
    try {
      // Wipe persisted command records for this team (keep chaos rules so the
      // configured scenario still applies), then start the new transmission.
      await flightDirector.reset({ keepChaos: true });
      await deepSpaceNetwork.start({ scenario, relayUrl });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await deepSpaceNetwork.stop();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const running = status?.running;
  const selected = scenarios.find((s) => s.key === scenario);

  const pieData = summary
    ? Object.entries(summary)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => ({ name: STATUS_LABELS[k] || k, value: v, key: k }))
    : [];

  return (
    <div>
      <div className="panel">
        <h2>Deep Space Network</h2>
        <p className="muted">
          Choose a scenario and start transmitting. The network sets each expected value in the mission log, then
          transmits the command to your relay (set with “⚙ Relay” in the top bar). Status refreshes every two seconds.
        </p>

        <div className="row">
          <div style={{ flex: "1 1 220px" }}>
            <label>Scenario</label>
            <select value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={running}>
              {scenarios.map((s) => (
                <option key={s.key} value={s.key}>{s.name}</option>
              ))}
            </select>
          </div>
          {running ? (
            <button className="btn danger" onClick={stop} disabled={busy}>Stop transmission</button>
          ) : (
            <button className="btn" onClick={start} disabled={busy || !scenario || !relayUrl}>Start transmission</button>
          )}
        </div>

        {!relayUrl && (
          <p className="muted" style={{ fontSize: 13 }}>
            No relay URL set. Click “⚙ Relay” in the top bar to set it.
          </p>
        )}
        {selected && <p className="muted" style={{ fontSize: 13 }}>{selected.description}</p>}
        {error && <div className="error-banner">{error}</div>}
      </div>

      <div className="panel">
        <h2>
          Live status{" "}
          <span className="pill" style={{ marginLeft: 8 }}>
            <span className={`dot ${running ? "on" : "off"}`} /> {running ? "Transmitting" : "Idle"}
          </span>
        </h2>
        <div className="grid cols-4">
          <div className="stat">
            <div className="value">{status ? fmtElapsed(status.elapsedMs) : "0m 0s"}</div>
            <div className="label">Elapsed</div>
          </div>
          <div className="stat">
            <div className="value">{status?.sent ?? 0}</div>
            <div className="label">Sent</div>
          </div>
          <div className="stat">
            <div className="value status-full">{status?.success ?? 0}</div>
            <div className="label">Success</div>
          </div>
          <div className="stat">
            <div className="value status-none">{status?.fail ?? 0}</div>
            <div className="label">Failed</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Request timeline</h2>
        {requests.length === 0 ? (
          <p className="muted">No transmissions yet. Start a scenario to see the timeline.</p>
        ) : (
          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Command</th>
                  <th>Payload</th>
                  <th>Latency</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r, i) => (
                  <tr key={i}>
                    <td className="muted">{new Date(r.ts).toLocaleTimeString()}</td>
                    <td><code>{r.selector}</code></td>
                    <td>{r.payload}</td>
                    <td>{r.latencyMs} ms</td>
                    <td className={r.ok ? "status-full" : "status-none"}>
                      {r.status || "—"} {r.error ? `(${r.error})` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid cols-2">
        <div className="panel">
          <h2>Response times</h2>
          {latencies.length === 0 ? (
            <p className="muted">No request data yet. Start a scenario above.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={latencies}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2c5a" />
                <XAxis dataKey="idx" stroke="#7e8db5" fontSize={11} />
                <YAxis stroke="#7e8db5" fontSize={11} unit="ms" />
                <Tooltip
                  contentStyle={{ background: "#0e1838", border: "1px solid #1e2c5a", borderRadius: 8 }}
                  labelFormatter={(l) => `Request ${l}`}
                />
                <Line type="monotone" dataKey="latency" stroke="#38bdf8" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="panel">
          <h2>Synchronization status</h2>
          {pieData.length === 0 ? (
            <p className="muted">No commands recorded yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                  {pieData.map((entry) => (
                    <Cell key={entry.key} fill={STATUS_COLORS[entry.key] || "#6366f1"} />
                  ))}
                </Pie>
                <Legend />
                <Tooltip
                  contentStyle={{ background: "#0e1838", border: "1px solid #1e2c5a", borderRadius: 8 }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Commands</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Each row shows the expected value from the mission log and what landed at each station.
        </p>
        {records.length === 0 ? (
          <p className="muted">No commands yet.</p>
        ) : (
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Command</th>
                  <th>Expected</th>
                  <th>NASA</th>
                  <th>ESA</th>
                  <th>JAXA</th>
                  <th>Seq</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td><code>{r.selector}</code></td>
                    <td>{r.expected_payload ?? <span className="cell-empty">—</span>}</td>
                    <StationCell value={r.nasa_payload} expected={r.expected_payload} />
                    <StationCell value={r.esa_payload} expected={r.expected_payload} />
                    <StationCell value={r.jaxa_payload} expected={r.expected_payload} />
                    <td className="muted">{r.sequence_number ?? "—"}</td>
                    <td>
                      <span
                        className={
                          r.expected_status === "full_match"
                            ? "status-full"
                            : r.expected_status === "partial_match"
                            ? "status-partial"
                            : r.expected_status === "no_match"
                            ? "status-none"
                            : "status-pending"
                        }
                      >
                        {STATUS_LABELS[r.expected_status] || "Pending"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
