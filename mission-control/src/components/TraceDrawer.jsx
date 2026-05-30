import { useEffect, useState, useCallback } from "react";
import { flightDirector } from "../api";

const SERVICE_LABELS = {
  "deep-space-network": "DSN",
  "ground-station-api": "Ground",
  "rover-relay": "Relay",
  "rover-relay-starter": "Relay",
};

function levelClass(level) {
  if (level === "error") return "trace-error";
  if (level === "warn") return "trace-warn";
  if (level === "success") return "trace-success";
  return "trace-info";
}

function levelBadge(level) {
  if (level === "error") return "log-badge log-error";
  if (level === "warn") return "log-badge log-warn";
  if (level === "success") return "log-badge log-success";
  return "log-badge log-info";
}

// Compact "key: value" chips for the Properties column, including the common
// fields that live outside meta (station / http / latency).
function traceProps(ev) {
  const entries = [];
  if (ev.station) entries.push(["station", ev.station.toUpperCase()]);
  if (ev.http_status != null) entries.push(["http", ev.http_status]);
  if (ev.latency_ms != null) entries.push(["latency", `${ev.latency_ms} ms`]);
  if (ev.meta && typeof ev.meta === "object") {
    for (const [k, v] of Object.entries(ev.meta)) {
      if (v === null || v === undefined || v === "") continue;
      entries.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
    }
  }
  return entries;
}

export default function TraceDrawer({ correlationId, onClose }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!correlationId) return;
    setLoading(true);
    setError("");
    try {
      const data = await flightDirector.trace(correlationId);
      setItems(data.items || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [correlationId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const t0 = items.length ? new Date(items[0].ts).getTime() : 0;

  return (
    <div className="trace-overlay" onMouseDown={onClose}>
      <aside className="trace-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="trace-head">
          <div>
            <h3 style={{ margin: 0 }}>Command trace</h3>
            <code className="muted" style={{ fontSize: 12 }}>{correlationId}</code>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn ghost sm" onClick={load}>Refresh</button>
            <button className="btn ghost sm" onClick={onClose}>Close</button>
          </div>
        </div>

        {loading && <p className="muted">Loading trace...</p>}
        {error && <div className="error-banner">{error}</div>}
        {!loading && !error && items.length === 0 && (
          <p className="muted">
            No log events for this command yet. Traces appear a moment after the command runs.
          </p>
        )}

        {!loading && !error && items.length > 0 && (
          <div className="trace-table-wrap">
            <table className="log-table trace-table">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>+ms</th>
                  <th style={{ width: 78 }}>Type</th>
                  <th style={{ width: 66 }}>Source</th>
                  <th style={{ width: 120 }}>Step</th>
                  <th>Message</th>
                  <th style={{ width: 200 }}>Properties</th>
                </tr>
              </thead>
              <tbody>
                {items.map((ev) => {
                  const offset = t0 ? new Date(ev.ts).getTime() - t0 : 0;
                  const props = traceProps(ev);
                  return (
                    <tr key={ev.id} className={levelClass(ev.level)}>
                      <td className="muted log-time">+{offset}</td>
                      <td><span className={levelBadge(ev.level)}>{ev.level}</span></td>
                      <td><span className="log-source">{SERVICE_LABELS[ev.service] || ev.service}</span></td>
                      <td className="trace-step-cell">{ev.step}</td>
                      <td className="log-msg">{ev.message || <span className="muted">—</span>}</td>
                      <td>
                        {props.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          <div className="log-props">
                            {props.map(([k, v]) => (
                              <span className="log-prop" key={k}>
                                <span className="log-prop-k">{k}</span>
                                <span className="log-prop-v">{String(v)}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </aside>
    </div>
  );
}
