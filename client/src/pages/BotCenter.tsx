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

type UIBot = {
  id: string;
  account_id: string;
  symbol: string;
  timeframe: string;
  strategy_id: string;
  mode: "backtest" | "paper" | "live";
  params: Record<string, any>;
  enabled: boolean;
};

export default function BotCenter() {
  const { toast } = useToast();
  const { data: accounts } = useAccounts();
  const { data: sub } = useSubscription();
  const { data: status } = useBotStatus();
  const startBot = useStartBot();
  const stopBot = useStopBot();

  const { logs, clearLogs } = useRuntimeEvents();

  const availableAccounts = useMemo(() => accounts ?? [], [accounts]);
  const isPro = sub?.plan === "pro";

  // All user bots as independent cards
  const [bots, setBots] = usePersistedState<UIBot[]>("bot:cards:v1", []);
  const [editingBotId, setEditingBotId] = reactUseState<string | null>(null);
  const [showSettings, setShowSettings] = usePersistedState<boolean>("bot:showSettings", false);

  // Keep server awake while this page is open (poll /api/health every 4 minutes)
  useKeepAlive(true, 240_000);

  // Ensure at least one account is selected on first add
  useEffect(() => {
    if (!bots.length && availableAccounts.length === 0) {
      // no-op; UI will still allow adding, but account select will be empty
    }
  }, [availableAccounts, bots.length]);

  const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const computeExecUnit = (tf: string): "t" | "m" | "h" | "d" => {
    if (tf === "1s") return "t";
    if (tf.endsWith("m")) return "m";
    if (tf.endsWith("h")) return "h";
    return "d";
  };

  const addBot = () => {
    const account_id = availableAccounts[0]?.id ?? "";
    const timeframe = "1m";
    const params = { stake: 250, duration: 5, duration_unit: computeExecUnit(timeframe) };
    const b: UIBot = {
      id: makeId(),
      account_id,
      symbol: "R_100",
      timeframe,
      strategy_id: "",
      mode: "paper",
      params,
      enabled: true,
    };
    setBots((s) => [...s, b]);
    toast({ title: "Bot added", description: `${b.symbol} · ${b.timeframe}` });
  };

  const updateBot = (id: string, patch: Partial<UIBot>) => {
    setBots((s) =>
      s.map((b) => {
        if (b.id !== id) return b;
        // adjust execution unit if timeframe changes
        if (patch.timeframe && patch.timeframe !== b.timeframe) {
          const du = computeExecUnit(patch.timeframe);
          return {
            ...b,
            ...patch,
            params: { ...b.params, duration_unit: du, duration: Math.max(1, Number(b.params?.duration ?? 5)) },
          };
        }
        // merge strategy defaults on strategy change (keep execution fields)
        if (patch.strategy_id && patch.strategy_id !== b.strategy_id) {
          const defaults = getStrategyDefaults(patch.strategy_id);
          const execKeys = new Set(["stake", "duration", "duration_unit"]);
          const exec = {
            stake: Number(b.params?.stake ?? 250),
            duration: Number(b.params?.duration ?? 5),
            duration_unit: (b.params?.duration_unit as any) ?? computeExecUnit(b.timeframe),
          };
          const nextParams: Record<string, any> = { ...defaults, ...Object.fromEntries(Object.entries(b.params || {}).filter(([k]) => execKeys.has(k))), ...exec };
          return { ...b, ...patch, params: nextParams };
        }
        return { ...b, ...patch };
      })
    );
  };

  const removeBot = (id: string) => setBots((s) => s.filter((b) => b.id !== id));

  const persistBotSettings = async (b: UIBot) => {
    if (!b.account_id) return;
    try {
      await apiFetch(api.strategies.setSettings.path, {
        method: "POST",
        body: JSON.stringify({
          account_id: b.account_id,
          symbol: b.symbol,
          timeframe: b.timeframe,
          strategy_id: b.strategy_id,
          params: b.params,
          enabled: true,
        }),
      });
    } catch {
      /* ignore */
    }
  };

  // Start one card but send ALL enabled cards to server so they run together
  const startSingle = async (target: UIBot) => {
    try {
      if (!isPro && (target.mode === "paper" || target.mode === "live")) {
        toast({ title: "Upgrade required", description: "Paper/Live requires Pro.", variant: "destructive" });
        return;
      }
      if (!target.account_id || !target.strategy_id) {
        toast({ title: "Missing fields", description: "Select account and strategy.", variant: "destructive" });
        return;
      }

      // best-effort persist each bot's settings server-side
      await Promise.all(bots.map((b) => persistBotSettings(b)).map((p) => p.catch(() => void 0)));

      const enabled = bots.filter((b) => b.enabled && b.account_id && b.strategy_id);
      if (!enabled.length) {
        toast({ title: "No valid bots", description: "Configure at least one complete bot.", variant: "destructive" });
        return;
      }

      await startBot.mutateAsync({
        name: "YSB Bot",
        configs: enabled.map((b) => ({
          account_id: b.account_id,
          symbol: b.symbol,
          timeframe: b.timeframe,
          strategy_id: b.strategy_id,
          mode: b.mode,
          params: b.params,
          enabled: true,
        })),
      });
      toast({ title: "Bots started", description: `${enabled.length} config(s) running.` });
    } catch (e: any) {
      toast({ title: "Start failed", description: String(e?.message ?? e), variant: "destructive" });
    }
  };

  const stopAll = async () => {
    try {
      await stopBot.mutateAsync();
      toast({ title: "All bots stopped" });
    } catch (e: any) {
      toast({ title: "Stop failed", description: String(e?.message ?? e), variant: "destructive" });
    }
  };

  const editingBot = editingBotId ? bots.find((b) => b.id === editingBotId) ?? null : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-2xl font-semibold">Control Panel</div>
        <div className="flex items-center gap-3">
          <button onClick={stopAll} className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground">Stop All</button>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status?.state === "running" ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-600/20 text-zinc-300"}`}>
            {status?.state === "running" ? "RUNNING" : "STOPPED"}
          </span>
        </div>
      </div>
      <div className="text-sm text-muted-foreground">Add multiple bots. Each card runs independently with its own settings.</div>

      {/* Main layout: bot cards (left) + live logs (right) */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Bot cards grid */}
        <div className="lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-2">
            {bots.length === 0 && (
              <div className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">
                No bots yet. Click the big + button to add one.
              </div>
            )}
            {bots.map((b) => (
              <div key={b.id} className="rounded-2xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-sm text-muted-foreground">Bot</div>
                    <div className="font-semibold font-mono">
                      {b.symbol} · {b.timeframe} · {b.strategy_id || "no-strategy"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => startSingle(b)}
                      className="rounded-lg bg-ysbPurple px-3 py-2 text-sm font-semibold text-ysbYellow hover:opacity-90"
                      disabled={!b.account_id || !b.strategy_id || (!isPro && (b.mode === "paper" || b.mode === "live"))}
                    >
                      Start
                    </button>
                    <button
                      onClick={() => removeBot(b.id)}
                      className="rounded-lg border border-border px-3 py-2 text-sm text-rose-500"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
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
                    <label className="block text-sm">Symbol</label>
                    <input
                      className="w-full rounded-lg border border-border bg-background px-3 py-2"
                      value={b.symbol}
                      onChange={(e) => updateBot(b.id, { symbol: e.target.value })}
                    />
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

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-sm">Strategy</label>
                    <select
                      className="w-full rounded-lg border border-border bg-background px-3 py-2"
                      value={b.strategy_id}
                      onChange={(e) => updateBot(b.id, { strategy_id: e.target.value })}
                    >
                      <option value="">Select a strategy…</option>
                      {[
                        "candle_pattern",
                        "one_hour_trend",
                        "trend_confirmation",
                        "scalping_hwr",
                        "trend_pullback",
                        "supply_demand_sweep",
                        "fvg_retracement",
                        "range_mean_reversion",
                      ].map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm">Mode</label>
                    <select
                      className="w-full rounded-lg border border-border bg-background px-3 py-2"
                      value={b.mode}
                      onChange={(e) => updateBot(b.id, { mode: e.target.value as UIBot["mode"] })}
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
                  <div>
                    <label className="block text-sm">Stake</label>
                    <input
                      type="number"
                      className="w-full rounded-lg border border-border bg-background px-3 py-2"
                      value={Number(b.params?.stake ?? 0)}
                      onChange={(e) =>
                        updateBot(b.id, { params: { ...(b.params || {}), stake: Number(e.target.value) } })
                      }
                    />
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-background p-3">
                  <div className="text-sm text-muted-foreground mb-2">Settings</div>
                  {!b.strategy_id ? (
                    <div className="text-xs text-muted-foreground">Select a strategy to configure.</div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono">
                      {Object.entries(b.params)
                        .filter(([k]) => !["stake", "duration", "duration_unit"].includes(k))
                        .slice(0, 5)
                        .map(([k, v]) => (
                          <div key={k}>
                            {k}: <span className="text-foreground">{String(v)}</span>
                          </div>
                        ))}
                      <div>
                        Expiry:{" "}
                        <span className="text-foreground">
                          {b.params?.duration}
                          {b.params?.duration_unit}
                        </span>
                      </div>
                    </div>
                  )}
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingBotId(b.id);
                        setShowSettings(true);
                      }}
                      className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
                      title="Strategy settings"
                      disabled={!b.strategy_id}
                    >
                      ⚙️ Edit
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Live logs card */}
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
          <div className="h-96 overflow-auto rounded-lg border border-border bg-background p-2 font-mono text-xs text-muted-foreground">
            {logs.slice(0, 200).map((l, i) => (
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
      </div>

      {showSettings && (
        <StrategySettingsModal
          params={
            editingBot
              ? editingBot.params
              : { stake: 250, duration: 5, duration_unit: "m" as const }
          }
          fields={
            (STRATEGY_SETTINGS[(editingBot?.strategy_id ?? "") as keyof typeof STRATEGY_SETTINGS] ?? []).filter(
              (f) => f.category !== "execution"
            )
          }
          onClose={() => {
            setShowSettings(false);
            setEditingBotId(null);
          }}
          onSave={async (next) => {
            if (editingBot) {
              updateBot(editingBot.id, { params: next });
              await persistBotSettings({ ...editingBot, params: next });
            }
            setShowSettings(false);
            setEditingBotId(null);
          }}
        />
      )}

      {/* Big fixed + button on the side */}
      <button
        onClick={addBot}
        title="Add bot"
        className="fixed right-6 top-1/2 -translate-y-1/2 z-50 flex h-16 w-16 items-center justify-center rounded-full bg-ysbPurple text-ysbYellow text-4xl shadow-xl"
      >
        +
      </button>
    </div>
  );
}

function StrategySettingsModal({
  params,
  onSave,
  onClose,
  fields,
}: {
  params: { stake: number; duration: number; duration_unit: "m" | "h" | "d" | "t"; [k: string]: any };
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
            <input
              type="number"
              className="w-full rounded-lg border border-border bg-background px-3 py-2"
              value={form.stake}
              onChange={(e) => setForm({ ...form, stake: Number(e.target.value) })}
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
                      className="w-full rounded-lg border border-border bg-background px-3 py-2"
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      value={Number(form[f.key] ?? f.default ?? 0)}
                      onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
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
                min={1}
                className="w-full rounded-lg border border-border bg-background px-3 py-2"
                value={form.duration}
                onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-sm mb-1">Unit</label>
              <select
                className="w-full rounded-lg border border-border bg-background px-3 py-2"
                value={form.duration_unit}
                onChange={(e) => setForm({ ...form, duration_unit: e.target.value as any })}
              >
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
function useState(params: { [k: string]: any; stake: number; duration: number; duration_unit: "m" | "h" | "d" | "t" }): [any, any] {
  return reactUseState(params);
}
