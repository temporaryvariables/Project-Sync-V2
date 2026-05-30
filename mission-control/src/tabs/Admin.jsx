import { useEffect, useState, useCallback } from "react";
import { flightDirector } from "../api";

const MODES = [
  { key: "blackout", label: "Station Blackout", hint: "Returns HTTP 500 on every request." },
  { key: "throttle", label: "Bandwidth Throttle", hint: "HTTP 429 over the rate limit." },
  { key: "signal_delay", label: "Signal Delay", hint: "Adds 2 to 5s of latency." },
  { key: "incorrect_ordering", label: "Incorrect Ordering", hint: "Rejects stale sequence numbers." },
  { key: "relay_timeout", label: "Relay Timeout", hint: "Mission Control gives up if the relay takes longer than timeout_ms to respond. Applies to the relay, not a station." },
];

const STATIONS = ["all", "nasa", "esa", "jaxa"];

function defaultConfig(mode) {
  switch (mode) {
    case "throttle":
      return { requests_per_second: 2, retry_after_ms: 1000 };
    case "signal_delay":
      return { min_ms: 2000, max_ms: 5000 };
    case "relay_timeout":
      return { timeout_ms: 3000 };
    default:
      return {};
  }
}

export default function Admin() {
  const [tables, setTables] = useState(null);
  const [rules, setRules] = useState([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // new rule form
  const [station, setStation] = useState("all");
  const [mode, setMode] = useState("blackout");
  const [configText, setConfigText] = useState("{}");

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([flightDirector.tables(), flightDirector.listChaos()]);
      setTables(t);
      setRules(c.items);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setConfigText(JSON.stringify(defaultConfig(mode), null, 2));
  }, [mode]);

  function flash(msg) {
    setInfo(msg);
    setError("");
    setTimeout(() => setInfo(""), 4000);
  }

  async function doReset() {
    if (!confirm("Reset wipes all your team's commands and chaos rules. Continue?")) return;
    try {
      const r = await flightDirector.reset();
      flash(`Reset complete. Removed ${r.records_deleted} records and ${r.chaos_rules_deleted} rules.`);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function addRule() {
    setError("");
    let config;
    try {
      config = JSON.parse(configText || "{}");
    } catch {
      setError("Config must be valid JSON.");
      return;
    }
    try {
      await flightDirector.createChaos({ station, mode, config, enabled: true });
      flash("Chaos rule created.");
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function toggleRule(rule) {
    try {
      await flightDirector.updateChaos(rule.id, { enabled: !rule.enabled });
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeRule(id) {
    try {
      await flightDirector.deleteChaos(id);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {info && <div className="info-banner">{info}</div>}

      <div className="panel">
        <h2>Database</h2>
        <p className="muted">Live counts for your team. Reset clears everything your team owns.</p>
        {tables ? (
          <div className="grid cols-3" style={{ marginBottom: 16 }}>
            <div className="stat">
              <div className="value">{tables.replication_records.total}</div>
              <div className="label">Commands</div>
            </div>
            <div className="stat">
              <div className="value status-full">{tables.replication_records.full_match}</div>
              <div className="label">In sync</div>
            </div>
            <div className="stat">
              <div className="value status-none">{tables.replication_records.no_match}</div>
              <div className="label">No match</div>
            </div>
          </div>
        ) : (
          <p className="muted">Loading...</p>
        )}
        <button className="btn danger" onClick={doReset}>Reset team database</button>
      </div>

      <div className="panel">
        <h2>Chaos rules</h2>
        <p className="muted">Enable scenarios against your team. Rules apply to ground station endpoints only.</p>

        <div className="row" style={{ alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 160px" }}>
            <label>Station</label>
            <select value={station} onChange={(e) => setStation(e.target.value)}>
              {STATIONS.map((s) => (
                <option key={s} value={s}>{s.toUpperCase()}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: "1 1 200px" }}>
            <label>Mode</label>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              {MODES.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: "1 1 220px" }}>
            <label>Config (JSON)</label>
            <textarea rows={3} value={configText} onChange={(e) => setConfigText(e.target.value)} />
          </div>
          <button className="btn" onClick={addRule}>Add rule</button>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>{MODES.find((m) => m.key === mode)?.hint}</p>

        {rules.length === 0 ? (
          <p className="muted">No chaos rules active. Conditions are perfect.</p>
        ) : (
          <table style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Station</th>
                <th>Mode</th>
                <th>Config</th>
                <th>Scope</th>
                <th>Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.station.toUpperCase()}</td>
                  <td>{MODES.find((m) => m.key === r.mode)?.label || r.mode}</td>
                  <td><code style={{ fontSize: 11 }}>{JSON.stringify(r.config)}</code></td>
                  <td className="muted">{r.team_id ? "team" : "global"}</td>
                  <td>
                    <span className="pill">
                      <span className={`dot ${r.enabled ? "on" : "off"}`} />
                      {r.enabled ? "On" : "Off"}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn ghost sm" onClick={() => toggleRule(r)}>
                        {r.enabled ? "Disable" : "Enable"}
                      </button>
                      <button className="btn danger sm" onClick={() => removeRule(r.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
