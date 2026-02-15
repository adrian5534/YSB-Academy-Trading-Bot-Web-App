import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type EquityPoint = { t: string; ts: number; v: number };

function toTs(v: any): number | null {
  if (v == null || v === "") return null;

  // handle epoch seconds/ms (number or numeric string)
  const raw = typeof v === "number" ? v : String(v).trim();
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return raw < 2e10 ? raw * 1000 : raw; // assume seconds if small
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n < 2e10 ? n * 1000 : n;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function isClosedTrade(t: any): boolean {
  return Boolean(t?.closed_at ?? t?.exit_at ?? t?.exit ?? t?.exit_price ?? t?.closed);
}

function tradeCloseTs(t: any): number | null {
  return (
    toTs(t?.closed_at) ??
    toTs(t?.exit_at) ??
    toTs(t?.updated_at) ??
    toTs(t?.created_at) ??
    null
  );
}

function sumClosedProfit(trades: any[]): number {
  return (trades ?? [])
    .filter(isClosedTrade)
    .reduce((s, t) => {
      const p = Number(t?.profit ?? 0);
      return s + (Number.isFinite(p) ? p : 0);
    }, 0);
}

function buildEquityCurve(trades: any[], baseEquity = 0): EquityPoint[] {
  const closed = (trades ?? [])
    .filter(isClosedTrade)
    .map((t) => {
      const ts = tradeCloseTs(t);
      const profit = Number(t?.profit ?? 0);
      return { ts, profit: Number.isFinite(profit) ? profit : 0 };
    })
    .filter((x) => x.ts != null)
    .sort((a, b) => (a.ts as number) - (b.ts as number));

  let equity = Number(baseEquity) || 0;

  const fmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

  const points: EquityPoint[] = closed.map((x) => {
    equity += x.profit;
    const d = new Date(x.ts as number);
    return { ts: x.ts as number, t: fmt.format(d), v: +equity.toFixed(2) };
  });

  return points;
}

export function LiveChart({
  trades,
  baseEquity = 0,
  currentEquity,
  title = "Equity Curve",
}: {
  trades: any[];
  baseEquity?: number;
  currentEquity?: number | null;
  title?: string;
}) {
  const startEquity = useMemo(() => {
    if (currentEquity == null) return baseEquity;
    const closedPnl = sumClosedProfit(trades);
    const start = Number(currentEquity) - closedPnl;
    return Number.isFinite(start) ? start : baseEquity;
  }, [currentEquity, baseEquity, trades]);

  const data = useMemo(() => buildEquityCurve(trades, startEquity), [trades, startEquity]);

  return (
    <div className="live-chart rounded-2xl border border-border bg-card p-4">
      <div className="live-chart__title font-semibold mb-2">{title}</div>

      {/* was: className="h-64" */}
      <div className="live-chart__plot">
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
              <Area
                dataKey="v"
                type="monotone"
                stroke="rgba(167, 139, 250, 0.95)"
                fill="rgba(167, 139, 250, 0.18)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="live-chart__footer text-xs text-muted-foreground mt-2">
        Built from closed trades; aligns to current balance if provided.
      </div>
    </div>
  );
}
