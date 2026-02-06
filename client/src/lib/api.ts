// Ensure calls hit your API host and include Supabase token (fixes 404/401)
const API_BASE = import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "";
export async function apiFetch(path: string, init?: RequestInit) {
  const url = /^https?:\/\//i.test(path) ? path : `${API_BASE}${path}`;
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  try {
    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  } catch {}

  return fetch(url, { ...init, headers, credentials: "include" });
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
