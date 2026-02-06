import { useEffect, useMemo, useState } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useStartBot, useStopBot, useBotStatus } from "@/hooks/use-bots";
import { useSubscription } from "@/hooks/use-subscription";
import { useToast } from "@/hooks/use-toast";
import { api } from "@shared/routes";
import { useRuntimeEvents } from "@/context/runtime-events";
import { apiFetch } from "@/lib/api";

export default function BotCenter() {
  const { toast } = useToast();
  const { data: accounts } = useAccounts();
  const { data: sub } = useSubscription();
  const { data: status } = useBotStatus();
  const startBot = useStartBot();
  const stopBot = useStopBot();

  const { logs, connected, clearLogs } = useRuntimeEvents();

  const availableAccounts = useMemo(() => accounts ?? [], [accounts]);
  const [accountId, setAccountId] = useState<string>("");
  const [symbol, setSymbol] = useState("R_100");
  const [timeframe, setTimeframe] = useState("1m");
  const [strategyId, setStrategyId] = useState("RSI");
  const [mode, setMode] = useState<"backtest" | "paper" | "live">("paper");
  const [params, setParams] = useState({
    stake: 250,
    rsiPeriod: 8,
    overbought: 70,
    oversold: 30,
    duration: 5,
    duration_unit: "m" as "m" | "h" | "d",
  });
  const [showSettings, setShowSettings] = useState(false);

  // default account
  useEffect(() => {
    if (!accountId && availableAccounts.length) setAccountId(availableAccounts[0].id);
  }, [availableAccounts, accountId]);

  // load saved settings for this combo
  useEffect(() => {
    (async () => {
      if (!accountId) return;
      try {
        const r = await fetch(`/api/strategies/settings/${accountId}`);
        const list = (await r.json()) as any[];
        const found = list.find(
          (s) =>
            s.symbol === symbol &&
            s.timeframe === timeframe &&
            s.strategy_id === strategyId
        );
        if (found?.params) setParams((p) => ({ ...p, ...found.params }));
      } catch {}
    })();
  }, [accountId, symbol, timeframe, strategyId]);

  const persistSettings = async (next = params) => {
    if (!accountId) return;
    try {
      await fetch(`/api/strategies/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          symbol,
          timeframe,
          strategy_id: strategyId,
          params: next,
          enabled: true,
        }),
      });
    } catch {}
  };

  const isPro = sub?.plan === "pro";

  const start = async () => {
    try {
      if (!isPro && (mode === "paper" || mode === "live")) {
        toast({ title: "Upgrade required", description: "Paper/Live trading requires Pro plan.", variant: "destructive" });
        return;
      }
      // persist then start
      await persistSettings();
      await startBot.mutateAsync({
        name: "YSB Bot",
        configs: [
          {
            account_id: accountId,
            symbol,
            timeframe,
            strategy_id: strategyId,
            mode,
            params, // includes stake + duration
            enabled: true,
          },
        ],
      });
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

  const upgradeToPro = async () => {
    try {
      const res = await apiFetch(api.stripe.createCheckout.path, {
        method: "POST",
        body: JSON.stringify({ return_url: window.location.href }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.url) window.open(j.url, "_blank");
      else throw new Error("No checkout URL returned");
    } catch (e: any) {
      toast({ title: "Checkout error", description: String(e?.message ?? e), variant: "destructive" });
    }
  };

  const manageBilling = async () => {
    try {
      const res = await apiFetch("/api/stripe/portal", {
        method: "POST",
        body: JSON.stringify({ return_url: window.location.href }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.url) window.open(j.url, "_blank");
      else throw new Error("No portal URL returned");
    } catch (e: any) {
      toast({ title: "Billing portal error", description: String(e?.message ?? e), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-2xl font-semibold">Control Panel</div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status?.state === "running" ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-600/20 text-zinc-300"}`}>
          {status?.state === "running" ? "RUNNING" : "STOPPED"}
        </span>
      </div>
      <div className="text-sm text-muted-foreground">Manage strategy & execution</div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-border bg-background p-3">
              <div className="text-sm text-muted-foreground">Strategy</div>
              <div className="mt-1 font-mono text-lg">{strategyId.toUpperCase()}</div>
            </div>
            <div className="rounded-xl border border-border bg-background p-3">
              <div className="text-sm text-muted-foreground">Stake</div>
              <div className="mt-1 font-mono text-lg">${params.stake}</div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-background p-3">
            <div className="text-sm text-muted-foreground mb-2">RSI Settings</div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono">
              <div>Period: <span className="text-foreground">{params.rsiPeriod}</span></div>
              <div>OB: <span className="text-rose-400">{params.overbought}</span></div>
              <div>OS: <span className="text-emerald-400">{params.oversold}</span></div>
              <div>Expiry: <span className="text-foreground">{params.duration}{params.duration_unit}</span></div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-sm">Account</label>
              <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {availableAccounts.map((a: any) => (
                  <option key={a.id} value={a.id}>{a.label} {a.type ? `(${a.type})` : ""}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm">Symbol</label>
              <input className="w-full rounded-lg border border-border bg-background px-3 py-2" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm">Timeframe</label>
              <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                {["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm">Strategy</label>
            <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
              {["candle_pattern", "one_hour_trend", "trend_confirmation", "scalping_hwr", "trend_pullback", "supply_demand_sweep", "fvg_retracement", "range_mean_reversion"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={start} disabled={!isPro && (mode === "paper" || mode === "live")} className={`rounded-lg px-3 py-2 font-semibold ${!isPro && (mode === "paper" || mode === "live") ? "border border-border bg-muted text-muted-foreground cursor-not-allowed" : "bg-ysbPurple text-ysbYellow hover:opacity-90"}`}>
              {status?.state === "running" ? "RESTART" : "START"}
            </button>
            <button onClick={stop} className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground">Stop</button>
            <div className="ml-auto flex items-center gap-2">
              <select className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value as any)}>
                <option value="backtest">Backtest</option>
                <option value="paper" disabled={!isPro}>Paper{!isPro ? " (Pro only)" : ""}</option>
                <option value="live" disabled={!isPro}>Live{!isPro ? " (Pro only)" : ""}</option>
              </select>
              <button type="button" onClick={() => setShowSettings(true)} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" title="Strategy settings">
                ⚙️
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">Live logs</div>
            <button onClick={clearLogs} className="rounded-lg border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground" type="button">
              Clear
            </button>
          </div>
          <div className="h-96 overflow-auto rounded-lg border border-border bg-background p-2 font-mono text-xs text-muted-foreground">
            {logs.slice(0, 200).map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                <span className="text-muted-foreground">{new Date(l.ts).toLocaleTimeString()} </span>
                {l.message}
              </div>
            ))}
          </div>
        </div>
      </div>

      {showSettings && (
        <StrategySettingsModal
          params={params}
          onClose={() => setShowSettings(false)}
          onSave={(next) => {
            setParams(next);
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}

function StrategySettingsModal({ params, onSave, onClose }: {
  params: { stake: number; rsiPeriod: number; overbought: number; oversold: number; duration: number; duration_unit: "m"|"h"|"d" };
  onSave: (p: any) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState(params);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-5">
        <div className="text-xl font-semibold mb-1">Strategy Configuration</div>
        <div className="text-sm text-muted-foreground mb-4">Adjust the parameters.</div>

        <div className="space-y-3">
          <div>
            <label className="block text-sm mb-1">Stake ($)</label>
            <input type="number" className="w-full rounded-lg border border-border bg-background px-3 py-2"
              value={form.stake} onChange={(e) => setForm({ ...form, stake: Number(e.target.value) })}/>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="block text-sm mb-1">RSI Period</label>
              <input type="number" className="w-full rounded-lg border border-border bg-background px-3 py-2"
                value={form.rsiPeriod} onChange={(e) => setForm({ ...form, rsiPeriod: Number(e.target.value) })}/>
            </div>
            <div>
              <label className="block text-sm mb-1">Overbought</label>
              <input type="number" className="w-full rounded-lg border border-border bg-background px-3 py-2"
                value={form.overbought} onChange={(e) => setForm({ ...form, overbought: Number(e.target.value) })}/>
            </div>
            <div>
              <label className="block text-sm mb-1">Oversold</label>
              <input type="number" className="w-full rounded-lg border border-border bg-background px-3 py-2"
                value={form.oversold} onChange={(e) => setForm({ ...form, oversold: Number(e.target.value) })}/>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="block text-sm mb-1">Expiry Duration</label>
              <input type="number" className="w-full rounded-lg border border-border bg-background px-3 py-2"
                value={form.duration} onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })}/>
            </div>
            <div>
              <label className="block text-sm mb-1">Unit</label>
              <select className="w-full rounded-lg border border-border bg-background px-3 py-2"
                value={form.duration_unit} onChange={(e) => setForm({ ...form, duration_unit: e.target.value as any })}>
                <option value="m">Minutes</option>
                <option value="h">Hours</option>
                <option value="d">Days</option>
              </select>
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={onClose}>
            Cancel
          </button>
          <button className="rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow hover:opacity-90" onClick={() => onSave(form)}>
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}