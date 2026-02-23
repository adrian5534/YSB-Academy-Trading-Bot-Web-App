import type { WebSocketServer, WebSocket } from "ws";
import { WS_EVENTS } from "@ysb/shared/routes";

export type WsPayload = { type: (typeof WS_EVENTS)[keyof typeof WS_EVENTS]; payload: unknown };

export class WsHub {
  private wss: WebSocketServer;

  // Track which sockets belong to which user
  private socketToUser = new WeakMap<WebSocket, string>();
  private userToSockets = new Map<string, Set<WebSocket>>();

  constructor(wss: WebSocketServer) {
    this.wss = wss;
  }

  /** Call this after you authenticate the websocket connection */
  attachClient(ws: WebSocket, userId: string) {
    this.socketToUser.set(ws, userId);

    let set = this.userToSockets.get(userId);
    if (!set) {
      set = new Set<WebSocket>();
      this.userToSockets.set(userId, set);
    }
    set.add(ws);

    ws.once("close", () => this.detachClient(ws));
    ws.once("error", () => this.detachClient(ws));
  }

  detachClient(ws: WebSocket) {
    const userId = this.socketToUser.get(ws);
    if (!userId) return;

    const set = this.userToSockets.get(userId);
    if (!set) return;

    set.delete(ws);
    if (set.size === 0) this.userToSockets.delete(userId);
  }

  broadcast(msg: WsPayload) {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      const ws = client as WebSocket;
      if (ws.readyState === 1) ws.send(data);
    }
  }

  sendToUser(userId: string, msg: WsPayload) {
    const set = this.userToSockets.get(userId);
    if (!set || set.size === 0) return;

    const data = JSON.stringify(msg);
    for (const ws of set) {
      if (ws.readyState === 1) ws.send(data);
      else set.delete(ws);
    }
    if (set.size === 0) this.userToSockets.delete(userId);
  }

  // Backwards compatible: if userId is omitted, it broadcasts.
  log(message: string, meta: unknown = {}, userId?: string) {
    const msg: WsPayload = {
      type: WS_EVENTS.BOT_LOG,
      payload: { message, meta, ts: new Date().toISOString() },
    };
    return userId ? this.sendToUser(userId, msg) : this.broadcast(msg);
  }

  status(payload: unknown, userId?: string) {
    const msg: WsPayload = { type: WS_EVENTS.BOT_STATUS, payload };
    return userId ? this.sendToUser(userId, msg) : this.broadcast(msg);
  }

  trade(payload: unknown, userId?: string) {
    const msg: WsPayload = { type: WS_EVENTS.TRADE_EVENT, payload };
    return userId ? this.sendToUser(userId, msg) : this.broadcast(msg);
  }
}