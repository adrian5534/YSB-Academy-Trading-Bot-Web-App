import type { WebSocketServer, WebSocket } from "ws";
import { WS_EVENTS } from "@ysb/shared/routes";

export type WsPayload = { type: (typeof WS_EVENTS)[keyof typeof WS_EVENTS]; payload: unknown };

export class WsHub {
  private wss: WebSocketServer;

  private socketToUser = new WeakMap<WebSocket, string>();
  private userToSockets = new Map<string, Set<WebSocket>>();

  constructor(wss: WebSocketServer) {
    this.wss = wss;
  }

  private isOpen(ws: WebSocket) {
    return (ws as any).readyState === 1;
  }

  private safeSend(ws: WebSocket, data: string, onDead?: () => void) {
    try {
      if (!this.isOpen(ws)) return onDead?.();
      ws.send(data);
    } catch {
      onDead?.();
    }
  }

  /** Call this after you authenticate the websocket connection */
  attachClient(ws: WebSocket, userId: string) {
    // ✅ Ensure a single active socket per user (prevents duplicate logs)
    const existing = this.userToSockets.get(userId);
    if (existing && existing.size > 0) {
      for (const old of existing) {
        if (old === ws) continue;
        try {
          old.close(4000, "replaced");
        } catch {
          // ignore
        }
        existing.delete(old);
      }
      if (existing.size === 0) this.userToSockets.delete(userId);
    }

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
    for (const [, set] of this.userToSockets) {
      for (const ws of set) {
        this.safeSend(ws, data, () => set.delete(ws));
      }
    }
  }

  sendToUser(userId: string, msg: WsPayload) {
    const set = this.userToSockets.get(userId);
    if (!set || set.size === 0) return;

    const data = JSON.stringify(msg);
    for (const ws of set) {
      this.safeSend(ws, data, () => set.delete(ws));
    }
    if (set.size === 0) this.userToSockets.delete(userId);
  }

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