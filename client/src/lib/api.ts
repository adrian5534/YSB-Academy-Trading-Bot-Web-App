import { supabase } from "./supabase";

function withBase(input: RequestInfo | URL) {
  const base = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  if (!base) return input;

  if (typeof input === "string" && input.startsWith("/")) return base + input;
  if (input instanceof URL && input.pathname.startsWith("/")) return new URL(base + input.pathname + input.search);
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

  const res = await fetch(withBase(input), { ...init, headers });
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
  const base = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.replace(/\/$/, "") ?? "";
  const wsUrl = (base ? base.replace(/^http/, "ws") : "") + "/ws";
  const ws = new WebSocket(wsUrl);

  ws.addEventListener("message", (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {}
  });

  return ws;
}
