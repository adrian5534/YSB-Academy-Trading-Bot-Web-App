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
import { useInstruments } from "@/hooks/use-instruments";

type DurationUnit = "m" | "h" | "d" | "t";

type Instrument = {
  symbol?: string;
  display_name?: string;
  market_display_name?: string;
  market?: string;
  submarket_display_name?: string;
  subgroup_display_name?: string;
};

type InstrumentFilters = {
  market: string; // market_display_name
  q: string; // search query
};

// execution fields are required, strategy fields are free-form
type StrategyParams = {
  stake: number;
  duration: number;
  duration_unit: DurationUnit;
  max_open_trades: number;

  /** Pause execution for N seconds after a losing trade (0 disables) */
  cooldown_after_loss?: number;

  /** Enable/disable early sell without destroying the threshold value */
  early_sell_enabled?: boolean;

  /** Early exit when unrealized profit reaches this USD amount */
  early_sell_profit?: number;

  [k: string]: any;
};

type BotCfg = {
  id?: string; // present for extra cards
  account_id: string;
  symbol: string;
  timeframe: string;
  strategy_id: string;
  mode: "backtest" | "paper" | "live";
  params: StrategyParams;
  enabled?: boolean;
};

// Global risk rules (applies to ALL bots/runs for the user)
type RiskRules = {
  risk_type?: "fixed_stake" | "percent_balance";
  fixed_stake?: number;
  percent_risk?: number;
  max_daily_loss?: number;
  max_drawdown?: number;
  max_open_trades?: number;
  adaptive_enabled?: boolean;
  adaptive_min_percent?: number;
  adaptive_max_percent?: number;
  adaptive_step?: number;
  adaptive_lookback?: number;
};

type StrategyMeta = {
  id: string;
  name: string;
  description: string;
  default_params?: Record<string, any>;
};

function instrumentMarket(i: any): string {
  return String(i?.market_display_name ?? i?.market ?? "Other");
}
function instrumentSubmarket(i: any): string {
  return String(i?.subgroup_display_name ?? i?.submarket_display_name ?? "Other");
}
function instrumentLabel(i: any): string {
  const name = String(i?.display_name ?? "").trim();
  const sym = String(i?.symbol ?? "").trim();
  return name ? `${name} (${sym})` : sym;
}

