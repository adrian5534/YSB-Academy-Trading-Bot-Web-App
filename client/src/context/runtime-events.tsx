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

    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (!alive) return;
      clearRetryTimer();

      // exponential backoff (1s, 2s, 4s, ... up to 30s) + small jitter
      const base = Math.min(30_000, 1000 * Math.pow(2, retry));
      const jitter = Math.floor(Math.random() * 250);
      const delay = base + jitter;

      retry = Math.min(retry + 1, 6); // cap growth
      retryTimer = setTimeout(() => {
        if (!alive) return;
        start();
      }, delay);
    };

    const onEvent = (evt: WsEvent) => {
      if (!alive) return;

      if (evt.type === "bot.status") {
        setBotStatus(evt.payload);
        save("ysb.botStatus", evt.payload);
      }

      if (evt.type === "bot.log") {
        const p: any = evt.payload ?? {};
        const item = {
          message: String(p.message ?? "log"),
          ts: String(p.ts ?? new Date().toISOString()),
          meta: p.meta,
        };

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
    };

    const start = () => {
      // close any existing socket first
      try {
        ws?.close();
      } catch {
        // ignore
      }

      ws = connectWs(onEvent);

      ws.addEventListener("open", () => {
        if (!alive) return;
        setConnected(true);
        retry = 0;
        clearRetryTimer();
      });

      ws.addEventListener("close", () => {
        if (!alive) return;
        setConnected(false);
        scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        if (!alive) return;
        setConnected(false);
        // some browsers won’t fire "close" after "error" reliably
        try {
          ws?.close();
        } catch {
          // ignore
        }
        scheduleReconnect();
      });
    };

    start();

    return () => {
      alive = false;
      clearRetryTimer();
      try {
        ws?.close();
      } catch {
        // ignore
      }
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
