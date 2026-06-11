import { useState, useEffect, useRef, useCallback } from "react";
import { crew } from "../api";
import { role as getRole, currentUser } from "../pb";

const COLORS = ["#38bdf8","#6366f1","#22d3ee","#34d399","#fbbf24","#f87171","#a78bfa","#fb923c","#e879f9","#94a3b8"];
const TOTAL_SEATS = 21;

function statusColor(s) {
  if (s >= 200 && s < 300) return "var(--green)";
  if (s >= 400 && s < 500) return "var(--amber)";
  return "var(--red)";
}

function chaosIcon(name) {
  const n = (name || "").toLowerCase();
  if (n.startsWith("blackout")) return "\u{1F573}\u{FE0F}";
  if (n.includes("throttle")) return "\u26A1";
  if (n.startsWith("delay")) return "\u{1F40C}";
  return null;
}

function ResponsePanel({ res }) {
  if (!res) return null;
  return (
    <div className="crew-response">
      <div className="crew-response-meta">
        <span className="crew-status" style={{ color: statusColor(res.status) }}>
          {res.status} {res.statusText}
        </span>
        <span className="muted" style={{ fontFamily: "monospace", fontSize: 13 }}>{res.method || ""}</span>
      </div>
      <pre className="crew-json"><code>{typeof res.body === "object" ? JSON.stringify(res.body, null, 2) : String(res.body || "")}</code></pre>
    </div>
  );
}

function SeatPopover({ seatIdx, member, onClose, onAdd, onUpdate, onDelete, busy, myId, myRole }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[Math.floor(Math.random() * COLORS.length)]);
  const [editColor, setEditColor] = useState(member?.color || "#38bdf8");
  const [message, setMessage] = useState(member?.message || "");
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const isOwner = member && (member.created_by === myId || myRole === "admin");

  if (!member) {
    return (
      <div className="seat-popover" ref={ref}>
        <div className="seat-popover-title">Seat {seatIdx}{seatIdx === 0 ? " (Pilot)" : ""}</div>
        <input className="crew-input sm" placeholder="Name" value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && onAdd(seatIdx, name, color, message)} />
        <input className="crew-input sm" placeholder="Message (optional)" value={message}
          onChange={(e) => setMessage(e.target.value)} style={{ marginTop: 4 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
          <input type="color" className="crew-color" value={color} onChange={(e) => setColor(e.target.value)}
            style={{ width: 24, height: 24 }} />
          <button className="btn sm" disabled={busy || !name.trim()}
            onClick={() => onAdd(seatIdx, name, color, message)}>Add</button>
        </div>
      </div>
    );
  }

  return (
    <div className="seat-popover" ref={ref}>
      <div className="seat-popover-title">{member.name} <span className="muted">v{member.version}</span></div>
      {isOwner ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label className="muted" style={{ fontSize: 11 }}>Color</label>
            <input type="color" className="crew-color" value={editColor}
              onChange={(e) => setEditColor(e.target.value)} style={{ width: 24, height: 24 }} />
            <button className="btn sm" disabled={busy}
              onClick={() => onUpdate(member.id, { color: editColor, version: member.version })}>
              Save color
            </button>
          </div>
          <div style={{ marginTop: 6 }}>
            <label className="muted" style={{ fontSize: 11 }}>Message</label>
            <div style={{ display: "flex", gap: 4 }}>
              <input className="crew-input sm" value={message} onChange={(e) => setMessage(e.target.value)}
                placeholder="Say something..." style={{ flex: 1 }}
                onKeyDown={(e) => e.key === "Enter" && onUpdate(member.id, { message, version: member.version })} />
              <button className="btn sm" disabled={busy}
                onClick={() => onUpdate(member.id, { message, version: member.version })}>Set</button>
            </div>
          </div>
          <button className="btn danger sm" style={{ marginTop: 8, width: "100%" }} disabled={busy}
            onClick={() => onDelete(member.id)}>Remove</button>
        </>
      ) : (
        <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
          Created by another user. Only the owner or an admin can edit this member.
        </p>
      )}
    </div>
  );
}

