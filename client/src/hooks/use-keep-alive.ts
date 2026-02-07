import { useEffect } from "react";
import { apiFetch } from "@/lib/api";

export function useKeepAlive(enabled: boolean = true, intervalMs = 240_000) {
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;

    const ping = async () => {
      try {
        await apiFetch("/api/health", { method: "GET" });
      } catch {
        /* ignore */
      }
    };

    // immediate ping, then interval
    void ping();
    const id = setInterval(() => {
      if (!stopped) void ping();
    }, intervalMs);

    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [enabled, intervalMs]);
}