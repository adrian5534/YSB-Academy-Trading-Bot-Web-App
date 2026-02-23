import React from "react";
import type { WsEvent } from "@/lib/ws";
import { connectWs } from "@/lib/ws";
import { supabase } from "@/lib/supabase";

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

  // ✅ Track the current socket + cancel superseded connects
  const wsRef = React.useRef<WebSocket | null>(null);
  const startSeqRef = React.useRef(0);

  React.useEffect(() => {
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

      const base = Math.min(30_000, 1000 * Math.pow(2, retry));
      const jitter = Math.floor(Math.random() * 250);
      const delay = base + jitter;

      retry = Math.min(retry + 1, 6);
      retryTimer = setTimeout(() => {
        if (!alive) return;
        void start();
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

    const start = async () => {
      const mySeq = ++startSeqRef.current;

      // close any existing socket first
      const prev = wsRef.current;
      wsRef.current = null;
      try {
        prev?.close();
      } catch {
        // ignore
      }

      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;

      if (!alive) return;

      // If another start() began while we awaited getSession(), abort this one.
      if (mySeq !== startSeqRef.current) return;

      if (!token) {
        setConnected(false);
        scheduleReconnect();
        return;
      }

      const ws = connectWs(onEvent, token);

      // If superseded immediately after creating the socket, close it.
      if (mySeq !== startSeqRef.current) {
        try {
          ws.close();
        } catch {}
        return;
      }

      wsRef.current = ws;

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
        try {
          wsRef.current?.close();
        } catch {
          // ignore
        }
        scheduleReconnect();
      });
    };

    const { data: authSub } = supabase.auth.onAuthStateChange((event) => {
      if (!alive) return;

      // Avoid immediate double-connect (we already call start() below)
      if (event === "INITIAL_SESSION") return;

      setBotStatus(null);
      setLogs([]);
      setTrades([]);
      save("ysb.botStatus", null);
      save("ysb.logs", []);
      save("ysb.trades", []);

      void start();
    });

    void start();

    return () => {
      alive = false;
      clearRetryTimer();
      authSub?.subscription?.unsubscribe();

      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
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