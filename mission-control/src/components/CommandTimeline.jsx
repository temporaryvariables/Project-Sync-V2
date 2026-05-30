import { useEffect, useMemo, useState, useCallback } from "react";
import { flightDirector } from "../api";

const STATIONS = ["nasa", "esa", "jaxa"];
const STATION_LABEL = { nasa: "N", esa: "E", jaxa: "J" };

const FINAL_LABEL = {
  full_match: "In sync",
  partial_match: "Partial",
  no_match: "No match",
  pending: "Pending",
};
const FINAL_CLASS = {
  full_match: "status-full",
  partial_match: "status-partial",
  no_match: "status-none",
  pending: "status-pending",
};

function httpColor(code) {
  if (code == null) return "#7e8db5";
  if (code >= 500) return "#f87171";
  if (code >= 400) return "#fbbf24";
  return "#34d399";
}

// Reduce one command's events into milestone timestamps (ms since it was sent).
function foldTimeline(events) {
  const sorted = events.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const relay = sorted.find((e) => e.step === "dsn.relay_transmit");
  const ml = sorted.find((e) => e.step === "dsn.missionlog_set");
  const anchor = relay || ml || sorted[0];
  if (!anchor) return null;
  const sentAt = new Date(anchor.ts).getTime();

  const relayResp =
    relay && relay.latency_ms != null
      ? { off: new Date(relay.ts).getTime() + relay.latency_ms - sentAt, status: relay.http_status, ok: relay.level === "success" }
      : null;

  // Any "station.*" event is a write attempt; keep the latest per station.
  const stations = {};
  for (const e of sorted) {
    if (!e.step || !e.step.startsWith("station.") || !e.station) continue;
    const at = new Date(e.ts).getTime() + (e.latency_ms || 0);
    stations[e.station] = {
      off: Math.max(0, at - sentAt),
      status: e.http_status,
      ok: e.step === "station.put",
      step: e.step,
    };
  }
  return { sentAt, relayResp, stations };
}

// A horizontal Gantt per command: bar starts when the command was sent and ends
// when the slowest source finished. Markers show the relay's response and each
// station write, color-coded by HTTP status, so you can read how a command
// fanned out and how long it took to reach (or fail to reach) sync.
export default function CommandTimeline({ records, onOpenTrace }) {
  const [byCid, setByCid] = useState({});

  const load = useCallback(async () => {
    try {
      const data = await flightDirector.logs({ limit: 600 });
      const groups = {};
      for (const ev of data.items || []) {
        if (!ev.correlation_id) continue;
        (groups[ev.correlation_id] ||= []).push(ev);
      }
      const folded = {};
      for (const [cid, evs] of Object.entries(groups)) {
        const t = foldTimeline(evs);
        if (t) folded[cid] = t;
      }
      setByCid(folded);
    } catch {
      // timeline is best-effort
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, records]);

  // Build rows by joining records (final state + selector) with folded traces.
  const rows = useMemo(() => {
    const out = [];
    for (const r of records || []) {
      const t = r.correlation_id ? byCid[r.correlation_id] : null;
      if (!t) continue;
      const offsets = [];
      if (t.relayResp) offsets.push(t.relayResp.off);
      for (const s of STATIONS) if (t.stations[s]) offsets.push(t.stations[s].off);
      const end = offsets.length ? Math.max(...offsets) : 0;
      out.push({
        id: r.id,
        selector: r.selector,
        correlationId: r.correlation_id,
        finalState: r.expected_status || "pending",
        relayResp: t.relayResp,
        stations: t.stations,
        end,
      });
    }
    return out.slice(0, 40);
  }, [records, byCid]);

  const maxEnd = useMemo(() => Math.max(1, ...rows.map((r) => r.end)), [rows]);
  const pct = (off) => `${Math.min(100, (off / maxEnd) * 100)}%`;

  if (!rows.length) {
    return (
      <div className="panel">
        <h2>Command lifecycle</h2>
        <p className="muted">
          No timelines yet. Start a scenario — each command will appear here as it fans out to the stations.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Command lifecycle</h2>
      <p className="muted" style={{ fontSize: 13 }}>
        Each bar is one command, starting when it was sent. ◆ is the relay's response; N / E / J are the
        NASA, ESA and JAXA writes, colored green (accepted), amber (rejected) or red (blackout). Bar length
        is total time to reach the final state on the right. Click a row to open its full trace.
      </p>

      <div className="gantt-axis">
        <span>0 ms</span>
        <span>{Math.round(maxEnd / 2)} ms</span>
        <span>{maxEnd} ms</span>
      </div>

      <div className="gantt">
        {rows.map((r) => (
          <div className="gantt-row" key={r.id} onClick={() => onOpenTrace?.(r.correlationId)} title="Open full trace">
            <div className="gantt-label">
              <code>{r.selector}</code>
            </div>
            <div className="gantt-track">
              {/* base bar from send to final source update */}
              <div
                className="gantt-bar"
                style={{
                  width: pct(r.end),
                  background:
                    r.finalState === "full_match"
                      ? "rgba(52,211,153,0.22)"
                      : r.finalState === "partial_match"
                      ? "rgba(251,191,36,0.20)"
                      : "rgba(248,113,113,0.20)",
                  borderColor:
                    r.finalState === "full_match"
                      ? "#34d399"
                      : r.finalState === "partial_match"
                      ? "#fbbf24"
                      : "#f87171",
                }}
              />
              {/* relay response marker */}
              {r.relayResp && (
                <span
                  className="gantt-diamond"
                  style={{ left: pct(r.relayResp.off), color: httpColor(r.relayResp.status) }}
                  title={`Relay responded ${r.relayResp.status ?? "?"} at +${Math.round(r.relayResp.off)} ms`}
                >
                  ◆
                </span>
              )}
              {/* station write markers */}
              {STATIONS.map((s) =>
                r.stations[s] ? (
                  <span
                    key={s}
                    className="gantt-station"
                    style={{ left: pct(r.stations[s].off), background: httpColor(r.stations[s].status) }}
                    title={`${s.toUpperCase()} ${r.stations[s].status ?? "?"} at +${Math.round(r.stations[s].off)} ms`}
                  >
                    {STATION_LABEL[s]}
                  </span>
                ) : null
              )}
            </div>
            <div className={`gantt-final ${FINAL_CLASS[r.finalState] || "status-pending"}`}>
              {FINAL_LABEL[r.finalState] || "Pending"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
