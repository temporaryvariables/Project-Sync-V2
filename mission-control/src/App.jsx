import { useState } from "react";
import { pb, currentUser, logout, role } from "./pb";
import Login from "./components/Login";
import RelaySettings from "./components/RelaySettings";
import Guide from "./tabs/Guide";
import ApiReference from "./tabs/ApiReference";
import DeepSpaceNetwork from "./tabs/DeepSpaceNetwork";
import Admin from "./tabs/Admin";

const TABS = [
  { key: "guide", label: "Guide", Component: Guide },
  { key: "api", label: "API Reference", Component: ApiReference },
  { key: "dsn", label: "Deep Space Network", Component: DeepSpaceNetwork },
  { key: "admin", label: "Admin", Component: Admin },
];

// Which tabs each role is allowed to see. Guide and API Reference are always
// available; the Deep Space Network and Admin tabs are gated by role.
const ROLE_TABS = {
  admin: ["guide", "api", "dsn", "admin"],
  run: ["guide", "api", "dsn"],
  read: ["guide", "api"],
};

export default function App() {
  const [authed, setAuthed] = useState(pb.authStore.isValid);
  const [tab, setTab] = useState("guide");

  if (!authed) {
    return <Login onAuthed={() => setAuthed(true)} />;
  }

  const user = currentUser();
  const allowed = ROLE_TABS[role()] || ROLE_TABS.read;
  const tabs = TABS.filter((t) => allowed.includes(t.key));
  // If the current tab isn't allowed for this role, fall back to the first one.
  const activeKey = allowed.includes(tab) ? tab : tabs[0].key;
  const Active = TABS.find((t) => t.key === activeKey).Component;

  return (
    <div className="app">
      <div className="starfield" />
      <header className="topbar">
        <div className="brand">
          <span className="logo" />
          <div>
            <div>Project Sync</div>
            <small>Mission Control</small>
          </div>
        </div>
        <div className="userbox">
          <span className="pill">
            <span className="dot on" /> Team: <strong style={{ color: "var(--text)" }}>{user?.team_id || "none"}</strong>
          </span>
          <RelaySettings />
          <span>{user?.email}</span>
          <button
            className="btn ghost sm"
            onClick={() => {
              logout();
              setAuthed(false);
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <nav className="tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`tab ${activeKey === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        <Active />
      </main>
    </div>
  );
}
