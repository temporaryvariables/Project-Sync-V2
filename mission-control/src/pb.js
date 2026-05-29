import PocketBase from "pocketbase";

const url = import.meta.env.VITE_POCKETBASE_URL || "http://localhost:8090";

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

export function token() {
  return pb.authStore.token;
}

export function logout() {
  pb.authStore.clear();
}
