import { useState } from "react";
import { pb } from "../pb";

export default function Login({ onAuthed }) {
  const [mode, setMode] = useState("login"); // login | register
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [teamId, setTeamId] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      if (mode === "register") {
        await pb.collection("users").create({
          email,
          password,
          passwordConfirm: password,
          team_id: teamId,
        });
        setInfo("Account created. Signing you in...");
      }
      await pb.collection("users").authWithPassword(email, password);
      onAuthed();
    } catch (err) {
      setError(err?.message || "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="starfield" />
      <div className="login-card">
        <div className="brand">
          <span className="logo" />
          <div>
            <div style={{ fontSize: 18 }}>Project Sync</div>
            <small className="muted">Mission Control</small>
          </div>
        </div>
        <h1>{mode === "login" ? "Crew sign in" : "Enlist a crew member"}</h1>
        <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
          {mode === "login"
            ? "Authenticate to reach your mission console."
            : "Register and join your team to begin the mission."}
        </p>

        {error && <div className="error-banner">{error}</div>}
        {info && <div className="info-banner">{info}</div>}

        <form onSubmit={submit}>
          <div className="field">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="commander@station.io"
              required
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              minLength={8}
              required
            />
          </div>
          {mode === "register" && (
            <div className="field">
              <label>Team ID</label>
              <input
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                placeholder="e.g. orion-crew"
                required
              />
            </div>
          )}
          <button className="btn" style={{ width: "100%" }} disabled={busy}>
            {busy ? <span className="spinner" /> : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <p style={{ marginTop: 16, fontSize: 13 }} className="muted">
          {mode === "login" ? "Need an account? " : "Already enlisted? "}
          <button
            type="button"
            className="toggle-link"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
              setInfo("");
            }}
          >
            {mode === "login" ? "Register here" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
