import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export function useInstruments() {
  const [data, setData] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const r = await apiFetch("/api/instruments/list", {
          method: "GET",
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        if (r.status === 304) {
          if (alive) setError(null);
          return;
        }
        const ct = r.headers.get("content-type") || "";
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 140)}` : ""}`);
        }
        if (!ct.includes("application/json")) {
          const text = await r.text().catch(() => "");
          throw new Error(`Expected JSON, got: ${text.slice(0, 140) || ct}`);
        }
        const j = await r.json().catch(() => null);
        const list = Array.isArray(j) ? j : Array.isArray((j as any)?.data) ? (j as any).data : [];
        if (alive) {
          setData(list);
          setError(null);
        }
      } catch (e: any) {
        if (alive) {
          setError(String(e?.message || e));
          // keep previous data to avoid blank UI
        }
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, []);

  return { data: data ?? [], isLoading, error };
}
