import { useTrades } from "@/hooks/use-trades";

export type HistoryMode = "all" | "paper" | "live" | "backtest";

function formatTime(iso?: string | null) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function formatPrice(v: any) {
  const n = Number(v);
  if (!isFinite(n)) return "-";
  return n.toFixed(2);
}

function formatProfit(v: any) {
  const n = Number(v ?? 0);
  const p = Math.abs(n).toFixed(2);
  return `${n > 0 ? "+$" : n < 0 ? "-$" : "$"}${p}`;
}

export function TradeHistory({ mode = "all" }: { mode?: HistoryMode }) {
  const { data: trades, isLoading } = useTrades();

  const rows = (trades ?? [])
    .filter((t) => (mode === "all" ? true : String(t.mode ?? "").toLowerCase() === mode))
    .slice(0, 50);

  return (
    <div className="rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <div className="h-2 w-2 rounded-full bg-yellow-300/80 shadow-[0_0_12px_rgba(250,204,21,0.6)]" />
        <h2 className="font-semibold text-lg">
          Recent Trades {mode !== "all" ? `• ${mode[0].toUpperCase()}${mode.slice(1)}` : ""}
        </h2>
      </div>

      {isLoading ? (
        <div className="p-4 text-muted-foreground">Loading…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/70">
                <th className="px-4 py-3 text-left font-medium">Time</th>
                <th className="px-4 py-3 text-left font-medium">Symbol</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Entry</th>
                <th className="px-4 py-3 text-left font-medium">Exit</th>
                <th className="px-4 py-3 text-left font-medium">Profit</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const side = String(t.side ?? "").toUpperCase(); // "CALL" | "PUT"
                const entry =
                  t.entry_price ?? t.entry ?? t.open_price ?? t.open ?? null;
                const exit =
                  t.exit_price ?? t.exit ?? t.close_price ?? t.close ?? null;
                const profitNum = Number(t.profit ?? 0);
                const won = profitNum > 0;
                const isClosed = Boolean(t.closed_at ?? t.exit ?? t.exit_price);

                return (
                  <tr key={t.id} className="border-b border-border/40">
                    <td className="px-4 py-3">{formatTime(t.opened_at ?? t.created_at)}</td>
                    <td className="px-4 py-3 font-medium">{t.symbol ?? "-"}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                          side === "CALL"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                            : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            side === "CALL" ? "bg-emerald-400" : "bg-rose-400"
                          }`}
                        />
                        {side || "-"}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums">{formatPrice(entry)}</td>
                    <td className="px-4 py-3 tabular-nums">{formatPrice(exit)}</td>
                    <td
                      className={`px-4 py-3 tabular-nums font-semibold ${
                        profitNum > 0
                          ? "text-emerald-400"
                          : profitNum < 0
                          ? "text-rose-400"
                          : "text-muted-foreground"
                      }`}
                    >
                      {formatProfit(profitNum)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center justify-center rounded-md px-2 py-1 text-xs font-medium ${
                          isClosed
                            ? won
                              ? "bg-emerald-500/15 text-emerald-300"
                              : "bg-rose-500/15 text-rose-300"
                            : "bg-yellow-500/15 text-yellow-300"
                        }`}
                      >
                        {isClosed ? (won ? "WON" : "LOST") : "OPEN"}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-muted-foreground" colSpan={7}>
                    No trades yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}