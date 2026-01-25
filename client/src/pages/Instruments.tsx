import { useMemo, useState } from "react";
import { useInstruments } from "@/hooks/use-instruments";

export default function Instruments() {
  const { data: instruments } = useInstruments();
  const [q, setQ] = useState("");
  const [market, setMarket] = useState("");

  const markets = useMemo(() => {
    const m = new Map<string, number>();
    (instruments ?? []).forEach((i) => {
      const k = i.market_display_name ?? i.market ?? "Other";
      m.set(k, (m.get(k) ?? 0) + 1);
    });
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  }, [instruments]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (instruments ?? []).filter((i) => {
      const m = i.market_display_name ?? i.market ?? "Other";
      if (market && m !== market) return false;
      if (!query) return true;
      return (
        i.symbol.toLowerCase().includes(query) ||
        i.display_name.toLowerCase().includes(query) ||
        (i.subgroup_display_name ?? "").toLowerCase().includes(query)
      );
    });
  }, [instruments, q, market]);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-2xl font-semibold">Instruments</div>
        <div className="text-sm text-muted-foreground">Loaded dynamically from Deriv (no hardcoded list).</div>
      </div>

      <div className="flex flex-wrap gap-2">
        <input className="flex-1 min-w-60 rounded-lg border border-border bg-background px-3 py-2" placeholder="Search symbols…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="rounded-lg border border-border bg-background px-3 py-2" value={market} onChange={(e) => setMarket(e.target.value)}>
          <option value="">All markets</option>
          {markets.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="text-sm text-muted-foreground mb-3">Showing {filtered.length} instruments</div>
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
          {filtered.slice(0, 300).map((i) => (
            <div key={i.symbol} className="rounded-lg border border-border bg-background px-3 py-2">
              <div className="font-medium">{i.display_name}</div>
              <div className="text-xs text-muted-foreground">{i.symbol} • {i.market_display_name ?? i.market ?? "Other"}</div>
              <div className="text-xs text-muted-foreground">{i.subgroup_display_name ?? ""}</div>
            </div>
          ))}
        </div>
        {filtered.length > 300 ? <div className="mt-3 text-xs text-muted-foreground">Showing first 300 results.</div> : null}
      </div>
    </div>
  );
}
