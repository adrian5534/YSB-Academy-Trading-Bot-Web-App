import { motion } from "framer-motion";
import { Activity, DollarSign, Target, TrendingUp, Wallet, RefreshCw } from "lucide-react";
import { StatCard } from "@/components/StatCard";
import { LiveChart } from "@/components/LiveChart";
import { TradeHistory } from "@/components/TradeHistory";
import { useTrades } from "@/hooks/use-trades";
import { useBotStatus } from "@/hooks/use-bots";
import { useState, useMemo } from "react";
import { useAccounts } from "@/hooks/use-accounts";

type ModeFilter = "all" | "paper" | "live" | "backtest";

export default function Dashboard() {
  // Replace useTradeStats with local calc over fetched trades so we can filter by mode
  const { data: trades } = useTrades();
  const { data: bot } = useBotStatus();
  const { data: accounts } = useAccounts();

  const [mode, setMode] = useState<ModeFilter>("paper");

  const {
    totalProfit,
    winRate,
    profitFactor,
    openTrades,
    closedTrades,
  } = useMemo(() => {
    const list = (trades ?? []).filter((t: any) =>
      mode === "all" ? true : String(t.mode ?? "").toLowerCase() === mode
    );

    const isClosed = (t: any) => !!(t.closed_at ?? t.exit ?? t.exit_price);
    const profitNum = (t: any) => Number(t.profit ?? 0);

    const closed = list.filter(isClosed);
    const open = list.filter((t) => !isClosed(t));

    const pnl = closed.reduce((s, t) => s + (Number.isFinite(profitNum(t)) ? profitNum(t) : 0), 0);

    const wins = closed.filter((t) => profitNum(t) > 0).length;
    const losses = closed.filter((t) => profitNum(t) < 0).length;
    const grossWin = closed.filter((t) => profitNum(t) > 0).reduce((s, t) => s + profitNum(t), 0);
    const grossLossAbs = Math.abs(
      closed.filter((t) => profitNum(t) < 0).reduce((s, t) => s + profitNum(t), 0)
    );

    const wr = closed.length > 0 ? wins / closed.length : 0;
    const pf = grossLossAbs > 0 ? grossWin / grossLossAbs : wins > 0 && losses === 0 ? Infinity : 0;

    return {
      totalProfit: pnl,
      winRate: wr,
      profitFactor: pf,
      openTrades: open.length,
      closedTrades: closed.length,
    };
  }, [trades, mode]);

  // Account balance
  // - If accounts include balance, show sum for visibility
  // - Else if mode === "paper", show a derived paper balance (base 10,000 + PnL)
  // - Else show "—"
  const accountBalance = useMemo(() => {
    const hasReal = (accounts ?? []).some((a: any) => typeof a.balance === "number");
    if (hasReal) {
      const total = (accounts ?? []).reduce((s: number, a: any) => s + (Number(a.balance) || 0), 0);
      return { value: total, label: "Account Balance" };
    }
    if (mode === "paper") {
      const base = 10000; // display-only derived paper balance
      return { value: base + totalProfit, label: "Paper Balance" };
    }
    return { value: null, label: "Account Balance" };
  }, [accounts, mode, totalProfit]);

  const profitTrend = totalProfit >= 0 ? "up" : "down";
  const profitColor = totalProfit >= 0 ? "text-green-500" : "text-red-500";

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex items-end justify-between"
      >
        <div>
          <div className="text-2xl font-semibold">Dashboard</div>
          <div className="text-sm text-muted-foreground">
            {bot?.state === "running" ? "Bot running • live logs & trades stream" : "Bot stopped • configure and start"}
          </div>
        </div>

        {/* Mode switcher */}
        <div className="inline-flex rounded-lg border border-border bg-card p-1 text-xs">
          {(["all", "paper", "live", "backtest"] as ModeFilter[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1 rounded-md capitalize ${
                mode === m ? "bg-ysbPurple text-ysbYellow" : "text-muted-foreground hover:text-foreground"
              }`}
              title={`Show ${m} trades`}
            >
              {m}
            </button>
          ))}
        </div>
      </motion.div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
        <StatCard
          title="Total PnL"
          value={`${totalProfit.toFixed(2)}`}
          icon={<DollarSign className="h-4 w-4" />}
          trend={profitTrend as "up" | "down"}
          trendValue={`${profitTrend === "up" ? "+" : ""}${totalProfit.toFixed(2)}`}
          valueClass={profitColor}
        />
        <StatCard
          title="Win Rate"
          value={`${(winRate * 100).toFixed(1)}%`}
          icon={<Target className="h-4 w-4" />}
          trend="up"
          trendValue="Rolling"
        />
        <StatCard
          title="Profit Factor"
          value={`${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}`}
          icon={<TrendingUp className="h-4 w-4" />}
          trend="up"
          trendValue="Mode"
        />
        <StatCard
          title="Open Trades"
          value={`${openTrades}`}
          icon={<RefreshCw className="h-4 w-4" />}
          trend={openTrades > 0 ? "up" : "down"}
          trendValue={openTrades > 0 ? "Active" : "Idle"}
        />
        <StatCard
          title="Closed Trades"
          value={`${closedTrades}`}
          icon={<Activity className="h-4 w-4" />}
          trend="up"
          trendValue="Total"
        />
        <StatCard
          title={accountBalance.label}
          value={accountBalance.value == null ? "—" : `$${accountBalance.value.toFixed(2)}`}
          icon={<Wallet className="h-4 w-4" />}
          trend="up"
          trendValue={mode.charAt(0).toUpperCase() + mode.slice(1)}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <LiveChart />
        <TradeHistory mode={mode} />
      </div>
    </div>
  );
}
