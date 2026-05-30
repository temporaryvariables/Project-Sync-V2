import PocketBase from "pocketbase";

// Accept the PocketBase URL with or without a scheme. A bare host like
// "auth.example.com" becomes "https://auth.example.com".
function normalizeUrl(value, fallback) {
  const v = (value || fallback || "").trim();
  if (!v) return v;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

const url = normalizeUrl(import.meta.env.VITE_POCKETBASE_URL, "http://localhost:8090");

// PocketBase persists the auth token in localStorage automatically, so the
// session survives a page refresh.
export const pb = new PocketBase(url);

export function currentUser() {
  return pb.authStore.record || pb.authStore.model || null;
}

export function teamId() {
  const u = currentUser();
  return u ? u.team_id : null;
}

// The user's role controls which tabs are available:
//   "admin" — full access (no tabs locked)
//   "run"   — can use the Deep Space Network, but not Admin
//   "read"  — read-only: both Deep Space Network and Admin are locked
// Defaults to "read" (most restrictive) if the metadata is missing.
export function role() {
  const u = currentUser();
  const r = (u && u.role ? String(u.role) : "read").toLowerCase();
  return ["admin", "run", "read"].includes(r) ? r : "read";
}

export function token() {
  return pb.authStore.token;
}

export function logout() {
  pb.authStore.clear();
}
