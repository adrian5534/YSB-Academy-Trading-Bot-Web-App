import type { WebSocketServer, WebSocket } from "ws";
import { WS_EVENTS } from "@ysb/shared/routes";

export type WsPayload = { type: (typeof WS_EVENTS)[keyof typeof WS_EVENTS]; payload: unknown };

export class WsHub {
  private wss: WebSocketServer;

  constructor(wss: WebSocketServer) {
    this.wss = wss;
  }

  broadcast(msg: WsPayload) {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if ((client as WebSocket).readyState === 1) client.send(data);
    }
  }

  log(message: string, meta: unknown = {}) {
    this.broadcast({ type: WS_EVENTS.BOT_LOG, payload: { message, meta, ts: new Date().toISOString() } });
  }

  status(payload: unknown) {
    this.broadcast({ type: WS_EVENTS.BOT_STATUS, payload });
  }

  trade(payload: unknown) {
    this.broadcast({ type: WS_EVENTS.TRADE_EVENT, payload });
  }
}
