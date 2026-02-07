import { useEffect, useMemo } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useStartBot, useStopBot, useBotStatus } from "@/hooks/use-bots";
import { useSubscription } from "@/hooks/use-subscription";
import { useToast } from "@/hooks/use-toast";
import { api } from "@shared/routes";
import { STRATEGY_SETTINGS, EXECUTION_FIELDS, getStrategyDefaults } from "@shared/strategySettings";
import { useRuntimeEvents } from "@/context/runtime-events";
import { apiFetch } from "@/lib/api";
import { useKeepAlive } from "@/hooks/use-keep-alive";
import { usePersistedState } from "@/hooks/use-persisted-state";
import { useState as reactUseState } from "react";

export default function BotCenter() {
  const { toast } = useToast();
  const { data: accounts } = useAccounts();
  const { data: sub } = useSubscription();
  const { data: status } = useBotStatus();
  const startBot = useStartBot();
  const stopBot = useStopBot();

  const { logs, connected, clearLogs } = useRuntimeEvents();

  const availableAccounts = useMemo(() => accounts ?? [], [accounts]);
  const [accountId, setAccountId] = usePersistedState<string>("bot:accountId", "");
  const [symbol, setSymbol] = usePersistedState<string>("bot:symbol", "R_100");
  const [timeframe, setTimeframe] = usePersistedState<string>("bot:timeframe", "1m");
  const [strategyId, setStrategyId] = usePersistedState<string>("bot:strategyId", "");
  const [mode, setMode] = usePersistedState<"backtest" | "paper" | "live">("bot:mode", "paper");
  const [params, setParams] = usePersistedState<Record<string, any>>("bot:params", {
    stake: 250,
    duration: 5,
    duration_unit: "m" as "m" | "h" | "d",
  });
  const [showSettings, setShowSettings] = usePersistedState<boolean>("bot:showSettings", false);

  // persistent list of user-defined bot configs (each bot is independent)
  const [bots, setBots] = usePersistedState<any[]>("bot:configs", []);
  const [editingBotId, setEditingBotId] = reactUseState<string | null>(null);

  // Keep server awake while this page is open (poll /api/health every 4 minutes)
  useKeepAlive(true, 240_000);

  // default account
  useEffect(() => {
    if (!accountId && availableAccounts.length) setAccountId(availableAccounts[0].id);
  }, [availableAccounts, accountId]);

  // helpers for bots list
  const makeId = () => String(Date.now()) + Math.random().toString(36).slice(2, 8);

  const addBotFromTemplate = () => {
    if (!accountId || !strategyId) {
      toast({ title: "Incomplete", description: "Select account and strategy before adding a bot.", variant: "destructive" });
      return;
    }
    const b = {
      id: makeId(),
      account_id: accountId,
      symbol,
      timeframe,
      strategy_id: strategyId,
      mode,
      params: { ...params },
      enabled: true,
    };
    setBots((s) => [...s, b]);
    toast({ title: "Bot added", description: `${b.symbol} / ${b.strategy_id}` });
  };

  const updateBot = (id: string, patch: Partial<any>) => setBots((s) => s.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const removeBot = (id: string) => setBots((s) => s.filter((b) => b.id !== id));

  const startSingle = async (botConfig: any) => {
    try {
      await persistSettings(botConfig.params);
      await startBot.mutateAsync({
        name: "YSB Bot",
        configs: [
          {
            account_id: botConfig.account_id,
            symbol: botConfig.symbol,
            timeframe: botConfig.timeframe,
            strategy_id: botConfig.strategy_id,
            mode: botConfig.mode,
            params: botConfig.params,
            enabled: true,
          },
        ],
      });
      toast({ title: "Bot started", description: `${botConfig.symbol} / ${botConfig.strategy_id}` });
    } catch (e: any) {
      toast({ title: "Start failed", description: String(e?.message ?? e), variant: "destructive" });
    }
  };

  const startAll = async () => {
    try {
      const valid = bots.filter((b) => b.account_id && b.strategy_id);
      if (!valid.length) {
        toast({ title: "No bots", description: "Add at least one complete bot (account + strategy).", variant: "destructive" });
        return;
      }
      // persist each settings (best-effort)
      await Promise.all(valid.map((c) =>
        apiFetch(api.strategies.setSettings.path, {
          method: "POST",
          body: JSON.stringify({
            account_id: c.account_id,
            symbol: c.symbol,
            timeframe: c.timeframe,
            strategy_id: c.strategy_id,
            params: c.params,
            enabled: true,
          }),
        }).catch(() => void 0)
      ));
      await startBot.mutateAsync({ name: "YSB Bot", configs: valid });
      toast({ title: "All bots started", description: `${valid.length} configs sent` });
    } catch (e: any) {
      toast({ title: "Start all failed", description: String(e?.message ?? e), variant: "destructive" });
    }
  };

  // set duration unit when timeframe changes (1s => ticks)
  useEffect(() => {
    setParams((p) => {
      if (timeframe === "1s") return { ...p, duration_unit: "t" as const, duration: Math.max(1, p.duration || 5) };
      if (timeframe.endsWith("m")) return { ...p, duration_unit: "m" as const };
      if (timeframe.endsWith("h")) return { ...p, duration_unit: "h" as const };
      if (timeframe.endsWith("d")) return { ...p, duration_unit: "d" as const };
      return p;
    });
  }, [timeframe]);

  // merge defaults for selected strategy; clear fields from previous strategy
  useEffect(() => {
    setParams((p) => {
      const exec = { stake: p.stake ?? 250, duration: p.duration ?? 5, duration_unit: p.duration_unit ?? (timeframe === "1s" ? "t" : "m") } as any;
      if (!strategyId) return exec;
      const defaults = getStrategyDefaults(strategyId);
      // drop previous strategy keys not in current strategy
      const allowedKeys = new Set(Object.keys(defaults).concat(EXECUTION_FIELDS.map((f) => f.key)));
      const next: Record<string, any> = {};
      for (const k of Object.keys(p)) if (allowedKeys.has(k)) next[k] = (p as any)[k];
      return { ...defaults, ...exec, ...next };
    });
  }, [strategyId, timeframe]);

  // load saved settings for this combo
   useEffect(() => {
     (async () => {
      if (!accountId || !strategyId) return;
       try {
         const path = api.strategies.settingsForAccount.path.replace(":accountId", accountId);
         const r = await apiFetch(path);
          const list = (await r.json()) as any[];
          const found = list.find((s) => s.symbol === symbol && s.timeframe === timeframe && s.strategy_id === strategyId);
          if (found?.params) setParams((p) => ({ ...p, ...found.params }));
        } catch {
          /* ignore */
        }
      })();
   }, [accountId, symbol, timeframe, strategyId]);
 
   const persistSettings = async (next = params) => {
     if (!accountId) return;
     try {
      await apiFetch(api.strategies.setSettings.path, {
         method: "POST",
         body: JSON.stringify({
           account_id: accountId,
           symbol,
           timeframe,
           strategy_id: strategyId,
           params: next,
           enabled: true,
         }),
       });
     } catch {
       /* ignore */
     }
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
            <div className="text-sm text-muted-foreground mb-2">Settings</div>
            {!strategyId ? (
              <div className="text-xs text-muted-foreground">Select a strategy to configure.</div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono">
                {Object.entries(params)
                  .filter(([k]) => !["stake", "duration", "duration_unit"].includes(k))
                  .slice(0, 5)
                  .map(([k, v]) => (
                    <div key={k}>
                      {k}: <span className="text-foreground">{String(v)}</span>
                    </div>
                  ))}
                <div>Expiry: <span className="text-foreground">{params.duration}{params.duration_unit}</span></div>
              </div>
            )}
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
                {["1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm">Strategy</label>
            <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
              <option value="">Select a strategy…</option>
              {["candle_pattern", "one_hour_trend", "trend_confirmation", "scalping_hwr", "trend_pullback", "supply_demand_sweep", "fvg_retracement", "range_mean_reversion"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => addBotFromTemplate()} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted">+ Add bot</button>
            <button onClick={startAll} disabled={!bots.length} className="rounded-lg px-3 py-2 font-semibold bg-ysbPurple text-ysbYellow hover:opacity-90">
              Start All
            </button>
            <button onClick={stop} className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground">Stop</button>
            <div className="ml-auto flex items-center gap-2">
              <select className="rounded-lg border border-border bg-background px-3 py-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value as any)}>
                <option value="backtest">Backtest</option>
                <option value="paper" disabled={!isPro}>Paper{!isPro ? " (Pro only)" : ""}</option>
                <option value="live" disabled={!isPro}>Live{!isPro ? " (Pro only)" : ""}</option>
              </select>
              <button type="button" onClick={() => strategyId && setShowSettings(true)} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted" title="Strategy settings" disabled={!strategyId}>
                ⚙️
              </button>
            </div>
          </div>
        </div>

        {/* Bots list */}
        <div className="col-span-2 rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">My Bots ({bots.length})</div>
          </div>
          <div className="space-y-2">
            {bots.length === 0 && <div className="text-xs text-muted-foreground">No bots yet. Configure and "Add bot" to create.</div>}
            {bots.map((b) => (
              <div key={b.id} className="rounded-lg border border-border bg-background p-3 flex items-center justify-between">
                <div>
                  <div className="font-mono text-sm">{b.symbol} · {b.strategy_id || "no-strategy"}</div>
                  <div className="text-xs text-muted-foreground">{availableAccounts.find((a:any)=>a.id===b.account_id)?.label ?? b.account_id} · {b.timeframe} · {b.mode}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => startSingle(b)} className="rounded-lg bg-emerald-600 px-2 py-1 text-xs text-white">Start</button>
                  <button onClick={() => { setEditingBotId(b.id); setShowSettings(true); }} className="rounded-lg border border-border px-2 py-1 text-xs">Edit</button>
                  <button onClick={() => removeBot(b.id)} className="rounded-lg border border-border px-2 py-1 text-xs text-rose-500">Remove</button>
                </div>
              </div>
            ))}
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
                 {l.meta ? ` ${(() => { try { return JSON.stringify(l.meta); } catch { return ""; } })()}` : ""}
               </div>
             ))}
           </div>
         </div>
       </div>

       {showSettings && (
         <StrategySettingsModal
          params={editingBotId ? (bots.find(b=>b.id===editingBotId)?.params ?? params) : params}
          fields={(STRATEGY_SETTINGS[strategyId] ?? []).filter(f => f.category !== "execution")}
            onClose={() => {
              setShowSettings(false);
              setEditingBotId(null);
            }}
            onSave={async (next) => {
              // if editing an existing bot update it, otherwise update template params
              if (editingBotId) {
                updateBot(editingBotId, { params: next });
              } else {
                setParams(next);
                await persistSettings(next);
              }
              setShowSettings(false);
              setEditingBotId(null);
            }}
          />
       )}
     </div>
   );
}

