export type WsEvent =
  | { type: "bot.status"; payload: unknown }
  | { type: "bot.log"; payload: unknown }
  | { type: "trade.event"; payload: unknown };

export function connectWs(onEvent: (evt: WsEvent) => void) {
  const base = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? "";
  const wsUrl = (base ? base.replace("http", "ws") : "") + "/ws";
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
