import React from "react";
import { apiFetch } from "@/lib/api";
import { supabase } from "@/lib/supabase";
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
  const pollRef = React.useRef<number | null>(null);
  const startSeqRef = React.useRef(0);

  const fetchLogs = React.useCallback(async () => {
    try {
      const r = await apiFetch(`/api/logs/list?limit=${MAX_LOGS}`);
      if (!r.ok) return;
      const rows = (await r.json()) as any[];
      setLogs(mapRowsToLogs(rows).slice(0, MAX_LOGS)); // newest-first
    } catch {
      // ignore
    }
  }, []);

  React.useEffect(() => {
    let alive = true;

    const stop = () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
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
        setLogs((prev) => [item, ...(prev ?? [])].slice(0, MAX_LOGS));
        return;
      }

      if (evt?.type === "trade.event") {
        setTrades((prev) => [evt.payload, ...(prev ?? [])].slice(0, 200));
      }
    };

    const start = async () => {
      const seq = ++startSeqRef.current;
      stop();

      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!alive) return;
      if (seq !== startSeqRef.current) return;

      if (!token) return;

      // load persisted logs immediately
      void fetchLogs();

      // poll so the UI updates even if WS is unavailable
      pollRef.current = window.setInterval(() => void fetchLogs(), POLL_MS);

      // websocket for instant logs
      const ws = connectWs(onWsEvent as any, token);
      wsRef.current = ws;

      ws.addEventListener("open", () => alive && setConnected(true));
      ws.addEventListener("close", () => alive && setConnected(false));
      ws.addEventListener("error", () => alive && setConnected(false));
    };

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (!alive) return;

      if (event === "SIGNED_OUT") {
        stop();
        setBotStatus(null);
        setLogs([]);
        setTrades([]);
        return;
      }

      // SIGNED_IN / TOKEN_REFRESHED
      void start();
    });

    void start();

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