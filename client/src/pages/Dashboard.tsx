import "@/styles/dashboard.css";
import { motion } from "framer-motion";
import { Activity, DollarSign, Target, TrendingUp, Wallet, RefreshCw } from "lucide-react";
import { StatCard } from "@/components/StatCard";
import { LiveChart } from "@/components/LiveChart";
import { TradeHistory } from "@/components/TradeHistory";
import { useTrades } from "@/hooks/use-trades";
import { useBotStatus } from "@/hooks/use-bots";
import { useEffect, useMemo, useState } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useAccountBalances } from "@/hooks/use-account-balances";

type ModeFilter = "all" | "paper" | "live" | "backtest";

export default function Dashboard() {
  // Replace useTradeStats with local calc over fetched trades so we can filter by mode
  const { data: trades } = useTrades();
  const { data: bot } = useBotStatus();
  const { data: accounts } = useAccounts();

  // Live balances via apiFetch (keeps cookies/auth)
  const { data: acctBalances } = useAccountBalances();

  // Persisted filter: mode
  const [mode, setMode] = useState<ModeFilter>(() => {
    try {
      if (typeof window === "undefined") return "paper";
      const v = localStorage.getItem("dashboard:mode");
      return v === "all" || v === "paper" || v === "live" || v === "backtest" ? (v as ModeFilter) : "paper";
    } catch {
      return "paper";
    }
  });
  // Persisted filter: account
  const [accountId, setAccountId] = useState<string>(() => {
    try {
      if (typeof window === "undefined") return "all";
      return localStorage.getItem("dashboard:accountId") || "all";
    } catch {
      return "all";
    }
  }); // "all" or specific account id

  // Save filters on change
  useEffect(() => {
    try {
      localStorage.setItem("dashboard:mode", mode);
    } catch {}
  }, [mode]);
  useEffect(() => {
    try {
      localStorage.setItem("dashboard:accountId", accountId);
    } catch {}
  }, [accountId]);

  // If selected account no longer exists, fallback to "all"
  useEffect(() => {
    if (!accounts || accountId === "all") return;
    const exists = (accounts as any[]).some((a) => a.id === accountId);
    if (!exists) setAccountId("all");
  }, [accounts, accountId]);

  const filteredTrades = useMemo(() => {
    const byMode = (trades ?? []).filter((t: any) =>
      mode === "all" ? true : String(t.mode ?? "").toLowerCase() === mode
    );
    return byMode.filter((t: any) => (accountId === "all" ? true : t.account_id === accountId));
  }, [trades, mode, accountId]);

  const {
    totalProfit,
    winRate,
    profitFactor,
    openTrades,
    closedTrades,
  } = useMemo(() => {
    const list = filteredTrades;

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
  }, [filteredTrades]);

  // Account balance (filtered by selected account) – prefer live balances
  const accountBalance = useMemo(() => {
    const bals = (acctBalances as any[]) ?? [];
    const allAccounts = (accounts as any[]) ?? [];

    const selected =
      accountId === "all" ? null : allAccounts.find((a) => String(a?.id) === String(accountId)) || null;
    const selectedType = selected?.type as string | undefined;

    const toNum = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    // ✅ gather possible identifiers that the balances API might be using
    const candidateIds = new Set(
      [
        accountId,
        selected?.id,
        selected?.account_id,
        selected?.provider_account_id,
        selected?.external_id,
        selected?.loginid,
        selected?.deriv_loginid,
        selected?.deriv_account_id,
      ]
        .map((x) => (x == null ? "" : String(x)))
        .filter((s) => s && s !== "undefined" && s !== "null")
    );

    const balRowId = (a: any) =>
      String(a?.id ?? a?.account_id ?? a?.provider_account_id ?? a?.external_id ?? a?.loginid ?? "");

    if (bals.length) {
      if (accountId === "all") {
        const total = bals.reduce((s, a) => s + (toNum(a?.balance) ?? 0), 0);
        return { value: total, label: "Account Balance (All)" };
      }

      // ✅ robust match (handles DB id vs provider id mismatches)
      const row = bals.find((a) => candidateIds.has(balRowId(a)));
      const balNum = row ? toNum(row.balance) : null;

      if (balNum != null) {
        return {
          value: balNum,
          label: `Balance • ${row?.label ?? selected?.label ?? "Account"}${row?.currency ? ` (${row.currency})` : ""}`,
        };
      }

      if (selectedType && selectedType !== "deriv") {
        return { value: null, label: "Balance (Not available for this account type)" };
      }

      return { value: null, label: "Balance (Reconnect Deriv token or refresh)" };
    }

    if (mode === "paper") {
      const base = 10000;
      return { value: base + totalProfit, label: accountId === "all" ? "Paper Balance (All)" : "Paper Balance" };
    }
    return { value: null, label: "Account Balance" };
  }, [acctBalances, accounts, accountId, mode, totalProfit]);

  const profitTrend = totalProfit >= 0 ? "up" : "down";
  const profitColor = totalProfit >= 0 ? "text-green-500" : "text-red-500";

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex items-end justify-between gap-3 flex-wrap"
      >
        <div>
          <div className="text-2xl font-semibold">Dashboard</div>
          <div className="text-sm text-muted-foreground">
            {bot?.state === "running" ? "Bot running • live logs & trades stream" : "Bot stopped • configure and start"}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Account selector */}
          <select
            className="rounded-lg border border-border bg-card px-3 py-1 text-sm"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            title="Filter by account"
          >
            <option value="all">All Accounts</option>
            {(accounts ?? []).map((a: any) => (
              <option key={a.id} value={a.id}>
                {a.label ?? a.id}
              </option>
            ))}
          </select>

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
        </div>
      </motion.div>

      {/* Stats grid: keep iPad at 3 cols, only go 6 cols on xl+ */}
      <div className="dashboard-stats grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
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

      {/* Panels: stack on iPad, only side-by-side on xl+ */}
      <div className="dashboard-panels grid gap-4 xl:grid-cols-2">
        <LiveChart
          trades={filteredTrades}
          baseEquity={mode === "paper" ? 10000 : 0}
          currentEquity={mode === "paper" ? null : accountBalance.value}
          title="Equity Curve"
        />

        <TradeHistory mode={mode} accountId={accountId === "all" ? undefined : accountId} />
      </div>
    </div>
  );
}