export default function BotCenter() {
  const { toast } = useToast();
  const { data: accounts } = useAccounts();
  const { data: sub } = useSubscription();
  const { data: status } = useBotStatus();
  const startBot = useStartBot();
  const stopBot = useStopBot();

  const { data: instruments, isLoading: instrumentsLoading, error: instrumentsError } = useInstruments();

  const { logs, clearLogs } = useRuntimeEvents();

  const availableAccounts = useMemo(() => accounts ?? [], [accounts]);

  const [strategyCatalog, setStrategyCatalog] = reactUseState<StrategyMeta[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await apiFetch(api.strategies.list.path);
        const list = (await r.json()) as StrategyMeta[];
        if (alive) setStrategyCatalog(Array.isArray(list) ? list : []);
      } catch {
        if (alive) setStrategyCatalog([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const getDefaultsForStrategy = (id: string): Record<string, any> => {
    const local = getStrategyDefaults(id) ?? {};
    if (Object.keys(local).length) return local;

    const remote = strategyCatalog.find((s) => s.id === id)?.default_params ?? {};
    return remote;
  };

  // ✅ central strategy list (server + local fallback)
  const strategyOptions = useMemo(() => {
    const preferred: string[] = [
      "candle_pattern",
      "one_hour_trend",
      "trend_confirmation",
      "scalping_hwr",
      "trend_pullback",
      "supply_demand_sweep",
      "fvg_retracement",
      "range_mean_reversion",
      "aroon_trend",
      "bollinger_snap",
      "confluence_reversal",
      "dpo_cycle_reversal",
      "dual_momentum",
      "macd_flip",
      "ma_pullback",
      "roc_burst",
      "stoch_snap",
      "vol_break",
    ];

    const serverIds = strategyCatalog.map((s) => s.id);

    // ✅ use server as source of truth to avoid selecting unsupported local-only ids
    const all = Array.from(new Set(serverIds));
    const seen = new Set<string>();

    const ordered: string[] = [];
    for (const id of preferred) {
      if (all.includes(id)) {
        ordered.push(id);
        seen.add(id);
      }
    }

    const rest = all.filter((id) => !seen.has(id)).sort((a, b) => a.localeCompare(b));
    return ordered.concat(rest);
  }, [strategyCatalog]);

  const [accountId, setAccountId] = usePersistedState<string>("bot:accountId", "");
  const [symbol, setSymbol] = usePersistedState<string>("bot:symbol", "R_100");
  const [timeframe, setTimeframe] = usePersistedState<string>("bot:timeframe", "1m");
  const [strategyId, setStrategyId] = usePersistedState<string>("bot:strategyId", "");
  const [mode, setMode] = usePersistedState<"backtest" | "paper" | "live">("bot:mode", "paper");

  const [params, setParams] = usePersistedState<StrategyParams>("bot:params", {
    stake: 250,
    duration: 5,
    duration_unit: "m",
    max_open_trades: 5,

    // ✅ NEW
    cooldown_after_loss: 0,

    early_sell_enabled: false,
    early_sell_profit: 0,
  });

  const [showSettings, setShowSettings] = usePersistedState<boolean>("bot:showSettings", false);

  // multiple bots (each its own identical card)
  const [bots, setBots] = usePersistedState<BotCfg[]>("bot:configs", []);
  const [editingBotId, setEditingBotId] = reactUseState<string | null>(null);

  // ✅ Instrument picker filter state (persisted)
  const [primaryInstrFilters, setPrimaryInstrFilters] = usePersistedState<InstrumentFilters>(
    "bot:instrumentFilters:primary",
    { market: "", q: "" },
  );

  const [cardInstrFilters, setCardInstrFilters] = usePersistedState<Record<string, InstrumentFilters>>(
    "bot:instrumentFilters:cards",
    {},
  );

  const getCardFilters = (id: string): InstrumentFilters => cardInstrFilters[id] ?? { market: "", q: "" };
  const patchCardFilters = (id: string, patch: Partial<InstrumentFilters>) => {
    setCardInstrFilters((prev: any) => ({
      ...(prev ?? {}),
      [id]: { ...(prev?.[id] ?? { market: "", q: "" }), ...(patch ?? {}) },
    }));
  };

  // cleanup filter entries for removed cards
  useEffect(() => {
    const aliveIds = new Set((bots ?? []).map((b: any) => String(b?.id ?? "")));
    setCardInstrFilters((prev: any) => {
      const p = prev ?? {};
      let changed = false;
      const next: Record<string, InstrumentFilters> = {};
      for (const [k, v] of Object.entries(p)) {
        if (aliveIds.has(k)) next[k] = v as any;
        else changed = true;
      }
      return changed ? next : p;
    });
  }, [bots, setCardInstrFilters]);

  // ✅ Risk settings state (global, but edited from the bot settings modal)
  const [risk, setRisk] = reactUseState<RiskRules | null>(null);
  const [savingRisk, setSavingRisk] = reactUseState(false);
  const [lastMaxDailyLoss, setLastMaxDailyLoss] = reactUseState<number>(50);

  // Keep server awake while this page is open (poll /api/health every 4 minutes)
  useKeepAlive(true, 240_000);

  // default account
  useEffect(() => {
    if (!accountId && availableAccounts.length) setAccountId(availableAccounts[0].id);
  }, [availableAccounts, accountId, setAccountId]);

  // ✅ migrate stale persisted account ids (fixes "works in incognito but not normal tab")
  useEffect(() => {
    if (!availableAccounts.length) return;

    const valid = new Set(availableAccounts.map((a: any) => String(a.id)));
    const fallbackId = String(availableAccounts[0].id);

    // Primary selected account
    if (accountId && !valid.has(String(accountId))) {
      setAccountId(fallbackId);
    }

    // Extra bot cards stored in localStorage
    setBots((prev) => {
      if (!Array.isArray(prev) || prev.length === 0) return prev;

      let changed = false;
      const next = prev.map((b: any) => {
        const id = b?.account_id ? String(b.account_id) : "";
        if (!id || !valid.has(id)) {
          changed = true;
          return { ...b, account_id: fallbackId };
        }
        return b;
      });

      return changed ? next : prev;
    });
  }, [availableAccounts, accountId, setAccountId, setBots]);

  // ✅ Load risk rules once (global)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await apiFetch("/api/settings/risk");
        const j = (await r.json()) as RiskRules;

        if (!alive) return;

        const mdl = Number((j as any)?.max_daily_loss ?? 0);
        if (Number.isFinite(mdl) && mdl > 0) setLastMaxDailyLoss(mdl);

        setRisk(j ?? {});
      } catch {
        // keep risk UI hidden in modal if endpoint fails
        if (alive) setRisk(null);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const saveRisk = async (next: RiskRules) => {
    try {
      setSavingRisk(true);
      await apiFetch("/api/settings/risk", {
        method: "PUT",
        body: JSON.stringify(next ?? {}),
      });
      setRisk(next);
      toast({ title: "Risk settings saved" });
    } catch (e: any) {
      toast({
        title: "Failed to save risk settings",
        description: String(e?.message ?? e),
        variant: "destructive",
      });
    } finally {
      setSavingRisk(false);
    }
  };

  // helper to compute execution unit from timeframe
  const computeExecUnit = (tf: string): DurationUnit => {
    if (tf === "1s") return "t";
    if (tf.endsWith("m")) return "m";
    if (tf.endsWith("h")) return "h";
    return "d";
  };

  const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Add bot (no hard limit)
  const addBot = () => {
    const b: BotCfg & { id: string } = {
      id: makeId(),
      account_id: accountId || (availableAccounts[0]?.id ?? ""),
      symbol,
      timeframe,
      strategy_id: strategyId || "",
      mode,
      params: { ...params },
      enabled: false, // keep disabled in storage
    };
    setBots((s) => [...s, b]);
    toast({ title: "Bot added", description: `${b.symbol} · ${b.strategy_id || "no-strategy"}` });
  };

  const updateBot = (id: string, patch: Partial<BotCfg>) =>
    setBots((s) =>
      s.map((b: any) => {
        if (b.id !== id) return b;

        // keep execution unit aligned when timeframe changes
        if (patch.timeframe && patch.timeframe !== b.timeframe) {
          const du = computeExecUnit(patch.timeframe);
          return {
            ...b,
            ...patch,
            params: {
              ...(b.params || {}),
              ...(patch.params || {}),
              duration_unit: du,
              duration: Math.max(1, Number(b.params?.duration ?? 5)),
            },
          };
        }

        // merge defaults when strategy changes (preserve execution fields)
        if (patch.strategy_id && patch.strategy_id !== b.strategy_id) {
          const defaults = getDefaultsForStrategy(patch.strategy_id);
          const execKeys = new Set([
            "stake",
            "duration",
            "duration_unit",
            "max_open_trades",
            "cooldown_after_loss", // ✅ NEW
            "early_sell_enabled",
            "early_sell_profit",
          ]);

          const exec = {
            stake: Number(b.params?.stake ?? 250),
            duration: Number(b.params?.duration ?? 5),
            duration_unit: (b.params?.duration_unit as DurationUnit) ?? computeExecUnit(b.timeframe),
            max_open_trades: Number(b.params?.max_open_trades ?? 5),

            // ✅ NEW
            cooldown_after_loss: Math.max(0, Math.floor(Number(b.params?.cooldown_after_loss ?? 0) || 0)),

            early_sell_enabled: Boolean(b.params?.early_sell_enabled ?? false),
            early_sell_profit: Number(b.params?.early_sell_profit ?? 0),
          };

          const nextParams: StrategyParams = {
            ...defaults,
            ...Object.fromEntries(Object.entries(b.params || {}).filter(([k]) => execKeys.has(k))),
            ...exec,
          };

          return { ...b, ...patch, params: nextParams };
        }

        return { ...b, ...patch };
      }),
    );

  const removeBot = (id: string) => {
    setBots((s) => s.filter((b: any) => b.id !== id));
    setCardInstrFilters((prev: any) => {
      const p = prev ?? {};
      if (!p[id]) return p;
      const { [id]: _removed, ...rest } = p;
      return rest;
    });
  };

  const isPro = sub?.plan === "pro";

  const runIdPrimary = "primary"; // stable id for the first card
  const runNamePrimary = `YSB Bot - ${symbol}-${timeframe}-${strategyId || "none"}`;
  const runIdOf = (b: any) => String(b.id); // use card id as run_id
  const runNameOf = (b: any) =>
    `YSB Bot - ${b.symbol}-${b.timeframe}-${b.strategy_id || "none"}-${String(b.id || "").slice(-4)}`;

  // derive per-run state from status.runs
  const runs = status?.runs ?? [];
  const isRunRunning = (rid: string) => runs.some((r: any) => r.run_id === rid && r.state === "running");

  // Primary start: ONLY start the primary config with a unique run name
  const start = async () => {
    try {
      if (!isPro && (mode === "paper" || mode === "live")) {
        toast({
          title: "Upgrade required",
          description: "Paper/Live trading requires Pro plan.",
          variant: "destructive",
        });
        return;
      }
      if (!accountId || !strategyId) {
        toast({ title: "Missing fields", description: "Select account and strategy.", variant: "destructive" });
        return;
      }

      // optional: persist current settings (do not enable)
      await persistSettings({ ...params }, false);

      await startBot.mutateAsync({
        run_id: runIdPrimary,
        name: runNamePrimary,
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

      toast({ title: "Bot started", description: "Primary bot is running." });
    } catch (e: any) {
      toast({ title: "Start failed", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  const stopRun = async (runId: string) => {
    try {
      await stopBot.mutateAsync({ run_id: runId });
      toast({ title: "Bot stopped", description: runId });
    } catch (e: any) {
      toast({ title: "Stop failed", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  // Extra card start: ONLY start that card's config with a unique run name
  const startSingle = async (b: any) => {
    try {
      if (!isPro && (b.mode === "paper" || b.mode === "live")) {
        toast({
          title: "Upgrade required",
          description: "Paper/Live trading requires Pro plan.",
          variant: "destructive",
        });
        return;
      }
      if (!b.strategy_id || !b.account_id) {
        toast({ title: "Missing fields", description: "Select account and strategy.", variant: "destructive" });
        return;
      }

      // optional: persist settings (do not enable)
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
        run_id: runIdOf(b),
        name: runNameOf(b),
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
    setParams((p: StrategyParams) => {
      if (timeframe === "1s") return { ...p, duration_unit: "t", duration: Math.max(1, p.duration || 5) };
      if (timeframe.endsWith("m")) return { ...p, duration_unit: "m" };
      if (timeframe.endsWith("h")) return { ...p, duration_unit: "h" };
      if (timeframe.endsWith("d")) return { ...p, duration_unit: "d" };
      return p;
    });
  }, [timeframe, setParams]);

  // merge defaults for selected strategy; clear fields from previous strategy (primary)
  useEffect(() => {
    setParams((p: StrategyParams) => {
      const exec: StrategyParams = {
        ...p,
        stake: p.stake ?? 250,
        duration: p.duration ?? 5,
        duration_unit: p.duration_unit ?? (timeframe === "1s" ? "t" : "m"),
        max_open_trades: p.max_open_trades ?? 5,

        // ✅ NEW
        cooldown_after_loss: Math.max(0, Math.floor(Number(p.cooldown_after_loss ?? 0) || 0)),

        early_sell_enabled: Boolean(p.early_sell_enabled ?? false),
        early_sell_profit: Number(p.early_sell_profit ?? 0),
      };

      if (!strategyId) return exec;

      const defaults = getDefaultsForStrategy(strategyId);
      const allowedKeys = new Set(
        Object.keys(defaults)
          .concat(EXECUTION_FIELDS.map((f) => f.key))
          .concat([
            "max_open_trades",
            "cooldown_after_loss", // ✅ NEW
            "early_sell_enabled",
            "early_sell_profit",
          ]),
      );

      const next: Record<string, any> = {};
      for (const k of Object.keys(p)) if (allowedKeys.has(k)) next[k] = (p as any)[k];

      return { ...defaults, ...exec, ...next } as StrategyParams;
    });
  }, [strategyId, timeframe, setParams, strategyCatalog]);

  // load saved settings for primary combo
  useEffect(() => {
    (async () => {
      if (!accountId || !strategyId) return;
      try {
        const path = api.strategies.settingsForAccount.path.replace(":accountId", accountId);
        const r = await apiFetch(path);
        const list = (await r.json()) as any[];
        const found = list.find((s) => s.symbol === symbol && s.timeframe === timeframe && s.strategy_id === strategyId);
        if (found?.params) setParams((p: StrategyParams) => ({ ...p, ...found.params }));
      } catch {
        /* ignore */
      }
    })();
  }, [accountId, symbol, timeframe, strategyId, setParams]);

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
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            status?.state === "running" ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-600/20 text-zinc-300"
          }`}
        >
          {status?.state === "running" ? "RUNNING" : "STOPPED"}
        </span>
      </div>
      <div className="text-sm text-muted-foreground">Manage strategy & execution</div>

      {/* Cards grid: responsive left-to-right */}
      <div className="bot-center__grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 items-stretch">
        {/* Primary card */}
        <div className="rounded-2xl border border-border bg-card p-4 space-y-4 h-full flex flex-col">
          <div className="grid gap-3 sm:grid-cols-2">
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
                <div>
                  Expiry: <span className="text-foreground">{params.duration}{params.duration_unit}</span>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="block text-sm">Account</label>
              <select
                className="w-full rounded-lg border border-border bg-background px-3 py-2"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {availableAccounts.map((a: any) => (
                  <option key={a.id} value={a.id}>
                    {a.label} {a.type ? `(${a.type})` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm">Timeframe</label>
              <select
                className="w-full rounded-lg border border-border bg-background px-3 py-2"
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
              >
                {["1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* ✅ Instrument picker (markets + submarkets/categories + search) */}
          <InstrumentPicker
            title="Instrument"
            instruments={instruments as any[]}
            isLoading={instrumentsLoading}
            error={instrumentsError}
            symbol={symbol}
            onSymbolChange={setSymbol}
            filters={primaryInstrFilters}
            onFiltersChange={setPrimaryInstrFilters}
          />

          <div>
            <label className="block text-sm">Strategy</label>
            <select
              className="w-full rounded-lg border border-border bg-background px-3 py-2"
              value={strategyId}
              onChange={(e) => setStrategyId(e.target.value)}
            >
              <option value="">Select a strategy…</option>
              {strategyOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {/* ✅ Controls ABOVE start/stop so users can set them before starting (PRIMARY) */}
          <div className="w-full space-y-3">
            {/* Trading mode */}
            <div className="w-full space-y-1">
              <label className="block text-xs text-muted-foreground">Trading mode</label>

              <div className="flex w-full flex-wrap items-center gap-2">
                <select
                  className="w-full max-w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as any)}
                >
                  <option value="backtest">Backtest</option>
                  <option value="paper" disabled={!isPro}>
                    Paper{!isPro ? " (Pro only)" : ""}
                  </option>
                  <option value="live" disabled={!isPro}>
                    Live{!isPro ? " (Pro only)" : ""}
                  </option>
                </select>
              </div>
            </div>

            {/* Bot settings (block) */}
            <div className="w-full space-y-1">
              <label className="block text-xs text-muted-foreground">Bot settings</label>

              <button
                type="button"
                onClick={() => strategyId && setShowSettings(true)}
                className="w-full rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                title="Bot settings"
                disabled={!strategyId}
              >
                ⚙️ Bot settings
              </button>
            </div>
          </div>

          {/* PRIMARY card action row (Start/Stop only) */}
          <div className="grid grid-cols-2 gap-2 mt-auto">
            <button
              onClick={start}
              disabled={!strategyId || (!isPro && (mode === "paper" || mode === "live"))}
              className={`w-full rounded-lg px-3 py-2 font-semibold ${
                !strategyId || (!isPro && (mode === "paper" || mode === "live"))
                  ? "border border-border bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-ysbPurple text-ysbYellow hover:opacity-90"
              }`}
            >
              {isRunRunning(runIdPrimary) ? "RESTART" : "START"}
            </button>

            <button
              onClick={() => stopRun(runIdPrimary)}
              className="w-full rounded-lg border border-border px-3 py-2 font-semibold text-muted-foreground hover:text-foreground"
              type="button"
            >
              Stop
            </button>
          </div>
        </div>

        {/* Extra bot cards (identical layout) */}
        {bots.map((b: any) => (
          <div key={b.id} className="rounded-2xl border border-border bg-card p-4 space-y-4 h-full flex flex-col">
            <div className="grid gap-3 sm:grid-cols-2">
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
                  <div>
                    Expiry: <span className="text-foreground">{b.params?.duration}{b.params?.duration_unit}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="block text-sm">Account</label>
                <select
                  className="w-full rounded-lg border border-border bg-background px-3 py-2"
                  value={b.account_id}
                  onChange={(e) => updateBot(b.id, { account_id: e.target.value })}
                >
                  {availableAccounts.map((a: any) => (
                    <option key={a.id} value={a.id}>
                      {a.label} {a.type ? `(${a.type})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm">Timeframe</label>
                <select
                  className="w-full rounded-lg border border-border bg-background px-3 py-2"
                  value={b.timeframe}
                  onChange={(e) => updateBot(b.id, { timeframe: e.target.value })}
                >
                  {["1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* ✅ Instrument picker for the card */}
            <InstrumentPicker
              title="Instrument"
              instruments={instruments as any[]}
              isLoading={instrumentsLoading}
              error={instrumentsError}
              symbol={String(b.symbol ?? "")}
              onSymbolChange={(sym) => updateBot(b.id, { symbol: sym })}
              filters={getCardFilters(String(b.id))}
              onFiltersChange={(next) => patchCardFilters(String(b.id), next)}
            />

            <div>
              <label className="block text-sm">Strategy</label>
              <select
                className="w-full rounded-lg border border-border bg-background px-3 py-2"
                value={b.strategy_id}
                onChange={(e) => updateBot(b.id, { strategy_id: e.target.value })}
              >
                <option value="">Select a strategy…</option>
                {strategyOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            {/* Controls ABOVE start/stop so users can set them before starting */}
            <div className="w-full space-y-3">
              {/* Trading mode */}
              <div className="w-full space-y-1">
                <label className="block text-xs text-muted-foreground">Trading mode</label>

                <div className="flex w-full flex-wrap items-center gap-2">
                  <select
                    className="w-full max-w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    value={b.mode}
                    onChange={(e) => updateBot(b.id, { mode: e.target.value as any })}
                  >
                    <option value="backtest">Backtest</option>
                    <option value="paper" disabled={!isPro}>
                      Paper{!isPro ? " (Pro only)" : ""}
                    </option>
                    <option value="live" disabled={!isPro}>
                      Live{!isPro ? " (Pro only)" : ""}
                    </option>
                  </select>
                </div>
              </div>

              {/* Bot settings (block) */}
              <div className="w-full space-y-1">
                <label className="block text-xs text-muted-foreground">Bot settings</label>

                <button
                  type="button"
                  onClick={() => b.strategy_id && (setEditingBotId(b.id), setShowSettings(true))}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                  title="Bot settings"
                  disabled={!b.strategy_id}
                >
                  ⚙️ Bot settings
                </button>
              </div>

              {/* Keep Remove as-is (still above Start/Stop) */}
              <div className="w-full">
                <button
                  type="button"
                  onClick={() => removeBot(b.id)}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm text-rose-500 hover:bg-rose-500/10 whitespace-nowrap"
                  title="Remove bot"
                >
                  Remove
                </button>
              </div>
            </div>

            {/* EXTRA card action row (Start/Stop only) */}
            <div className="grid grid-cols-2 gap-2 mt-auto">
              <button
                onClick={() => startSingle(b)}
                disabled={!b.strategy_id || !b.account_id || (!isPro && (b.mode === "paper" || b.mode === "live"))}
                className={`w-full rounded-lg px-3 py-2 font-semibold ${
                  !b.strategy_id || !b.account_id || (!isPro && (b.mode === "paper" || b.mode === "live"))
                    ? "border border-border bg-muted text-muted-foreground cursor-not-allowed"
                    : "bg-ysbPurple text-ysbYellow hover:opacity-90"
                }`}
              >
                {isRunRunning(runIdOf(b)) ? "RESTART" : "START"}
              </button>

              <button
                onClick={() => stopRun(runIdOf(b))}
                className="w-full rounded-lg border border-border px-3 py-2 font-semibold text-muted-foreground hover:text-foreground"
                type="button"
              >
                Stop
              </button>
            </div>
          </div>
        ))}

        {/* Add Bot card (always visible, no hard limit) */}
        <button
          type="button"
          onClick={addBot}
          className="rounded-2xl border border-dashed border-border bg-transparent p-4 flex items-center justify-center hover:bg-muted/30 transition-colors h-full"
          title="Add bot"
        >
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-ysbPurple text-ysbYellow text-3xl shadow-xl">
              +
            </div>
            <div className="text-sm text-muted-foreground">Add bot</div>
          </div>
        </button>
      </div>

      {/* Live logs */}
      <div className="rounded-2xl border border-border bg-card p-4 min-w-0">
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

        {(() => {
          const toMs = (t: any) => {
            const n = typeof t === "number" ? t : Date.parse(String(t));
            return Number.isFinite(n) ? n : 0;
          };

          const first = logs?.[0];
          const last = logs?.[Math.max(0, (logs?.length ?? 0) - 1)];
          const newestFirst = toMs(first?.ts) > toMs(last?.ts);

          const visibleLogs = newestFirst ? (logs ?? []).slice(0, 400) : (logs ?? []).slice(-400);

          return (
            <div className="max-h-[28rem] w-full min-w-0 overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-background p-2 font-mono text-xs text-muted-foreground">
              {visibleLogs.map((l: any, i: number) => (
                <div
                  key={`${String(l?.ts ?? "")}-${String(l?.message ?? "")}-${i}`}
                  className="max-w-full whitespace-pre-wrap break-all"
                >
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
          );
        })()}
      </div>

      {showSettings && (
        <StrategySettingsModal
          params={editingBotId ? (bots.find((b: any) => b.id === editingBotId)?.params ?? params) : params}
          risk={risk}
          savingRisk={savingRisk}
          lastMaxDailyLoss={lastMaxDailyLoss}
          setLastMaxDailyLoss={setLastMaxDailyLoss}
          fields={(
            STRATEGY_SETTINGS[
              ((editingBotId ? bots.find((b: any) => b.id === editingBotId)?.strategy_id : strategyId) ?? "") as any
            ] ?? []
          ).filter((f: any) => f.category !== "execution")}
          onClose={() => {
            setShowSettings(false);
            setEditingBotId(null);
          }}
          onSave={async (nextParams, nextRisk) => {
            // Save bot params (per-card or primary)
            if (editingBotId) {
              const b = bots.find((x: any) => x.id === editingBotId);
              if (b) {
                updateBot(editingBotId, { params: nextParams });

                // Persist without enabling globally
                await apiFetch(api.strategies.setSettings.path, {
                  method: "POST",
                  body: JSON.stringify({
                    account_id: b.account_id,
                    symbol: b.symbol,
                    timeframe: b.timeframe,
                    strategy_id: b.strategy_id,
                    params: nextParams,
                    enabled: false,
                  }),
                }).catch(() => void 0);
              }
            } else {
              setParams(nextParams);
              await persistSettings(nextParams, false);
            }

            // Save global risk rules (edited from modal)
            if (nextRisk) {
              await saveRisk(nextRisk);
            }

            setShowSettings(false);
            setEditingBotId(null);
          }}
        />
      )}
    </div>
  );
}

function InstrumentPicker({
  title,
  instruments,
  isLoading,
  error,
  symbol,
  onSymbolChange,
  filters,
  onFiltersChange,
}: {
  title: string;
  instruments: any[];
  isLoading: boolean;
  error: string | null;
  symbol: string;
  onSymbolChange: (s: string) => void;
  filters: InstrumentFilters;
  onFiltersChange: (next: InstrumentFilters) => void;
}) {
  const markets = useMemo(() => {
    const m = new Map<string, number>();
    (instruments ?? []).forEach((i: any) => {
      const k = instrumentMarket(i);
      m.set(k, (m.get(k) ?? 0) + 1);
    });
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
  }, [instruments]);

  const filtered = useMemo(() => {
    const q = String(filters.q ?? "").trim().toLowerCase();
    const mm = String(filters.market ?? "");

    return (instruments ?? [])
      .filter((i: any) => {
        const sym = String(i?.symbol ?? "");
        if (!sym) return false;

        if (mm && instrumentMarket(i) !== mm) return false;
        if (!q) return true;

        const name = String(i?.display_name ?? "");
        const group = instrumentSubmarket(i); // still searchable, just not a filter
        return (
          sym.toLowerCase().includes(q) ||
          name.toLowerCase().includes(q) ||
          group.toLowerCase().includes(q) ||
          instrumentMarket(i).toLowerCase().includes(q)
        );
      })
      .sort((a: any, b: any) => {
        const am = instrumentMarket(a);
        const bm = instrumentMarket(b);
        if (am !== bm) return am.localeCompare(bm);
        return String(a?.display_name ?? a?.symbol ?? "").localeCompare(String(b?.display_name ?? b?.symbol ?? ""));
      });
  }, [instruments, filters.market, filters.q]);

  const currentInList = useMemo(() => {
    const s = String(symbol ?? "").trim();
    if (!s) return true;
    return (instruments ?? []).some((i: any) => String(i?.symbol ?? "") === s);
  }, [instruments, symbol]);

  return (
    <div className="rounded-xl border border-border bg-background p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{title}</div>
        {isLoading ? <div className="text-xs text-muted-foreground">Loading…</div> : null}
      </div>

      {error ? <div className="text-xs text-rose-400">Failed to load instruments: {error}</div> : null}

      {/* Market only (Category removed) */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Market</label>
        <select
          className="w-full rounded-lg border border-border bg-background px-3 py-2"
          value={filters.market}
          disabled={isLoading}
          onChange={(e) => onFiltersChange({ ...filters, market: e.target.value })}
        >
          <option value="">All markets</option>
          {markets.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">Search</label>
        <input
          className="w-full rounded-lg border border-border bg-background px-3 py-2"
          placeholder="Search by symbol or name…"
          value={filters.q}
          onChange={(e) => onFiltersChange({ ...filters, q: e.target.value })}
        />
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">Symbol</label>
        <select
          className="w-full rounded-lg border border-border bg-background px-3 py-2"
          value={String(symbol ?? "")}
          disabled={isLoading}
          onChange={(e) => onSymbolChange(e.target.value)}
        >
          {!currentInList && symbol ? <option value={symbol}>Custom: {symbol}</option> : null}

          {filtered.slice(0, 500).map((i: any) => {
            const sym = String(i?.symbol ?? "");
            const label = instrumentLabel(i);
            const meta = `${instrumentMarket(i)}`;
            return (
              <option key={sym} value={sym}>
                {label} — {meta}
              </option>
            );
          })}
        </select>

        {filtered.length > 500 ? (
          <div className="mt-1 text-[11px] text-muted-foreground">Showing first 500 instruments for performance.</div>
        ) : null}
      </div>
    </div>
  );
}

function StrategySettingsModal({
  params,
  onSave,
  onClose,
  fields,
  risk,
  savingRisk,
  lastMaxDailyLoss,
  setLastMaxDailyLoss,
}: {
  params: StrategyParams;
  fields: {
    key: string;
    label: string;
    type: "number" | "select" | "boolean" | "text";
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
    default?: string | number | boolean;
  }[];
  risk: RiskRules | null;
  savingRisk: boolean;
  lastMaxDailyLoss: number;
  setLastMaxDailyLoss: (n: number) => void;
  onSave: (p: StrategyParams, nextRisk?: RiskRules) => void | Promise<void>;
  onClose: () => void;
}) {
  // ✅ allow "" while typing in number inputs (prevents the forced 0 issue)
  const [form, setForm] = reactUseState<Record<string, any>>(params);

  // Modal-local risk UI state (global rule edited here)
  const [mdlEnabled, setMdlEnabled] = reactUseState<boolean>(Number(risk?.max_daily_loss ?? 0) > 0);

  // ✅ store as string so user can clear input without it snapping to 0
  const [mdlValue, setMdlValue] = reactUseState<string>(() => {
    const current = Number(risk?.max_daily_loss ?? 0);
    if (Number.isFinite(current) && current > 0) return String(Math.max(0, current));
    return String(Math.max(0, Number(lastMaxDailyLoss ?? 50) || 50));
  });

  const earlyEnabled = Boolean(form.early_sell_enabled ?? false);

  const parseNum = (v: any): number | undefined => {
    if (v === "" || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const normalizeForSave = (): StrategyParams => {
    const next: Record<string, any> = { ...(form ?? {}) };

    // required execution fields
    {
      const stake = parseNum(next.stake);
      next.stake = stake ?? Number(params.stake ?? 250);

      const duration = parseNum(next.duration);
      next.duration = Math.max(1, duration ?? Number(params.duration ?? 5));

      next.duration_unit = (next.duration_unit ?? params.duration_unit ?? "m") as DurationUnit;

      const mot = parseNum(next.max_open_trades);
      next.max_open_trades = Math.max(1, mot ?? Number(params.max_open_trades ?? 5));

      // ✅ NEW: cooldown_after_loss (seconds)
      const cd = parseNum(next.cooldown_after_loss);
      next.cooldown_after_loss = Math.max(
        0,
        Math.floor(cd ?? (Number(params.cooldown_after_loss ?? 0) || 0)),
      );
    }

    // early sell
    next.early_sell_enabled = Boolean(next.early_sell_enabled);
    {
      const esp = parseNum(next.early_sell_profit);
      // if blank, keep prior value instead of forcing 0
      next.early_sell_profit = Math.max(0, esp ?? Number(params.early_sell_profit ?? 0));
    }

    // strategy-specific numeric fields: if blank, revert to default (or remove)
    for (const f of fields ?? []) {
      if (f.type !== "number") continue;

      const raw = next[f.key];
      const n = parseNum(raw);

      if (raw === "") {
        if (f.default !== undefined) next[f.key] = f.default;
        else delete next[f.key];
      } else if (n === undefined) {
        if (f.default !== undefined) next[f.key] = f.default;
      } else {
        next[f.key] = n;
      }
    }

    return next as StrategyParams;
  };

  const buildNextRisk = (): RiskRules | undefined => {
    if (!risk) return undefined;

    const n = parseNum(mdlValue);
    const fallback = Math.max(0, Number(lastMaxDailyLoss ?? 50) || 50);
    const nextVal = mdlEnabled ? Math.max(0, n ?? fallback) : 0;

    if (mdlEnabled && nextVal > 0) setLastMaxDailyLoss(nextVal);
    return { ...(risk ?? {}), max_daily_loss: nextVal };
  };

  // keep modal in sync when opening for a different bot
  useEffect(() => {
    setForm(params);
  }, [params]);

  // keep risk UI in sync if risk loads after modal opens
  useEffect(() => {
    const current = Number(risk?.max_daily_loss ?? 0);
    const enabled = Number.isFinite(current) && current > 0;
    setMdlEnabled(enabled);

    if (enabled) {
      const v = Math.max(0, current);
      setMdlValue(String(v));
      if (v > 0) setLastMaxDailyLoss(v);
    } else {
      setMdlValue((v) => (String(v ?? "").trim() ? String(v) : String(Math.max(0, Number(lastMaxDailyLoss ?? 50) || 50))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [risk]);

  return (
    // ✅ overlay scrolls on small screens
    <div className="fixed inset-0 z-50 bg-black/60 p-4 overflow-y-auto">
      <div className="mx-auto w-full max-w-lg">
        {/* ✅ modal has a max height; inner content scrolls */}
        <div className="rounded-2xl border border-border bg-card max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden">
          {/* Header */}
          <div className="p-5">
            <div className="text-xl font-semibold mb-1">Strategy Configuration</div>
            <div className="text-sm text-muted-foreground">Adjust the parameters.</div>
          </div>

          {/* Body (scrollable) */}
          <div className="px-5 pb-5 overflow-y-auto">
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">Stake ($)</label>
                <input
                  type="number"
                  inputMode="decimal"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2"
                  value={form.stake ?? ""}
                  onChange={(e) => setForm({ ...form, stake: e.target.value })}
                />
              </div>

              {!!fields.length && (
                <div className="grid gap-3 md:grid-cols-2">
                  {fields.map((f) => (
                    <div key={f.key}>
                      <label className="block text-sm mb-1">{f.label}</label>

                      {f.type === "number" && (
                        <input
                          type="number"
                          inputMode="decimal"
                          className="w-full rounded-lg border border-border bg-background px-3 py-2"
                          min={f.min}
                          max={f.max}
                          step={f.step}
                          value={form[f.key] ?? ""}
                          onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                        />
                      )}

                      {f.type === "select" && (
                        <select
                          className="w-full rounded-lg border border-border bg-background px-3 py-2"
                          value={String(form[f.key] ?? f.default ?? "")}
                          onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                        >
                          {(f.options ?? []).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      )}

                      {f.type === "boolean" && (
                        <input
                          type="checkbox"
                          checked={Boolean(form[f.key] ?? f.default ?? false)}
                          onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })}
                        />
                      )}

                      {f.type === "text" && (
                        <input
                          type="text"
                          className="w-full rounded-lg border border-border bg-background px-3 py-2"
                          value={String(form[f.key] ?? f.default ?? "")}
                          onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="block text-sm mb-1">
                    {form.duration_unit === "t" ? "Tick Count" : "Expiry Duration"}
                  </label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={1}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2"
                    value={form.duration ?? ""}
                    onChange={(e) => setForm({ ...form, duration: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1">Unit</label>
                  <select
                    className="w-full rounded-lg border border-border bg-background px-3 py-2"
                    value={form.duration_unit ?? "m"}
                    onChange={(e) => setForm({ ...form, duration_unit: e.target.value as DurationUnit })}
                  >
                    <option value="t">Ticks</option>
                    <option value="m">Minutes</option>
                    <option value="h">Hours</option>
                    <option value="d">Days</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm mb-1">Max open trades</label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2"
                  value={form.max_open_trades ?? ""}
                  onChange={(e) => setForm({ ...form, max_open_trades: e.target.value })}
                />
              </div>

              {/* ✅ NEW */}
              <div>
                <label className="block text-sm mb-1">Cooldown after loss (sec)</label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2"
                  value={form.cooldown_after_loss ?? ""}
                  onChange={(e) => setForm({ ...form, cooldown_after_loss: e.target.value })}
                />
                <div className="mt-1 text-xs text-muted-foreground">
                  After a losing trade, execution pauses for this many seconds (signals still run). Set to 0 to disable.
                </div>
              </div>

              <div>
                <label className="block text-sm mb-1">Early sell profit (USD)</label>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.01}
                  disabled={!earlyEnabled}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 disabled:opacity-50"
                  value={form.early_sell_profit ?? ""}
                  onChange={(e) => setForm({ ...form, early_sell_profit: e.target.value })}
                />

                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={earlyEnabled ? "Disable early sell" : "Enable early sell"}
                    aria-pressed={earlyEnabled}
                    onClick={() => setForm((f) => ({ ...f, early_sell_enabled: !Boolean(f.early_sell_enabled) }))}
                    className={[
                      "relative inline-flex h-6 w-11 items-center rounded-full border transition-colors",
                      earlyEnabled ? "bg-emerald-500/20 border-emerald-500/40" : "bg-muted/40 border-border",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "inline-block h-5 w-5 transform rounded-full bg-white/90 shadow transition-transform",
                        earlyEnabled ? "translate-x-5" : "translate-x-1",
                      ].join(" ")}
                    />
                  </button>
                  <label className="text-sm select-none">Enable early sell</label>
                </div>
              </div>

              {risk && (
                <div>
                  <div className="flex items-center justify-between">
                    <label className="block text-sm mb-1">Max daily loss ($)</label>
                    {savingRisk ? <div className="text-xs text-muted-foreground">Saving…</div> : null}
                  </div>

                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={1}
                    disabled={!mdlEnabled}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 disabled:opacity-50"
                    value={mdlValue}
                    onChange={(e) => {
                      const v = e.target.value;
                      setMdlValue(v);
                      const n = parseNum(v);
                      if (n !== undefined && n > 0) setLastMaxDailyLoss(n);
                    }}
                  />

                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      aria-label={mdlEnabled ? "Disable max daily loss" : "Enable max daily loss"}
                      aria-pressed={mdlEnabled}
                      onClick={() => {
                        const enabled = !mdlEnabled;
                        setMdlEnabled(enabled);

                        if (enabled) {
                          // if enabling with empty/invalid, restore last known sensible value
                          const n = parseNum(mdlValue);
                          if (n === undefined || n <= 0) {
                            setMdlValue(String(Math.max(0, Number(lastMaxDailyLoss ?? 50) || 50)));
                          }
                        }
                      }}
                      className={[
                        "relative inline-flex h-6 w-11 items-center rounded-full border transition-colors",
                        mdlEnabled ? "bg-emerald-500/20 border-emerald-500/40" : "bg-muted/40 border-border",
                      ].join(" ")}
                    >
                      <span
                        className={[
                          "inline-block h-5 w-5 transform rounded-full bg-white/90 shadow transition-transform",
                          mdlEnabled ? "translate-x-5" : "translate-x-1",
                        ].join(" ")}
                      />
                    </button>
                    <label className="text-sm select-none">Enable max daily loss</label>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Footer (always visible) */}
          <div className="px-5 pb-5 pt-3 flex items-center justify-end gap-2">
            <button
              className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow hover:opacity-90 disabled:opacity-50"
              disabled={savingRisk}
              onClick={() => onSave(normalizeForSave(), buildNextRisk())}
              type="button"
            >
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}