function Seat({ seatIdx, member, onSelect, isPilot }) {
  return (
    <div className={"ship-seat" + (member ? " occupied" : "") + (isPilot ? " pilot" : "")}
      onClick={() => onSelect(seatIdx)}>
      {member?.message && (
        <div className="seat-bubble">{member.message}</div>
      )}
      <div className={"seat-avatar" + (!member ? " empty-avatar" : "") + (isPilot ? " pilot-avatar" : "")}
        style={member ? { background: member.color } : {}}
        title={member ? member.name + " (v" + member.version + ")" : isPilot ? "Pilot seat (admin only)" : "Empty seat"}>
        {member ? (chaosIcon(member.name) || member.name[0].toUpperCase()) : isPilot ? "\u2605" : "\u00B7"}
      </div>
      <span className="seat-name">{member ? member.name : isPilot ? "Pilot" : ""}</span>
    </div>
  );
}

export default function Learn() {
  const [members, setMembers] = useState([]);
  const [lastRes, setLastRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refreshMs, setRefreshMs] = useState(0);
  const [selectedSeat, setSelectedSeat] = useState(null);
  const intervalRef = useRef(null);

  const myRole = getRole();
  const user = currentUser();
  const myId = user?.id || "dev-user";

  const seatMap = {};
  members.forEach((m) => { seatMap[m.seat] = m; });

  const fetchCrew = useCallback(async (showResponse) => {
    const r = await crew.list();
    if (showResponse) setLastRes({ ...r, method: "GET /crew" });
    if (r.status >= 200 && r.status < 300 && r.body?.items) {
      setMembers(r.body.items);
    }
    return r;
  }, []);

  useEffect(() => { fetchCrew(false); }, [fetchCrew]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (refreshMs > 0) intervalRef.current = setInterval(() => fetchCrew(false), refreshMs);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [refreshMs, fetchCrew]);

  const handleAdd = async (seat, name, color, message) => {
    setBusy(true);
    const body = { name, color, seat };
    if (message) body.message = message;
    const r = await crew.create(body);
    setLastRes({ ...r, method: "PUT /crew" });
    await fetchCrew(false);
    if (r.status >= 200 && r.status < 300) setSelectedSeat(null);
    setBusy(false);
  };

  const handleUpdate = async (id, body) => {
    setBusy(true);
    const r = await crew.update(id, body);
    setLastRes({ ...r, method: "PATCH /crew/" + id });
    await fetchCrew(false);
    if (r.status >= 200 && r.status < 300) setSelectedSeat(null);
    setBusy(false);
  };

  const handleDelete = async (id) => {
    setBusy(true);
    const r = await crew.remove(id);
    setLastRes({ ...r, method: "DELETE /crew/" + id });
    await fetchCrew(false);
    setSelectedSeat(null);
    setBusy(false);
  };

  const handleClearAll = async () => {
    setBusy(true);
    const r = await crew.clear();
    setLastRes({ ...r, method: "DELETE /crew" });
    await fetchCrew(false);
    setBusy(false);
  };

  return (
    <div>
      <div className="panel">
        <div className="crew-controls">
          <div className="crew-controls-left">
            <h2 style={{ margin: 0 }}>Spaceship Crew</h2>
            <strong className="muted">{members.length} / {TOTAL_SEATS}</strong>
            <div className="crew-refresh">
              <label className="muted" style={{ fontSize: 12 }}>Auto-refresh:</label>
              <select value={refreshMs} onChange={(e) => setRefreshMs(Number(e.target.value))}
                style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)",
                  borderRadius: 6, padding: "4px 8px", fontSize: 12 }}>
                <option value={0}>Off</option>
                <option value={1000}>1s</option>
                <option value={2000}>2s</option>
                <option value={5000}>5s</option>
              </select>
            </div>
            <button className="btn ghost sm" onClick={() => fetchCrew(true)} disabled={busy}>Refresh</button>
          </div>
          {myRole === "admin" && (
            <button className="btn danger sm" onClick={handleClearAll} disabled={busy}>Clear all</button>
          )}
        </div>

        <p className="muted" style={{ marginTop: 0 }}>
          Click an empty seat to add a crew member, or click an occupied seat to edit or remove.
          Try chaos names: <span className="inline-code">blackout*</span> = 500,{" "}
          <span className="inline-code">throttle*</span> = 429,{" "}
          <span className="inline-code">{"delay<N>"}</span> = latency (5s+ = 504).
        </p>

        <div className="ship-wrapper">
          <div className="ship">
            <div className="ship-nose" />
            <div className="ship-body">
              <div className="ship-pilot-row">
                <div style={{ position: "relative" }}>
                  <Seat seatIdx={0} member={seatMap[0]} isPilot onSelect={setSelectedSeat} />
                  {selectedSeat === 0 && (
                    <SeatPopover seatIdx={0} member={seatMap[0]} onClose={() => setSelectedSeat(null)}
                      onAdd={handleAdd} onUpdate={handleUpdate} onDelete={handleDelete}
                      busy={busy} myId={myId} myRole={myRole} />
                  )}
                </div>
              </div>
              {[0, 1, 2, 3].map((row) => (
                <div className="ship-window-row" key={row}>
                  {[1, 2, 3, 4, 5].map((col) => {
                    const idx = row * 5 + col;
                    return (
                      <div key={idx} style={{ position: "relative" }}>
                        <Seat seatIdx={idx} member={seatMap[idx]} onSelect={setSelectedSeat} />
                        {selectedSeat === idx && (
                          <SeatPopover seatIdx={idx} member={seatMap[idx]}
                            onClose={() => setSelectedSeat(null)}
                            onAdd={handleAdd} onUpdate={handleUpdate} onDelete={handleDelete}
                            busy={busy} myId={myId} myRole={myRole} />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="ship-engines">
              <div className="engine-flame" />
              <div className="engine-flame" style={{ animationDelay: "0.15s" }} />
              <div className="engine-flame" style={{ animationDelay: "0.3s" }} />
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Last Response</h2>
        <p className="muted">The raw HTTP response from the last action you performed.</p>
        <ResponsePanel res={lastRes} />
        {!lastRes && <p className="muted" style={{ fontStyle: "italic" }}>No requests yet. Click a seat to get started.</p>}
      </div>

      <div className="panel">
        <h2>Chaos Names</h2>
        <p className="muted">Name a crew member with one of these prefixes to trigger a chaos scenario.</p>
        <table className="crew-table" style={{ maxWidth: 600 }}>
          <thead><tr><th>Prefix</th><th>Effect</th><th>Status</th></tr></thead>
          <tbody>
            <tr>
              <td><span className="inline-code">blackout*</span></td>
              <td className="muted">Member is never created. Lost in deep space.</td>
              <td><span className="crew-status" style={{ color: "var(--red)" }}>500</span></td>
            </tr>
            <tr>
              <td><span className="inline-code">throttle*</span></td>
              <td className="muted">Only 1 throttle member per 5 seconds</td>
              <td><span className="crew-status" style={{ color: "var(--amber)" }}>429</span></td>
            </tr>
            <tr>
              <td><span className="inline-code">{"delay<N>"}</span></td>
              <td className="muted">Delays by N seconds. 5+ times out.</td>
              <td><span className="crew-status" style={{ color: "var(--red)" }}>504</span></td>
            </tr>
            <tr>
              <td><em>duplicate name</em></td>
              <td className="muted">Two members cannot share a name</td>
              <td><span className="crew-status" style={{ color: "var(--amber)" }}>409</span></td>
            </tr>
            <tr>
              <td><em>seat 0</em></td>
              <td className="muted">Pilot seat. Admin only.</td>
              <td><span className="crew-status" style={{ color: "var(--amber)" }}>403</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
