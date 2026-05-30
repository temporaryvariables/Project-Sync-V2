import { useEffect, useRef, useState } from "react";
import { getRelayUrl, setRelayUrl, useRelayUrl } from "../settings";

export default function RelaySettings() {
  const relayUrl = useRelayUrl();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(relayUrl);
  const ref = useRef(null);

  useEffect(() => {
    if (open) setDraft(getRelayUrl());
  }, [open]);

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function save() {
    setRelayUrl(draft);
    setOpen(false);
  }

  return (
    <div className="relay-settings" ref={ref}>
      <button
        className={`btn ghost sm ${relayUrl ? "" : "warn"}`}
        onClick={() => setOpen((v) => !v)}
        title={relayUrl ? `Relay: ${relayUrl}` : "No relay URL set"}
      >
        ⚙ Relay {relayUrl ? "" : "·"}
      </button>

      {open && (
        <div className="relay-popover">
          <label>Relay URL</label>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://your-relay.example.com"
            onKeyDown={(e) => e.key === "Enter" && save()}
            autoFocus
          />
          <p className="muted" style={{ fontSize: 12 }}>
            Saved on this device. The Deep Space Network uses this address.
          </p>
          <div className="relay-popover-actions">
            <button className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn sm" onClick={save}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}
