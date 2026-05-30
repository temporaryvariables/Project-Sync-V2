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
  return "trace-info";
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

        <ol className="trace-list">
          {items.map((ev) => {
            const offset = t0 ? new Date(ev.ts).getTime() - t0 : 0;
            return (
              <li key={ev.id} className={`trace-item ${levelClass(ev.level)}`}>
                <div className="trace-item-head">
                  <span className="trace-service">{SERVICE_LABELS[ev.service] || ev.service}</span>
                  <span className="trace-step">{ev.step}</span>
                  {ev.station && <span className="trace-station">{ev.station.toUpperCase()}</span>}
                  <span className="trace-time muted">+{offset} ms</span>
                  {ev.http_status != null && (
                    <span className={`trace-status ${ev.http_status >= 500 ? "status-none" : ev.http_status >= 400 ? "status-partial" : "status-full"}`}>
                      {ev.http_status}
                    </span>
                  )}
                  {ev.latency_ms != null && <span className="trace-latency muted">{ev.latency_ms} ms</span>}
                </div>
                {ev.message && <div className="trace-message">{ev.message}</div>}
                {ev.meta && Object.keys(ev.meta).length > 0 && (
                  <code className="trace-meta">{JSON.stringify(ev.meta)}</code>
                )}
              </li>
            );
          })}
        </ol>
      </aside>
    </div>
  );
}
