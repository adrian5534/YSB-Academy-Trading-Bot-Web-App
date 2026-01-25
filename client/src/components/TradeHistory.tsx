import { useTrades } from "@/hooks/use-trades";

export function TradeHistory() {
  const { data: trades, isLoading } = useTrades();

  if (isLoading) return <div className="rounded-2xl border border-border bg-card p-4 text-muted-foreground">Loading…</div>;

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="font-semibold mb-2">Trade History</div>
      <div className="space-y-2">
        {(trades ?? []).slice(0, 12).map((t) => (
          <div key={t.id} className="rounded-lg border border-border bg-background px-3 py-2">
            <div className="flex items-center justify-between">
              <div className="font-medium">
                {t.symbol} • {t.side.toUpperCase()}
              </div>
              <div className="text-xs text-muted-foreground">{t.mode}</div>
            </div>
            <div className="text-xs text-muted-foreground">{t.strategy_id} • {t.timeframe}</div>
            <div className="text-xs text-muted-foreground">PnL: {t.profit ?? 0}</div>
          </div>
        ))}
        {(trades ?? []).length === 0 ? <div className="text-sm text-muted-foreground">No trades yet.</div> : null}
      </div>
    </div>
  );
}
