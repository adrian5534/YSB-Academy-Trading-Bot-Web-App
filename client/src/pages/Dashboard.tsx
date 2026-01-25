import { motion } from "framer-motion";
import { Activity, DollarSign, Target, TrendingUp } from "lucide-react";
import { StatCard } from "@/components/StatCard";
import { LiveChart } from "@/components/LiveChart";
import { TradeHistory } from "@/components/TradeHistory";
import { useTradeStats } from "@/hooks/use-trades";
import { useBotStatus } from "@/hooks/use-bots";

export default function Dashboard() {
  const { data: stats } = useTradeStats();
  const { data: bot } = useBotStatus();

  const profitTrend = (stats?.totalProfit || 0) >= 0 ? "up" : "down";
  const profitColor = (stats?.totalProfit || 0) >= 0 ? "text-green-500" : "text-red-500";

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
      </motion.div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total PnL"
          value={`${(stats?.totalProfit ?? 0).toFixed(2)}`}
          icon={<DollarSign className="h-4 w-4" />}
          trend={profitTrend}
          trendValue={`${profitTrend === "up" ? "+" : ""}${(stats?.totalProfit ?? 0).toFixed(2)}`}
          valueClass={profitColor}
        />
        <StatCard
          title="Win Rate"
          value={`${((stats?.winRate ?? 0) * 100).toFixed(1)}%`}
          icon={<Target className="h-4 w-4" />}
          trend="up"
          trendValue="Live"
        />
        <StatCard
          title="Profit Factor"
          value={`${(stats?.profitFactor ?? 0).toFixed(2)}`}
          icon={<TrendingUp className="h-4 w-4" />}
          trend="up"
          trendValue="Rolling"
        />
        <StatCard
          title="Active Bots"
          value={`${bot?.active_configs ?? 0}`}
          icon={<Activity className="h-4 w-4" />}
          trend={bot?.state === "running" ? "up" : "down"}
          trendValue={bot?.state ?? "stopped"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <LiveChart />
        <TradeHistory />
      </div>
    </div>
  );
}
