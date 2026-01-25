import { useState } from "react";
import { api } from "@shared/routes";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

export default function Backtesting() {
  const { toast } = useToast();
  const [csv, setCsv] = useState("");
  const [symbol, setSymbol] = useState("R_100");
  const [timeframe, setTimeframe] = useState("1m");
  const [strategy, setStrategy] = useState("trend_confirmation");
  const [result, setResult] = useState<any>(null);

  const run = async () => {
    try {
      const payload = api.backtests.run.input.parse({
        strategy_id: strategy,
        symbol,
        timeframe,
        params: {},
        csv,
      });
      const res = await apiFetch(api.backtests.run.path, { method: "POST", body: JSON.stringify(payload) });
      const data = api.backtests.run.responses[200].parse(await res.json());
      setResult(data);
    } catch (e: any) {
      toast({ title: "Backtest failed", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-2xl font-semibold">Backtesting</div>
        <div className="text-sm text-muted-foreground">Upload/paste CSV and run strategies locally on server.</div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
        <div className="grid gap-2 md:grid-cols-3">
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
            <label className="block text-sm">Strategy</label>
            <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {["candle_pattern","one_hour_trend","trend_confirmation","scalping_hwr","trend_pullback","supply_demand_sweep","fvg_retracement","range_mean_reversion"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        <label className="block text-sm">CSV (timestamp,open,high,low,close,volume)</label>
        <textarea className="w-full h-52 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} />

        <button onClick={run} className="rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow hover:opacity-90">
          Run backtest
        </button>
      </div>

      {result ? (
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="font-semibold mb-2">Results</div>
          <pre className="overflow-auto rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">
{JSON.stringify(result, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
