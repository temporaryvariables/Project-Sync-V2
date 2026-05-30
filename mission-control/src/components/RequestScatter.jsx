import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

const OK_COLOR = "#34d399";
const FAIL_COLOR = "#f87171";

function CustomTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
  return (
    <div className="scatter-tip">
      <div className="scatter-tip-head">
        <code>{d.selector}</code>
        <span className={d.ok ? "status-full" : "status-none"}>
          {d.ok ? "delivered" : "failed"}
        </span>
      </div>
      <div className="scatter-tip-row"><span>Payload</span><b>{d.payload}</b></div>
      <div className="scatter-tip-row"><span>Sent</span><b>{d.timeLabel}</b></div>
      <div className="scatter-tip-row"><span>Latency</span><b>{d.latency} ms</b></div>
      <div className="scatter-tip-row"><span>Status</span><b>{d.status || "—"}</b></div>
      {d.error && <div className="scatter-tip-row"><span>Error</span><b>{d.error}</b></div>}
    </div>
  );
}

// A dot per transmission, plotted by send time (X) and latency (Y). Clusters
// reveal the scenario's shape: tight columns = bursts, a rising band = ramp up,
// even spacing = steady. Hover any dot for the full request detail.
export default function RequestScatter({ requests }) {
  const data = (requests || [])
    .map((r) => {
      const t = new Date(r.ts).getTime();
      return {
        t,
        latency: r.latencyMs ?? 0,
        selector: r.selector,
        payload: r.payload,
        status: r.status,
        ok: r.ok,
        error: r.error,
        timeLabel: new Date(r.ts).toLocaleTimeString(),
      };
    })
    .sort((a, b) => a.t - b.t);

  return (
    <div className="panel">
      <h2>Requests over time</h2>
      <p className="muted" style={{ fontSize: 13 }}>
        One dot per transmission, placed by when it was sent and how long it took.
        The pattern tells you the scenario — bursts cluster, ramps climb, steady spreads evenly.
        Green is delivered, red failed. Hover a dot for details.
      </p>
      {data.length === 0 ? (
        <p className="muted">No transmissions yet. Start a scenario to see the pattern.</p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e2c5a" />
            <XAxis
              type="number"
              dataKey="t"
              domain={["dataMin", "dataMax"]}
              stroke="#7e8db5"
              fontSize={11}
              tickFormatter={(t) => new Date(t).toLocaleTimeString()}
            />
            <YAxis
              type="number"
              dataKey="latency"
              stroke="#7e8db5"
              fontSize={11}
              unit="ms"
            />
            <ZAxis type="number" range={[60, 60]} />
            <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: "3 3" }} />
            <Scatter data={data}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.ok ? OK_COLOR : FAIL_COLOR} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
