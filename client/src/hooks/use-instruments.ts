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
        const r = await fetch("/api/instruments/list", { credentials: "include" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (alive) { setData(Array.isArray(j) ? j : []); setError(null); }
      } catch (e: any) {
        if (alive) { setError(String(e?.message || e)); setData([]); }
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    return () => { alive = false; };
  }, []);

  return { data: data ?? [], isLoading, error };
}
