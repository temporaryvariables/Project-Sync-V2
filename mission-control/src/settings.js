import { useEffect, useState } from "react";

const RELAY_KEY = "ps_relay_url";
const RELAY_EVENT = "relayurlchange";

export function getRelayUrl() {
  try {
    return localStorage.getItem(RELAY_KEY) || "";
  } catch {
    return "";
  }
}

export function setRelayUrl(url) {
  const value = (url || "").trim();
  try {
    if (value) localStorage.setItem(RELAY_KEY, value);
    else localStorage.removeItem(RELAY_KEY);
  } catch {
    // ignore storage failures (private mode, etc.)
  }
  window.dispatchEvent(new CustomEvent(RELAY_EVENT, { detail: value }));
}

export function useRelayUrl() {
  const [url, setUrl] = useState(getRelayUrl);

  useEffect(() => {
    const onChange = () => setUrl(getRelayUrl());
    window.addEventListener(RELAY_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(RELAY_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  return url;
}