function StrategySettingsModal({ params, onSave, onClose, fields }: {
  params: { stake: number; duration: number; duration_unit: "m"|"h"|"d"|"t"; [k: string]: any };
  fields: { key: string; label: string; type: "number"|"select"|"boolean"|"text"; min?: number; max?: number; step?: number; options?: string[]; default?: string | number | boolean }[];
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

           {!!fields.length && (
             <div className="grid gap-3 md:grid-cols-2">
               {fields.map((f) => (
                 <div key={f.key}>
                   <label className="block text-sm mb-1">{f.label}</label>
                   {f.type === "number" && (
                     <input type="number" className="w-full rounded-lg border border-border bg-background px-3 py-2"
                       min={f.min} max={f.max} step={f.step}
                       value={Number(form[f.key] ?? f.default ?? 0)}
                       onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}/>
                   )}
                   {f.type === "select" && (
                     <select className="w-full rounded-lg border border-border bg-background px-3 py-2"
                       value={String(form[f.key] ?? f.default ?? "")}
                       onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}>
                       {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                     </select>
                   )}
                   {f.type === "boolean" && (
                     <input type="checkbox"
                       checked={Boolean(form[f.key] ?? f.default ?? false)}
                       onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}/>
                   )}
                   {f.type === "text" && (
                     <input type="text" className="w-full rounded-lg border border-border bg-background px-3 py-2"
                       value={String(form[f.key] ?? f.default ?? "")}
                       onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}/>
                   )}
                 </div>
               ))}
             </div>
           )}

           <div className="grid gap-3 md:grid-cols-2">
             <div>
               <label className="block text-sm mb-1">{form.duration_unit === "t" ? "Tick Count" : "Expiry Duration"}</label>
               <input type="number" min={form.duration_unit === "t" ? 1 : 1} className="w-full rounded-lg border border-border bg-background px-3 py-2"
                 value={form.duration} onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })}/>
             </div>
             <div>
               <label className="block text-sm mb-1">Unit</label>
               <select className="w-full rounded-lg border border-border bg-background px-3 py-2"
                 value={form.duration_unit} onChange={(e) => setForm({ ...form, duration_unit: e.target.value as any })}>
                 <option value="t">Ticks</option>
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
function useState(params: { [k: string]: any; stake: number; duration: number; duration_unit: "m" | "h" | "d" | "t"; }): [any, any] {
  return reactUseState(params);
}
