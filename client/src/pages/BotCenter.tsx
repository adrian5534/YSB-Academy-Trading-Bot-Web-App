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

  const { logs, clearLogs } = useRuntimeEvents();

  const availableAccounts = useMemo(() => accounts ?? [], [accounts]);
  const [accountId, setAccountId] = usePersistedState<string>("bot:accountId", "");
  const [symbol, setSymbol] = usePersistedState<string>("bot:symbol", "R_100");
  const [timeframe, setTimeframe] = usePersistedState<string>("bot:timeframe", "1m");
  const [strategyId, setStrategyId] = usePersistedState<string>("bot:strategyId", "");
  const [mode, setMode] = usePersistedState<"backtest" | "paper" | "live">("bot:mode", "paper");
  const [params, setParams] = usePersistedState<Record<string, any>>("bot:params", {
    stake: 250,
    duration: 5,
    duration_unit: "m" as "m" | "h" | "d" | "t",
  });
  const [showSettings, setShowSettings] = usePersistedState<boolean>("bot:showSettings", false);

  // multiple bots (each its own identical card)
  const [bots, setBots] = usePersistedState<any[]>("bot:configs", []);
  const [editingBotId, setEditingBotId] = reactUseState<string | null>(null);

  // Keep server awake while this page is open (poll /api/health every 4 minutes)
  useKeepAlive(true, 240_000);

  // default account
  useEffect(() => {
    if (!accountId && availableAccounts.length) setAccountId(availableAccounts[0].id);
  }, [availableAccounts, accountId]);

  // helper to compute execution unit from timeframe
  const computeExecUnit = (tf: string): "t" | "m" | "h" | "d" => {
    if (tf === "1s") return "t";
    if (tf.endsWith("m")) return "m";
    if (tf.endsWith("h")) return "h";
    return "d";
  };

  const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const addBot = () => {
    const b = {
      id: makeId(),
      account_id: accountId || (availableAccounts[0]?.id ?? ""),
      symbol,
      timeframe,
      strategy_id: strategyId || "",
      mode,
      params: { ...params },
      enabled: true,
    };
    setBots((s) => [...s, b]);
    toast({ title: "Bot added", description: `${b.symbol} · ${b.strategy_id || "no-strategy"}` });
  };

  const updateBot = (id: string, patch: Partial<any>) =>
    setBots((s) =>
      s.map((b) => {
        if (b.id !== id) return b;
        // keep execution unit aligned when timeframe changes
        if (patch.timeframe && patch.timeframe !== b.timeframe) {
          const du = computeExecUnit(patch.timeframe);
          return {
            ...b,
            ...patch,
            params: { ...(b.params || {}), duration_unit: du, duration: Math.max(1, Number(b.params?.duration ?? 5)) },
          };
        }
        // merge defaults when strategy changes (preserve execution fields)
        if (patch.strategy_id && patch.strategy_id !== b.strategy_id) {
          const defaults = getStrategyDefaults(patch.strategy_id);
          const execKeys = new Set(["stake", "duration", "duration_unit"]);
          const exec = {
            stake: Number(b.params?.stake ?? 250),
            duration: Number(b.params?.duration ?? 5),
            duration_unit: (b.params?.duration_unit as any) ?? computeExecUnit(b.timeframe),
          };
          const nextParams: Record<string, any> = {
            ...defaults,
            ...Object.fromEntries(Object.entries(b.params || {}).filter(([k]) => execKeys.has(k))),
            ...exec,
          };
          return { ...b, ...patch, params: nextParams };
        }
        return { ...b, ...patch };
      })
    );

  const removeBot = (id: string) => setBots((s) => s.filter((b) => b.id !== id));

  const isPro = sub?.plan === "pro";

  // Primary start: ONLY start the primary config
  const start = async () => {
    try {
      if (!isPro && (mode === "paper" || mode === "live")) {
        toast({ title: "Upgrade required", description: "Paper/Live trading requires Pro plan.", variant: "destructive" });
        return;
      }
      if (!accountId || !strategyId) {
        toast({ title: "Missing fields", description: "Select account and strategy.", variant: "destructive" });
        return;
      }
      await persistSettings({ ...params }, /*enabled*/ false);
      await startBot.mutateAsync({
        name: "YSB Bot",
        configs: [
          {
            account_id: accountId,
            symbol,
            timeframe,
            strategy_id: strategyId,
            mode,
            params,
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

  // Extra card start: ONLY start that card's config
  const startSingle = async (b: any) => {
    try {
      if (!isPro && (b.mode === "paper" || b.mode === "live")) {
        toast({ title: "Upgrade required", description: "Paper/Live trading requires Pro plan.", variant: "destructive" });
        return;
      }
      if (!b.strategy_id || !b.account_id) {
        toast({ title: "Missing fields", description: "Select account and strategy.", variant: "destructive" });
        return;
      }
      // Persist without enabling globally (avoid starting all server-side)
      await apiFetch(api.strategies.setSettings.path, {
        method: "POST",
        body: JSON.stringify({
          account_id: b.account_id,
          symbol: b.symbol,
          timeframe: b.timeframe,
          strategy_id: b.strategy_id,
          params: b.params,
          enabled: false,
        }),
      }).catch(() => void 0);

      await startBot.mutateAsync({
        name: "YSB Bot",
        configs: [
          {
            account_id: b.account_id,
            symbol: b.symbol,
            timeframe: b.timeframe,
            strategy_id: b.strategy_id,
            mode: b.mode,
            params: b.params,
            enabled: true,
          },
        ],
      });
      toast({ title: "Bot started", description: `${b.symbol} · ${b.strategy_id}` });
    } catch (e: any) {
      toast({ title: "Start failed", description: String(e?.message ?? e), variant: "destructive" });
    }
  };

  // set duration unit when timeframe changes (1s => ticks) for primary
  useEffect(() => {
    setParams((p) => {
      if (timeframe === "1s") return { ...p, duration_unit: "t" as const, duration: Math.max(1, p.duration || 5) };
      if (timeframe.endsWith("m")) return { ...p, duration_unit: "m" as const };
      if (timeframe.endsWith("h")) return { ...p, duration_unit: "h" as const };
      if (timeframe.endsWith("d")) return { ...p, duration_unit: "d" as const };
      return p;
    });
  }, [timeframe]);

  // merge defaults for selected strategy; clear fields from previous strategy (primary)
  useEffect(() => {
    setParams((p) => {
      const exec = { stake: p.stake ?? 250, duration: p.duration ?? 5, duration_unit: p.duration_unit ?? (timeframe === "1s" ? "t" : "m") } as any;
      if (!strategyId) return exec;
      const defaults = getStrategyDefaults(strategyId);
      const allowedKeys = new Set(Object.keys(defaults).concat(EXECUTION_FIELDS.map((f) => f.key)));
      const next: Record<string, any> = {};
      for (const k of Object.keys(p)) if (allowedKeys.has(k)) next[k] = (p as any)[k];
      return { ...defaults, ...exec, ...next };
    });
  }, [strategyId, timeframe]);

  // load saved settings for primary combo
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

  // Persist helper (do not enable globally)
  const persistSettings = async (next = params, enabled = false) => {
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
          enabled, // keep false to avoid starting all on server
        }),
      });
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="text-2xl font-semibold">Control Panel</div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status?.state === "running" ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-600/20 text-zinc-300"}`}>
          {status?.state === "running" ? "RUNNING" : "STOPPED"}
        </span>
      </div>
      <div className="text-sm text-muted-foreground">Manage strategy & execution</div>

      {/* Cards grid: primary + extra cards, responsive left-to-right */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3">
        {/* Primary card */}
        <div className="relative">
          <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-border bg-background p-3">
                <div className="text-sm text-muted-foreground">Strategy</div>
                <div className="mt-1 font-mono text-lg">{strategyId ? strategyId.toUpperCase() : "—"}</div>
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
              <button
                onClick={start}
                disabled={!strategyId || (!isPro && (mode === "paper" || mode === "live"))}
                className={`rounded-lg px-3 py-2 font-semibold ${(!strategyId || (!isPro && (mode === "paper" || mode === "live"))) ? "border border-border bg-muted text-muted-foreground cursor-not-allowed" : "bg-ysbPurple text-ysbYellow hover:opacity-90"}`}
              >
                {status?.state === "running" ? "RESTART" : "START"}
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

          {/* Big + anchored to the right side of the primary card */}
          <button
            onClick={addBot}
            title="Add bot"
            className="absolute -right-6 top-1/2 -translate-y-1/2 z-10 flex h-14 w-14 items-center justify-center rounded-full bg-ysbPurple text-ysbYellow text-3xl shadow-xl"
          >
            +
          </button>
        </div>

        {/* Extra bot cards (identical layout) */}
        {bots.map((b) => (
          <div key={b.id} className="rounded-2xl border border-border bg-card p-4 space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-border bg-background p-3">
                <div className="text-sm text-muted-foreground">Strategy</div>
                <div className="mt-1 font-mono text-lg">{b.strategy_id ? String(b.strategy_id).toUpperCase() : "—"}</div>
              </div>
              <div className="rounded-xl border border-border bg-background p-3">
                <div className="text-sm text-muted-foreground">Stake</div>
                <div className="mt-1 font-mono text-lg">${Number(b.params?.stake ?? 0)}</div>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-background p-3">
              <div className="text-sm text-muted-foreground mb-2">Settings</div>
              {!b.strategy_id ? (
                <div className="text-xs text-muted-foreground">Select a strategy to configure.</div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono">
                  {Object.entries(b.params || {})
                    .filter(([k]) => !["stake", "duration", "duration_unit"].includes(k))
                    .slice(0, 5)
                    .map(([k, v]) => (
                      <div key={k}>
                        {k}: <span className="text-foreground">{String(v)}</span>
                      </div>
                    ))}
                  <div>Expiry: <span className="text-foreground">{b.params?.duration}{b.params?.duration_unit}</span></div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-sm">Account</label>
                <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={b.account_id} onChange={(e) => updateBot(b.id, { account_id: e.target.value })}>
                  {availableAccounts.map((a: any) => (
                    <option key={a.id} value={a.id}>{a.label} {a.type ? `(${a.type})` : ""}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm">Symbol</label>
                <input className="w-full rounded-lg border border-border bg-background px-3 py-2" value={b.symbol} onChange={(e) => updateBot(b.id, { symbol: e.target.value })} />
              </div>
              <div>
                <label className="block text-sm">Timeframe</label>
                <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={b.timeframe} onChange={(e) => updateBot(b.id, { timeframe: e.target.value })}>
                  {["1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm">Strategy</label>
              <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={b.strategy_id} onChange={(e) => updateBot(b.id, { strategy_id: e.target.value })}>
                <option value="">Select a strategy…</option>
                {["candle_pattern", "one_hour_trend", "trend_confirmation", "scalping_hwr", "trend_pullback", "supply_demand_sweep", "fvg_retracement", "range_mean_reversion"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => startSingle(b)}
                disabled={!b.strategy_id || !b.account_id || (!isPro && (b.mode === "paper" || b.mode === "live"))}
                className={`rounded-lg px-3 py-2 font-semibold ${(!b.strategy_id || !b.account_id || (!isPro && (b.mode === "paper" || b.mode === "live"))) ? "border border-border bg-muted text-muted-foreground cursor-not-allowed" : "bg-ysbPurple text-ysbYellow hover:opacity-90"}`}
              >
                {status?.state === "running" ? "RESTART" : "START"}
              </button>
              <button onClick={stop} className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground">Stop</button>
              <div className="ml-auto flex items-center gap-2">
                <select
                  className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  value={b.mode}
                  onChange={(e) => updateBot(b.id, { mode: e.target.value as any })}
                >
                  <option value="backtest">Backtest</option>
                  <option value="paper" disabled={!isPro}>Paper{!isPro ? " (Pro only)" : ""}</option>
                  <option value="live" disabled={!isPro}>Live{!isPro ? " (Pro only)" : ""}</option>
                </select>
                <button
                  type="button"
                  onClick={() => b.strategy_id && (setEditingBotId(b.id), setShowSettings(true))}
                  className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                  title="Strategy settings"
                  disabled={!b.strategy_id}
                >
                  ⚙️
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Live logs moved below, full-width responsive */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold">Live logs</div>
          <button
            onClick={clearLogs}
            className="rounded-lg border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
            type="button"
          >
            Clear
          </button>
        </div>
        <div className="max-h-[28rem] overflow-auto rounded-lg border border-border bg-background p-2 font-mono text-xs text-muted-foreground">
          {logs.slice(0, 400).map((l, i) => (
            <div key={i} className="whitespace-pre-wrap">
              <span className="text-muted-foreground">{new Date(l.ts).toLocaleTimeString()} </span>
              {l.message}
              {l.meta
                ? ` ${
                    (() => {
                      try {
                        return JSON.stringify(l.meta);
                      } catch {
                        return "";
                      }
                    })()
                  }`
                : ""}
            </div>
          ))}
        </div>
      </div>

      {showSettings && (
        <StrategySettingsModal
          params={editingBotId ? (bots.find(b=>b.id===editingBotId)?.params ?? params) : params}
          fields={(STRATEGY_SETTINGS[(editingBotId ? (bots.find(b=>b.id===editingBotId)?.strategy_id) : strategyId) ?? ""] ?? []).filter(f => f.category !== "execution")}
          onClose={() => { setShowSettings(false); setEditingBotId(null); }}
          onSave={async (next) => {
            if (editingBotId) {
              const b = bots.find(x=>x.id===editingBotId);
              if (b) {
                updateBot(editingBotId, { params: next });
                // Persist without enabling globally
                await apiFetch(api.strategies.setSettings.path, {
                  method: "POST",
                  body: JSON.stringify({
                    account_id: b.account_id,
                    symbol: b.symbol,
                    timeframe: b.timeframe,
                    strategy_id: b.strategy_id,
                    params: next,
                    enabled: false,
                  }),
                }).catch(() => void 0);
              }
            } else {
              setParams(next);
              await persistSettings(next, false);
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
               <input type="number" min={1} className="w-full rounded-lg border border-border bg-background px-3 py-2"
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