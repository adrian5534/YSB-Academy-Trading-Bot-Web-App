export type WsEvent =
  | { type: "bot.status"; payload: unknown }
  | { type: "bot.log"; payload: unknown }
  | { type: "trade.event"; payload: unknown };

function toWsOrigin(httpOrigin: string) {
  const base = httpOrigin.replace(/\/$/, "");
  if (base.startsWith("https://")) return base.replace(/^https:\/\//, "wss://");
  if (base.startsWith("http://")) return base.replace(/^http:\/\//, "ws://");
  // if someone passes ws:// already, keep it
  return base;
}

export function connectWs(onEvent: (evt: WsEvent) => void, accessToken?: string) {
  const base = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? window.location.origin;
  const wsOrigin = toWsOrigin(base);

  const qs = accessToken ? `?access_token=${encodeURIComponent(accessToken)}` : "";
  const wsUrl = `${wsOrigin}/ws${qs}`;

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
