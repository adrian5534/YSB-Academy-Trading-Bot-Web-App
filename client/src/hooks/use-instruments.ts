import { useEffect, useState } from "react";

export function useInstruments() {
  const [data, setData] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const r = await fetch("/api/instruments/list", {
          credentials: "include",
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        if (r.status === 304) {
          if (alive) setError(null);
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const list = Array.isArray(j) ? j : Array.isArray((j as any)?.data) ? (j as any).data : [];
        if (alive) {
          setData(list);
          setError(null);
        }
      } catch (e: any) {
        if (alive) {
          setError(String(e?.message || e));
          // keep previous data on error
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
