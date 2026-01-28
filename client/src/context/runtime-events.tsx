import React from "react";
import type { WsEvent } from "@/lib/api";
import { connectWs } from "@/lib/api";

type RuntimeState = {
  connected: boolean;
  botStatus: any | null;
  logs: Array<{ message: string; ts: string; meta?: any }>;
  trades: any[];
  clearLogs: () => void;
};

const Ctx = React.createContext<RuntimeState | null>(null);

const MAX_LOGS = 500;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: any) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function RuntimeEventsProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = React.useState(false);
  const [botStatus, setBotStatus] = React.useState<any | null>(load("ysb.botStatus", null));
  const [logs, setLogs] = React.useState<Array<{ message: string; ts: string; meta?: any }>>(load("ysb.logs", []));
  const [trades, setTrades] = React.useState<any[]>(load("ysb.trades", []));

  React.useEffect(() => {
    let ws: WebSocket | null = null;
    let alive = true;

    const start = () => {
      ws = connectWs((evt: WsEvent) => {
        if (!alive) return;

        if (evt.type === "bot.status") {
          setBotStatus(evt.payload);
          save("ysb.botStatus", evt.payload);
        }

        if (evt.type === "bot.log") {
          const p: any = evt.payload ?? {};
          const item = { message: String(p.message ?? "log"), ts: String(p.ts ?? new Date().toISOString()), meta: p.meta };
          setLogs((prev) => {
            const next = [item, ...prev].slice(0, MAX_LOGS);
            save("ysb.logs", next);
            return next;
          });
        }

        if (evt.type === "trade.event") {
          setTrades((prev) => {
            const next = [evt.payload, ...prev].slice(0, 200);
            save("ysb.trades", next);
            return next;
          });
        }
      });

      ws.addEventListener("open", () => setConnected(true));
      ws.addEventListener("close", () => setConnected(false));
      ws.addEventListener("error", () => setConnected(false));
    };

    start();

    return () => {
      alive = false;
      try {
        ws?.close();
      } catch {}
    };
  }, []);

  const clearLogs = React.useCallback(() => {
    setLogs([]);
    save("ysb.logs", []);
  }, []);

  const value: RuntimeState = { connected, botStatus, logs, trades, clearLogs };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRuntimeEvents() {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useRuntimeEvents must be used inside RuntimeEventsProvider");
  return v;
}
