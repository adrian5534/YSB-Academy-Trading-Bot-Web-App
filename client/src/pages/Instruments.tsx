import { useMemo, useState } from "react";
import { useInstruments } from "@/hooks/use-instruments";

export default function Instruments() {
  const { data: instruments, isLoading, error } = useInstruments();
  const [q, setQ] = useState("");
  const [market, setMarket] = useState("");

  const markets = useMemo(() => {
    const m = new Map<string, number>();
    (instruments ?? []).forEach((i) => {
      const k = String(i?.market_display_name ?? i?.market ?? "Other");
      m.set(k, (m.get(k) ?? 0) + 1);
    });
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map((x) => x[0]);
  }, [instruments]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (instruments ?? []).filter((i) => {
      const name = String(i?.display_name ?? "");
      const sym = String(i?.symbol ?? "");
      const group = String(i?.subgroup_display_name ?? i?.submarket_display_name ?? "");
      const m = String(i?.market_display_name ?? i?.market ?? "Other");
      if (market && m !== market) return false;
      if (!query) return true;
      return (
        sym.toLowerCase().includes(query) ||
        name.toLowerCase().includes(query) ||
        group.toLowerCase().includes(query)
      );
    });
  }, [instruments, q, market]);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-2xl font-semibold">Instruments</div>
        <div className="text-sm text-muted-foreground">
          Loaded dynamically from Deriv (no hardcoded list).
        </div>
        {error ? <div className="mt-2 text-sm text-rose-400">Failed to load instruments: {error}</div> : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          className="flex-1 min-w-60 rounded-lg border border-border bg-background px-3 py-2"
          placeholder="Search symbols…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="rounded-lg border border-border bg-background px-3 py-2"
          value={market}
          onChange={(e) => setMarket(e.target.value)}
        >
          <option value="">All markets</option>
          {markets.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <div className="text-sm text-muted-foreground mb-3">
              Showing {filtered.length} instruments
            </div>
            <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              {filtered.slice(0, 300).map((i) => (
                <div key={String(i?.symbol)} className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="font-medium">{String(i?.display_name ?? "")}</div>
                  <div className="text-xs text-muted-foreground">
                    {String(i?.symbol ?? "")} • {String(i?.market_display_name ?? i?.market ?? "Other")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {String(i?.subgroup_display_name ?? i?.submarket_display_name ?? "")}
                  </div>
                </div>
              ))}
            </div>
            {filtered.length === 0 ? (
              <div className="mt-3 text-sm text-muted-foreground">No instruments match your filters.</div>
            ) : null}
            {filtered.length > 300 ? (
              <div className="mt-3 text-xs text-muted-foreground">Showing first 300 results.</div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
