import { token } from "./pb";

// Accept service URLs with or without a scheme. A bare host like
// "stations.example.com" becomes "https://stations.example.com".
function normalizeUrl(value, fallback) {
  const v = (value || fallback || "").trim();
  if (!v) return v;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

const GROUND_STATION_URL = normalizeUrl(import.meta.env.VITE_GROUND_STATION_URL, "http://localhost:3001");
const FLIGHT_DIRECTOR_URL = normalizeUrl(import.meta.env.VITE_FLIGHT_DIRECTOR_URL, "http://localhost:3002");
const DEEP_SPACE_NETWORK_URL = normalizeUrl(import.meta.env.VITE_DEEP_SPACE_NETWORK_URL, "http://localhost:3003");

async function request(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token()}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

// --- flight-director-api -----------------------------------------------------
export const flightDirector = {
  reset: (opts = {}) =>
    request(FLIGHT_DIRECTOR_URL, `/reset${opts.keepChaos ? "?keepChaos=true" : ""}`, { method: "POST" }),
  tables: () => request(FLIGHT_DIRECTOR_URL, "/tables"),
  listChaos: () => request(FLIGHT_DIRECTOR_URL, "/chaos"),
  createChaos: (body) => request(FLIGHT_DIRECTOR_URL, "/chaos", { method: "POST", body: JSON.stringify(body) }),
  updateChaos: (id, body) => request(FLIGHT_DIRECTOR_URL, `/chaos/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteChaos: (id) => request(FLIGHT_DIRECTOR_URL, `/chaos/${id}`, { method: "DELETE" }),
  teamRecords: (teamId, limit = 100) => request(FLIGHT_DIRECTOR_URL, `/teams/${teamId}/records?limit=${limit}`),
  logs: (opts = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", opts.limit);
    if (opts.level) q.set("level", opts.level);
    if (opts.selector) q.set("selector", opts.selector);
    const qs = q.toString();
    return request(FLIGHT_DIRECTOR_URL, `/logs${qs ? `?${qs}` : ""}`);
  },
  trace: (correlationId) => request(FLIGHT_DIRECTOR_URL, `/logs/${encodeURIComponent(correlationId)}`),
};

// --- ground-station-api ------------------------------------------------------
export const groundStation = {
  putStation: (station, selector, body) =>
    request(GROUND_STATION_URL, `/groundstation/${station}/${selector}`, { method: "PUT", body: JSON.stringify(body) }),
  putMissionLog: (selector, body) =>
    request(GROUND_STATION_URL, `/missionlog/${selector}`, { method: "PUT", body: JSON.stringify(body) }),
  commands: (page = 1, perPage = 50) =>
    request(GROUND_STATION_URL, `/commands?page=${page}&perPage=${perPage}`),
};

// --- deep-space-network ------------------------------------------------------
export const deepSpaceNetwork = {
  scenarios: () => request(DEEP_SPACE_NETWORK_URL, "/scenarios"),
  start: (body) => request(DEEP_SPACE_NETWORK_URL, "/start", { method: "POST", body: JSON.stringify(body) }),
  stop: () => request(DEEP_SPACE_NETWORK_URL, "/stop", { method: "POST" }),
  clear: () => request(DEEP_SPACE_NETWORK_URL, "/clear", { method: "POST" }),
  status: () => request(DEEP_SPACE_NETWORK_URL, "/status"),
  requests: (limit = 100) => request(DEEP_SPACE_NETWORK_URL, `/requests?limit=${limit}`),
};

// --- crew members (Learn tab) ------------------------------------------------
// A raw fetch that returns full response info (status, body) even on errors,
// so the Learn tab can display the HTTP details to students.
async function rawCrew(path, options = {}) {
  const res = await fetch(`${FLIGHT_DIRECTOR_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token()}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, statusText: res.statusText, body };
}

export const crew = {
  list:   ()           => rawCrew("/crew"),
  get:    (id)         => rawCrew(`/crew/${id}`),
  create: (body)       => rawCrew("/crew", { method: "PUT",    body: JSON.stringify(body) }),
  update: (id, body)   => rawCrew(`/crew/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  remove: (id)         => rawCrew(`/crew/${id}`, { method: "DELETE" }),
  clear:  ()           => rawCrew("/crew",       { method: "DELETE" }),
};
