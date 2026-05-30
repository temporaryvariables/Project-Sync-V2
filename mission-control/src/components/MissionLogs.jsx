import { useEffect, useState, useCallback } from "react";
import { flightDirector } from "../api";

const SERVICE_LABELS = {
  "deep-space-network": "DSN",
  "ground-station-api": "Ground",
  "rover-relay": "Relay",
  "rover-relay-starter": "Relay",
};

const LEVELS = ["all", "info", "success", "warn", "error"];

function levelBadge(level) {
  if (level === "error") return "log-badge log-error";
  if (level === "warn") return "log-badge log-warn";
  if (level === "success") return "log-badge log-success";
  return "log-badge log-info";
}

function fmtTime(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour12: false });
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${time}.${ms}`;
}

// Renders meta as compact "key: value" chips, skipping empty objects.
function Properties({ meta, station, httpStatus, latencyMs }) {
  const entries = [];
  if (station) entries.push(["station", station.toUpperCase()]);
  if (httpStatus != null) entries.push(["http", httpStatus]);
  if (latencyMs != null) entries.push(["latency", `${latencyMs} ms`]);
  if (meta && typeof meta === "object") {
    for (const [k, v] of Object.entries(meta)) {
      if (v === null || v === undefined || v === "") continue;
      entries.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
    }
  }
  if (entries.length === 0) return <span className="muted">—</span>;
  return (
    <div className="log-props">
      {entries.map(([k, v]) => (
        <span className="log-prop" key={k}>
          <span className="log-prop-k">{k}</span>
          <span className="log-prop-v">{String(v)}</span>
        </span>
      ))}
    </div>
  );
}

export default function MissionLogs({ onOpenTrace }) {
  const [items, setItems] = useState([]);
  const [level, setLevel] = useState("all");
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const opts = { limit: 200 };
      if (level !== "all") opts.level = level;
      const data = await flightDirector.logs(opts);
      // API returns newest first; show oldest first so it reads like a story.
      setItems((data.items || []).slice().reverse());
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [level]);

  useEffect(() => {
    load();
    if (paused) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [load, paused]);

  return (
    <div className="panel">
      <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>Mission logs</h2>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Every step of every command, in the order it happened. Click a correlation id to
            follow one command end to end.
          </p>
        </div>
        <div className="row" style={{ gap: 8, flex: "0 0 auto" }}>
          <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ width: "auto" }}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l === "all" ? "All types" : l}</option>
            ))}
          </select>
          <button className="btn ghost sm" onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button className="btn ghost sm" onClick={load}>Refresh</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {items.length === 0 ? (
        <p className="muted">No logs yet. Start a transmission to watch the story unfold.</p>
      ) : (
        <div style={{ maxHeight: 480, overflowY: "auto" }}>
          <table className="log-table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Time</th>
                <th style={{ width: 90 }}>Type</th>
                <th>Message</th>
                <th style={{ width: 260 }}>Properties</th>
                <th style={{ width: 150 }}>Correlation</th>
              </tr>
            </thead>
            <tbody>
              {items.map((ev) => (
                <tr key={ev.id}>
                  <td className="muted log-time">{fmtTime(ev.ts)}</td>
                  <td>
                    <span className={levelBadge(ev.level)}>{ev.level}</span>
                  </td>
                  <td className="log-msg">
                    <span className="log-source">{SERVICE_LABELS[ev.service] || ev.service}</span>
                    {ev.message || <span className="muted">{ev.step}</span>}
                  </td>
                  <td>
                    <Properties
                      meta={ev.meta}
                      station={ev.station}
                      httpStatus={ev.http_status}
                      latencyMs={ev.latency_ms}
                    />
                  </td>
                  <td>
                    {ev.correlation_id ? (
                      <button
                        className="link-btn"
                        title="Open full trace"
                        onClick={() => onOpenTrace?.(ev.correlation_id)}
                      >
                        {ev.correlation_id}
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
