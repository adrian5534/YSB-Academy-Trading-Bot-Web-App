import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useTrades } from "@/hooks/use-trades";

type EquityPoint = { t: string; ts: number; v: number };

function toTs(v: any): number | null {
  if (!v) return null;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

function isClosedTrade(t: any): boolean {
  return Boolean(t?.closed_at ?? t?.exit ?? t?.exit_price ?? t?.closed);
}

function tradeCloseTs(t: any): number | null {
  // Prefer an explicit close timestamp if present; otherwise fall back.
  return (
    toTs(t?.closed_at) ??
    toTs(t?.exit_at) ??
    toTs(t?.updated_at) ??
    toTs(t?.created_at) ??
    null
  );
}

function buildEquityCurve(trades: any[], baseEquity = 0): EquityPoint[] {
  const closed = (trades ?? [])
    .filter(isClosedTrade)
    .map((t) => {
      const ts = tradeCloseTs(t);
      const profit = Number(t?.profit ?? 0);
      return {
        ts,
        profit: Number.isFinite(profit) ? profit : 0,
      };
    })
    .filter((x) => x.ts != null)
    .sort((a, b) => (a.ts as number) - (b.ts as number));

  let equity = Number(baseEquity) || 0;

  const points: EquityPoint[] = closed.map((x) => {
    equity += x.profit;
    const d = new Date(x.ts as number);
    return { ts: x.ts as number, t: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), v: +equity.toFixed(2) };
  });

  return points;
}

export function LiveChart({
  trades,
  baseEquity = 0,
  title = "Equity Curve",
}: {
  trades?: any[];
  baseEquity?: number;
  title?: string;
}) {
  // Backward compatible: if not provided, fetch trades here
  const { data: fetchedTrades } = useTrades();
  const sourceTrades = trades ?? (fetchedTrades as any[]) ?? [];

  const data = useMemo(() => buildEquityCurve(sourceTrades, baseEquity), [sourceTrades, baseEquity]);

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="font-semibold mb-2">{title}</div>

      <div className="h-64">
        {data.length === 0 ? (
          <div className="h-full grid place-items-center text-sm text-muted-foreground">No closed trades yet</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <XAxis dataKey="t" hide />
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Tooltip
                formatter={(val: any) => [`$${Number(val).toFixed(2)}`, "Equity"]}
                labelFormatter={(label: any) => `Time: ${label}`}
              />
              <Area dataKey="v" type="monotone" stroke="rgba(167, 139, 250, 0.95)" fill="rgba(167, 139, 250, 0.18)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="text-xs text-muted-foreground mt-2">Cumulative PnL over closed trades.</div>
    </div>
  );
}
