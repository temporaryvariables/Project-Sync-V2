import { useState } from "react";
import { pb, currentUser, logout } from "./pb";
import Login from "./components/Login";
import Guide from "./tabs/Guide";
import ApiReference from "./tabs/ApiReference";
import DeepSpaceNetwork from "./tabs/DeepSpaceNetwork";
import TeamDashboard from "./tabs/TeamDashboard";
import Admin from "./tabs/Admin";

const TABS = [
  { key: "guide", label: "Guide", Component: Guide },
  { key: "api", label: "API Reference", Component: ApiReference },
  { key: "dsn", label: "Deep Space Network", Component: DeepSpaceNetwork },
  { key: "dashboard", label: "Team Dashboard", Component: TeamDashboard },
  { key: "admin", label: "Admin", Component: Admin },
];

export default function App() {
  const [authed, setAuthed] = useState(pb.authStore.isValid);
  const [tab, setTab] = useState("guide");

  if (!authed) {
    return <Login onAuthed={() => setAuthed(true)} />;
  }

  const user = currentUser();
  const Active = TABS.find((t) => t.key === tab).Component;

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
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? "active" : ""}`}
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
