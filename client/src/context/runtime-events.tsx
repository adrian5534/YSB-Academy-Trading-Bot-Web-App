import React from "react";
import { supabase } from "@/lib/supabase";
import { apiFetch } from "@/lib/api";
import { connectWs } from "@/lib/ws";

type RuntimeState = {
  connected: boolean;
  botStatus: any | null;
  logs: Array<{ message: string; ts: string; meta?: any }>;
  trades: any[];
  clearLogs: () => void;
};

const Ctx = React.createContext<RuntimeState | null>(null);

const MAX_LOGS = 500;
const POLL_MS = 2500;

type WsEvent = { type: string; payload?: any };

const mapRowsToLogs = (rows: any[]) =>
  (rows ?? []).map((x: any) => ({
    message: String(x?.message ?? ""),
    ts: String(x?.created_at ?? x?.ts ?? new Date().toISOString()),
    meta: x?.meta ?? undefined,
  }));

export function RuntimeEventsProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = React.useState(false);
  const [botStatus, setBotStatus] = React.useState<any | null>(null);
  const [logs, setLogs] = React.useState<Array<{ message: string; ts: string; meta?: any }>>([]);
  const [trades, setTrades] = React.useState<any[]>([]);

  const wsRef = React.useRef<WebSocket | null>(null);

  const fetchLogs = React.useCallback(async () => {
    try {
      const r = await apiFetch(`/api/logs/list?limit=${MAX_LOGS}`);
      if (!r.ok) return;

      const rows = (await r.json()) as any[];
      // server returns newest first (order desc) -> keep newest first in state
      setLogs(mapRowsToLogs(rows).slice(0, MAX_LOGS));
    } catch {
      // ignore
    }
  }, []);

  React.useEffect(() => {
    let alive = true;
    let pollTimer: number | null = null;

    const stop = () => {
      if (pollTimer) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
      setConnected(false);
    };

    const onWsEvent = (evt: WsEvent) => {
      if (!alive) return;

      if (evt?.type === "bot.status") {
        setBotStatus(evt.payload ?? null);
        return;
      }

      if (evt?.type === "bot.log") {
        const p: any = evt.payload ?? {};
        const item = {
          message: String(p.message ?? ""),
          ts: String(p.ts ?? new Date().toISOString()),
          meta: p.meta ?? undefined,
        };

        // keep newest first (so BotCenter shows it immediately)
        setLogs((prev) => [item, ...(prev ?? [])].slice(0, MAX_LOGS));
        return;
      }

      if (evt?.type === "trade.event") {
        setTrades((prev) => [evt.payload, ...(prev ?? [])].slice(0, 200));
      }
    };

    const start = async () => {
      stop();

      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!alive) return;

      if (!token) {
        // not signed in yet
        return;
      }

      // ✅ Always load persisted logs when we (re)start
      void fetchLogs();

      // ✅ Poll logs so UI keeps updating even if WS disconnects
      pollTimer = window.setInterval(() => void fetchLogs(), POLL_MS);

      // ✅ Keep websocket for immediate "live" logs
      const ws = connectWs(onWsEvent as any, token);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (!alive) return;
        setConnected(true);
      });

      ws.addEventListener("close", () => {
        if (!alive) return;
        setConnected(false);
      });

      ws.addEventListener("error", () => {
        if (!alive) return;
        setConnected(false);
      });
    };

    // Start once
    void start();

    // Don’t clear logs on token refresh; only on sign-out
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (!alive) return;
      if (event === "SIGNED_OUT") {
        stop();
        setBotStatus(null);
        setLogs([]);
        setTrades([]);
        return;
      }
      // SIGNED_IN / TOKEN_REFRESHED -> restart (keeps logs from DB)
      void start();
    });

    return () => {
      alive = false;
      sub?.subscription?.unsubscribe();
      stop();
    };
  }, [fetchLogs]);

  const clearLogs = React.useCallback(() => {
    setLogs([]);
    void apiFetch("/api/logs/clear", { method: "POST" }).catch(() => void 0);
  }, []);

  const value: RuntimeState = { connected, botStatus, logs, trades, clearLogs };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRuntimeEvents(): RuntimeState {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useRuntimeEvents must be used within RuntimeEventsProvider");
  return v;
}