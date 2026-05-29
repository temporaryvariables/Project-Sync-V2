import { useEffect, useState, useCallback } from "react";
import { deepSpaceNetwork } from "../api";

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export default function DeepSpaceNetwork() {
  const [scenarios, setScenarios] = useState([]);
  const [scenario, setScenario] = useState("");
  const [relayUrl, setRelayUrl] = useState("http://localhost:4000");
  const [status, setStatus] = useState(null);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
    } catch (e) {
      // keep last known values
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  async function start() {
    setError("");
    setBusy(true);
    try {
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

  return (
    <div>
      <div className="panel">
        <h2>Deep Space Network</h2>
        <p className="muted">
          Point the transmitter at your relay URL and choose a scenario. The network sets each expected value in the
          mission log, then transmits the command to your relay. Status refreshes every two seconds.
        </p>

        <div className="row">
          <div style={{ flex: "1 1 280px" }}>
            <label>Relay URL</label>
            <input
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              placeholder="https://your-relay.example.com"
              disabled={running}
            />
          </div>
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
            <button className="btn" onClick={start} disabled={busy || !scenario}>Start transmission</button>
          )}
        </div>

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
    </div>
  );
}
