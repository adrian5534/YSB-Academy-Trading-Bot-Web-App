import { supabase } from "./supabase";

function getBackendBase() {
  return ((import.meta.env.VITE_BACKEND_URL as string | undefined) ?? "").replace(/\/$/, "");
}

function resolveUrl(input: RequestInfo | URL) {
  const base = getBackendBase();

  // If input is a string like "/api/..." and we have a backend base, prefix it
  if (typeof input === "string" && input.startsWith("/") && base) {
    return `${base}${input}`;
  }

  return input;
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token;

  const headers = new Headers(init?.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);

  if (!headers.has("Content-Type") && init?.body && !(init?.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(resolveUrl(input), { ...init, headers });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${msg}`);
  }

  return res;
}

export type WsEvent =
  | { type: "bot.status"; payload: unknown }
  | { type: "bot.log"; payload: unknown }
  | { type: "trade.event"; payload: unknown };

export function connectWs(onEvent: (evt: WsEvent) => void) {
  const base = getBackendBase();

  // If backend base exists, derive ws(s)://.../ws from it.
  // Otherwise fall back to same-origin (useful for local proxy setups).
  const wsUrl = base
    ? `${base.replace(/^http/, "ws")}/ws`
    : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

  const ws = new WebSocket(wsUrl);

  ws.addEventListener("message", (m) => {
    try {
      const data = JSON.parse(m.data);
      onEvent(data);
    } catch {
      // ignore
    }
  });

  return ws;
}
