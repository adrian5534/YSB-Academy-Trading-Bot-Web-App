import { useEffect, useMemo, useState } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useStartBot, useStopBot, useBotStatus } from "@/hooks/use-bots";
import { useSubscription } from "@/hooks/use-subscription";
import { connectWs } from "@/lib/ws";
import { useToast } from "@/hooks/use-toast";
import { api } from "@shared/routes";

export default function BotCenter() {
  const { toast } = useToast();
  const { data: accounts } = useAccounts();
  const { data: sub } = useSubscription();
  const { data: status } = useBotStatus();
  const startBot = useStartBot();
  const stopBot = useStopBot();

  const derivAccounts = useMemo(() => (accounts ?? []).filter((a) => a.type === "deriv"), [accounts]);

  const [accountId, setAccountId] = useState<string>("");
  const [symbol, setSymbol] = useState("R_100");
  const [timeframe, setTimeframe] = useState("1m");
  const [strategyId, setStrategyId] = useState("trend_confirmation");
  const [mode, setMode] = useState<"backtest" | "paper" | "live">("paper");
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    const ws = connectWs((evt) => {
      if (evt.type === "bot.log") {
        const msg = (evt.payload as any)?.message ?? JSON.stringify(evt.payload);
        setLogs((l) => [String(msg), ...l].slice(0, 200));
      }
      if (evt.type === "trade.event") {
        setLogs((l) => [`TRADE: ${JSON.stringify(evt.payload)}`, ...l].slice(0, 200));
      }
    });
    ws.addEventListener("open", () => setLogs((l) => ["WS connected", ...l]));
    ws.addEventListener("close", () => setLogs((l) => ["WS disconnected", ...l]));
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (!accountId && derivAccounts.length) setAccountId(derivAccounts[0].id);
  }, [accountId, derivAccounts]);

  const start = async () => {
    try {
      const payload = api.bots.start.input.parse({
        name: "YSB Bot",
        configs: [
          {
            account_id: accountId,
            symbol,
            timeframe,
            strategy_id: strategyId,
            mode,
            params: {},
            enabled: true,
          },
        ],
      });
      await startBot.mutateAsync(payload);
      toast({ title: "Bot started", description: "Streaming logs via WebSocket." });
    } catch (e: any) {
      toast({ title: "Start failed", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  const stop = async () => {
    try {
      await stopBot.mutateAsync();
      toast({ title: "Bot stopped" });
    } catch (e: any) {
      toast({ title: "Stop failed", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-2xl font-semibold">Bot Control Center</div>
        <div className="text-sm text-muted-foreground">
          Subscription: <span className="text-foreground">{sub?.plan ?? "free"}</span> • Server-enforced gating for Paper/Live.
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
          <div className="font-semibold">Runner</div>

          <label className="block text-sm">Account</label>
          <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {(derivAccounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-sm">Symbol</label>
              <input className="w-full rounded-lg border border-border bg-background px-3 py-2" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm">Timeframe</label>
              <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                {["1m","3m","5m","15m","30m","1h","2h","4h","1d"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm">Mode</label>
              <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={mode} onChange={(e) => setMode(e.target.value as any)}>
                <option value="backtest">Backtest</option>
                <option value="paper">Paper</option>
                <option value="live">Live</option>
              </select>
            </div>
          </div>

          <label className="block text-sm">Strategy</label>
          <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
            {["candle_pattern","one_hour_trend","trend_confirmation","scalping_hwr","trend_pullback","supply_demand_sweep","fvg_retracement","range_mean_reversion"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <div className="flex items-center gap-2">
            <button onClick={start} className="rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow hover:opacity-90">
              Start
            </button>
            <button onClick={stop} className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
              Stop
            </button>
            <div className="ml-auto text-xs text-muted-foreground">
              Status: <span className="text-foreground">{status?.state ?? "stopped"}</span>
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            Note: Paper/Live require Pro plan. Server returns 402 if blocked.
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="font-semibold mb-2">Live logs</div>
          <div className="h-96 overflow-auto rounded-lg border border-border bg-background p-2 font-mono text-xs text-muted-foreground">
            {logs.map((l, i) => <div key={i} className="whitespace-pre-wrap">{l}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
