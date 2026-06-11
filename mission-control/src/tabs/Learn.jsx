import { useState, useEffect, useRef, useCallback } from "react";
import { crew } from "../api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const COLORS = ["#38bdf8", "#6366f1", "#22d3ee", "#34d399", "#fbbf24", "#f87171", "#a78bfa", "#fb923c", "#e879f9", "#94a3b8"];

function statusColor(s) {
  if (s >= 200 && s < 300) return "var(--green)";
  if (s >= 400 && s < 500) return "var(--amber)";
  return "var(--red)";
}

function chaosIcon(name) {
  const n = (name || "").toLowerCase();
  if (n.startsWith("blackout")) return "🕳️";
  if (n.includes("throttle")) return "⚡";
  if (n.startsWith("delay")) return "🐌";
  return null;
}

// ---------------------------------------------------------------------------
// Response panel — shows the raw HTTP result of the last action
// ---------------------------------------------------------------------------
function ResponsePanel({ res }) {
  if (!res) return null;
  return (
    <div className="crew-response">
      <div className="crew-response-meta">
        <span className="crew-status" style={{ color: statusColor(res.status) }}>
          {res.status} {res.statusText}
        </span>
        <span className="muted" style={{ fontFamily: "monospace", fontSize: 13 }}>
          {res.method || ""}
        </span>
      </div>
      <pre className="crew-json">
        <code>{typeof res.body === "object" ? JSON.stringify(res.body, null, 2) : String(res.body || "")}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ship visualization
// ---------------------------------------------------------------------------
function Ship({ members }) {
  // 10 seats arranged in 2 rows of 5
  const seats = Array.from({ length: 10 }, (_, i) => members[i] || null);

  return (
    <div className="ship-wrapper">
      <div className="ship">
        <div className="ship-nose" />
        <div className="ship-body">
          <div className="ship-window-row" style={{ marginBottom: 10 }}>
            {seats.slice(0, 5).map((m, i) => (
              <div key={i} className={`ship-seat ${m ? "occupied" : ""}`}>
                <div className={`seat-avatar ${!m ? "empty-avatar" : ""}`}
                  style={m ? { background: m.color } : {}}
                  title={m ? `${m.name} (v${m.version})` : "Empty seat"}>
                  {m ? (chaosIcon(m.name) || m.name[0].toUpperCase()) : "·"}
                </div>
                <span className="seat-name">{m ? m.name : ""}</span>
              </div>
            ))}
          </div>
          <div className="ship-window-row">
            {seats.slice(5, 10).map((m, i) => (
              <div key={i + 5} className={`ship-seat ${m ? "occupied" : ""}`}>
                <div className={`seat-avatar ${!m ? "empty-avatar" : ""}`}
                  style={m ? { background: m.color } : {}}
                  title={m ? `${m.name} (v${m.version})` : "Empty seat"}>
                  {m ? (chaosIcon(m.name) || m.name[0].toUpperCase()) : "·"}
                </div>
                <span className="seat-name">{m ? m.name : ""}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="ship-engines">
          <div className="engine-flame" />
          <div className="engine-flame" style={{ animationDelay: "0.15s" }} />
          <div className="engine-flame" style={{ animationDelay: "0.3s" }} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline edit row
// ---------------------------------------------------------------------------
function EditRow({ member, onSave, onCancel, busy }) {
  const [name, setName] = useState(member.name);
  const [color, setColor] = useState(member.color);

  return (
    <tr>
      <td>
        <input className="crew-input sm" value={name} onChange={(e) => setName(e.target.value)}
          maxLength={12} style={{ width: 100 }} />
      </td>
      <td>
        <input type="color" className="crew-color" value={color} onChange={(e) => setColor(e.target.value)}
          style={{ width: 28, height: 28 }} />
      </td>
      <td>v{member.version}</td>
      <td>
        <div className="crew-row-btns">
          <button className="btn sm" onClick={() => onSave(member.id, { name: name !== member.name ? name : undefined, color: color !== member.color ? color : undefined, version: member.version })} disabled={busy}>Save</button>
          <button className="btn ghost sm" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main Learn component
// ---------------------------------------------------------------------------
export default function Learn() {
  const [members, setMembers] = useState([]);
  const [lastRes, setLastRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refreshMs, setRefreshMs] = useState(0);
  const [editingId, setEditingId] = useState(null);

  // Add form state
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(COLORS[Math.floor(Math.random() * COLORS.length)]);

  const intervalRef = useRef(null);

  // Fetch crew list
  const fetchCrew = useCallback(async (showResponse) => {
    const r = await crew.list();
    if (showResponse) setLastRes({ ...r, method: "GET /crew" });
    if (r.status >= 200 && r.status < 300 && r.body?.items) {
      setMembers(r.body.items);
    }
    return r;
  }, []);

  // Initial load
  useEffect(() => { fetchCrew(false); }, [fetchCrew]);

  // Auto-refresh
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (refreshMs > 0) {
      intervalRef.current = setInterval(() => fetchCrew(false), refreshMs);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [refreshMs, fetchCrew]);

  // --- Actions ---
  const handleAdd = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    const r = await crew.create({ name: newName.trim(), color: newColor });
    setLastRes({ ...r, method: "PUT /crew" });
    await fetchCrew(false);
    if (r.status >= 200 && r.status < 300) {
      setNewName("");
      setNewColor(COLORS[Math.floor(Math.random() * COLORS.length)]);
    }
    setBusy(false);
  };

  const handleDelete = async (id) => {
    setBusy(true);
    const r = await crew.remove(id);
    setLastRes({ ...r, method: `DELETE /crew/${id}` });
    await fetchCrew(false);
    setBusy(false);
  };

  const handleUpdate = async (id, body) => {
    setBusy(true);
    const r = await crew.update(id, body);
    setLastRes({ ...r, method: `PATCH /crew/${id}` });
    await fetchCrew(false);
    setEditingId(null);
    setBusy(false);
  };

  const handleGet = async (id) => {
    setBusy(true);
    const r = await crew.get(id);
    setLastRes({ ...r, method: `GET /crew/${id}` });
    setBusy(false);
  };

  const handleClearAll = async () => {
    setBusy(true);
    const r = await crew.clear();
    setLastRes({ ...r, method: "DELETE /crew" });
    await fetchCrew(false);
    setBusy(false);
  };

  const handleRefresh = async () => {
    setBusy(true);
    await fetchCrew(true);
    setBusy(false);
  };

  return (
    <div>
      {/* --- Spaceship --- */}
      <div className="panel">
        <h2>Spaceship Crew</h2>
        <p className="muted">
          A shared roster visible to everyone. Add crew members, update them, and watch
          the ship fill up in real time. Try special names to trigger chaos:{" "}
          <span className="inline-code">blackout*</span> → 500,{" "}
          <span className="inline-code">throttle*</span> → 429,{" "}
          <span className="inline-code">delay&lt;N&gt;</span> → artificial latency (5s+ times out with 504).
        </p>
        <Ship members={members} />
      </div>

      {/* --- Controls --- */}
      <div className="panel">
        <div className="crew-controls">
          <div className="crew-controls-left">
            <strong>{members.length} / 10 crew</strong>
            <div className="crew-refresh">
              <label className="muted" style={{ fontSize: 12 }}>Auto-refresh:</label>
              <select value={refreshMs} onChange={(e) => setRefreshMs(Number(e.target.value))}
                style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
                <option value={0}>Off</option>
                <option value={1000}>1s</option>
                <option value={2000}>2s</option>
                <option value={5000}>5s</option>
              </select>
            </div>
            <button className="btn ghost sm" onClick={handleRefresh} disabled={busy}>Refresh</button>
          </div>
          <button className="btn danger sm" onClick={handleClearAll} disabled={busy}>Clear all</button>
        </div>

        {/* Add form */}
        <div className="crew-add-form">
          <input className="crew-input" value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="Callsign (a-z, 0-9, max 12)" maxLength={12}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()} />
          <input type="color" className="crew-color" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
          <button className="btn" onClick={handleAdd} disabled={busy || !newName.trim()}>Add member</button>
        </div>

        {/* Crew table */}
        {members.length > 0 && (
          <table className="crew-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Color</th>
                <th>Version</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) =>
                editingId === m.id ? (
                  <EditRow key={m.id} member={m} onSave={handleUpdate}
                    onCancel={() => setEditingId(null)} busy={busy} />
                ) : (
                  <tr key={m.id}>
                    <td>
                      <div className="crew-name-cell">
                        <span className="crew-dot" style={{ background: m.color }} />
                        {chaosIcon(m.name) && <span>{chaosIcon(m.name)}</span>}
                        {m.name}
                      </div>
                    </td>
                    <td><span className="crew-color-swatch" style={{ background: m.color }} /></td>
                    <td>v{m.version}</td>
                    <td>
                      <div className="crew-row-btns">
                        <button className="btn ghost sm" onClick={() => handleGet(m.id)} disabled={busy}>GET</button>
                        <button className="btn ghost sm" onClick={() => setEditingId(m.id)} disabled={busy}>Edit</button>
                        <button className="btn ghost sm" onClick={() => handleDelete(m.id)} disabled={busy}>✕</button>
                      </div>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* --- Response panel --- */}
      <div className="panel">
        <h2>Last Response</h2>
        <p className="muted">The raw HTTP response from the last action you performed.</p>
        <ResponsePanel res={lastRes} />
        {!lastRes && <p className="muted" style={{ fontStyle: "italic" }}>No requests yet — add a crew member to get started.</p>}
      </div>

      {/* --- Chaos legend --- */}
      <div className="panel">
        <h2>Chaos Names</h2>
        <p className="muted">Name a crew member with one of these prefixes to trigger a chaos scenario.</p>
        <table className="crew-table" style={{ maxWidth: 600 }}>
          <thead>
            <tr><th>Prefix</th><th>Effect</th><th>Status</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="inline-code">blackout*</span> 🕳️</td>
              <td className="muted">Member is never created — lost in deep space</td>
              <td><span className="crew-status" style={{ color: "var(--red)" }}>500</span></td>
            </tr>
            <tr>
              <td><span className="inline-code">throttle*</span> ⚡</td>
              <td className="muted">Only 1 throttle member per 5 seconds</td>
              <td><span className="crew-status" style={{ color: "var(--amber)" }}>429</span></td>
            </tr>
            <tr>
              <td><span className="inline-code">delay&lt;N&gt;</span> 🐌</td>
              <td className="muted">Delays by N seconds; 5+ times out</td>
              <td><span className="crew-status" style={{ color: "var(--red)" }}>504</span></td>
            </tr>
            <tr>
              <td><em>duplicate name</em></td>
              <td className="muted">Two members can't share a name</td>
              <td><span className="crew-status" style={{ color: "var(--amber)" }}>409</span></td>
            </tr>
            <tr>
              <td><em>stale version</em></td>
              <td className="muted">PATCH with wrong version → conflict</td>
              <td><span className="crew-status" style={{ color: "var(--amber)" }}>409</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}