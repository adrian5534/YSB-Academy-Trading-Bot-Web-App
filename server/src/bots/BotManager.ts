import { DerivClient } from "../deriv/DerivClient";
import { getStrategy } from "../strategies";
import type { StrategyContext } from "../strategies/types";
import { canOpenTrade, computeStake, getRiskRules } from "../risk/riskEngine";
import { supabaseAdmin } from "../supabase";
import type { WsHub } from "../ws/hub";
import { runBacktest } from "../backtests/runBacktest";
import { v4 as uuidv4 } from "uuid";

type BotConfig = {
  id: string;
  account_id: string;
  symbol: string;
  timeframe: string;
  strategy_id: string;
  mode: "backtest" | "paper" | "live";
  params: Record<string, any>;
  enabled: boolean;
};

type Running = {
  userId: string;
  runId: string;
  name: string;
  state: "stopped" | "running";
  started_at: string | null;
  heartbeat_at: string | null;
  configs: BotConfig[];
  timer?: NodeJS.Timeout;
};

export class BotManager {
  private runs = new Map<string, Running>(); // key = `${userId}::${runId}`
  // Removed global DerivClient; use per-account clients only.
  private derivClients = new Map<string, DerivClient>();
  // Track open trades per run/config
  private openCounts = new Map<string, number>();

  private runKey(userId: string, runId: string) {
    return `${userId}::${runId}`;
  }

  private cfgKey(bot: Running, cfg: BotConfig) {
    return `${bot.userId}::${bot.runId}::${cfg.id}`;
  }

  private getOpenCount(bot: Running, cfg: BotConfig) {
    return this.openCounts.get(this.cfgKey(bot, cfg)) ?? 0;
  }

  private incOpen(bot: Running, cfg: BotConfig) {
    const k = this.cfgKey(bot, cfg);
    this.openCounts.set(k, (this.openCounts.get(k) ?? 0) + 1);
  }

  private decOpen(bot: Running, cfg: BotConfig) {
    const k = this.cfgKey(bot, cfg);
    const v = (this.openCounts.get(k) ?? 0) - 1;
    if (v <= 0) this.openCounts.delete(k);
    else this.openCounts.set(k, v);
  }

  private clearRunOpenCounts(userId: string, runId: string) {
    const prefix = `${userId}::${runId}::`;
    for (const k of Array.from(this.openCounts.keys())) {
      if (k.startsWith(prefix)) this.openCounts.delete(k);
    }
  }

  constructor(private hub: WsHub) {
    // No global streaming client. All market data access is scoped via per-account clients.
  }

  // Status with per-run list
  getStatus(userId: string) {
    const runs = Array.from(this.runs.values())
      .filter((r) => r.userId === userId)
      .map((r) => ({
        run_id: r.runId,
        name: r.name,
        state: r.state,
        started_at: r.started_at,
        heartbeat_at: r.heartbeat_at,
        active_configs: r.configs.filter((c) => c.enabled).length,
      }));

    const anyRunning = runs.some((r) => r.state === "running");
    return {
      state: anyRunning ? "running" : "stopped",
      started_at: anyRunning ? runs[0]?.started_at ?? null : null,
      heartbeat_at: anyRunning ? runs[0]?.heartbeat_at ?? null : null,
      active_configs: runs.reduce((n, r) => n + r.active_configs, 0),
      runs,
    };
  }

  // Start ONLY this runId
  async start(userId: string, name: string, configs: Omit<BotConfig, "id">[]) {
    await this.startById(userId, name, name, configs);
  }

  async startById(userId: string, runId: string, name: string, configs: Omit<BotConfig, "id">[]) {
    const key = this.runKey(userId, runId);
    const existing = this.runs.get(key);
    if (existing?.timer) clearInterval(existing.timer);

    const bot: Running = {
      userId,
      runId,
      name,
      state: "running",
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      configs: configs.map((c) => ({ ...c, id: uuidv4() })),
    };
    this.runs.set(key, bot);

    this.hub.log("bot.configs", { userId, runId, name, configs: bot.configs });
    bot.timer = setInterval(() => {
      void this.tick(bot).catch((e: any) =>
        this.hub.log(`tick error: ${e?.stack || e?.message || String(e)}`)
      );
    }, 5000);

    this.hub.status(this.getStatus(userId));
    this.hub.log("bot started", { userId, runId, name, configs: bot.configs.length });
  }

  // Deprecated global stop; keep no-op unless name provided (back-compat)
  async stop(userId: string, name?: string) {
    if (!name) {
      this.hub.log("stop called without name; ignoring to avoid stop-all", { userId });
      return;
    }
    const key = this.runKey(userId, name);
    const bot = this.runs.get(key);
    if (bot?.timer) clearInterval(bot.timer);
    this.runs.delete(key);
    this.clearRunOpenCounts(userId, name);
    this.hub.log("bot stopped", { userId, runId: name });
    this.hub.status(this.getStatus(userId));
  }

  // Stop this specific runId
  async stopById(userId: string, runId: string) {
    const key = this.runKey(userId, runId);
    const bot = this.runs.get(key);
    if (bot?.timer) clearInterval(bot.timer);
    this.runs.delete(key);
    this.clearRunOpenCounts(userId, runId);
    this.hub.log("bot stopped", { userId, runId });
    this.hub.status(this.getStatus(userId));
  }

  private async getDerivClient(accountId: string, token: string) {
    const existing = this.derivClients.get(accountId);
    if (existing) return existing;
    const c = new DerivClient(token);
    c.setOnMessage((msg: any) => {
      try {
        if (msg?.tick) this.handleTickSafely(msg.tick);
      } catch (e) {
        console.error(
          "tick error (per-account)",
          (e as any) && ((e as any).stack || (e as any).message || e)
        );
        try {
          console.debug("tick payload (per-account):", JSON.stringify(msg));
        } catch {}
      }
    });
    await c.connect();
    this.derivClients.set(accountId, c);
    return c;
  }

  private async accountToken(accountId: string): Promise<string> {
    const { data, error } = await supabaseAdmin
      .from("accounts")
      .select("secrets")
      .eq("id", accountId)
      .maybeSingle();
    if (error) throw error;
    const secrets = (data?.secrets ?? {}) as any;
    const enc = secrets?.deriv_token_enc;
    if (!enc) throw new Error("No Deriv token stored for account");
    const { decryptJson } = await import("../crypto/secrets");
    const dec: any = decryptJson(enc as any);
    const token = String(dec?.token ?? "");
    if (!token) throw new Error("Deriv token decrypt returned empty token");
    return token;
  }

  private async tick(bot: Running) {
    // Only touch this run
    bot.heartbeat_at = new Date().toISOString();
    this.hub.status(this.getStatus(bot.userId));

    for (const cfg of bot.configs.filter((c) => c.enabled)) {
      try {
        await this.runConfig(bot, cfg);
      } catch (e: any) {
        this.hub.log(
          `runConfig error: ${e?.stack || e?.message || String(e)}`,
          { symbol: cfg.symbol, timeframe: cfg.timeframe, strategy_id: cfg.strategy_id }
        );
      }
    }
  }

  private async runConfig(bot: Running, cfg: BotConfig) {
    // Load account to get type + token
    const { data: acc, error: accErr } = await supabaseAdmin
      .from("accounts")
      .select("type,secrets")
      .eq("id", cfg.account_id)
      .maybeSingle();
    if (accErr) throw accErr;
    if (!acc) throw new Error("account missing");

    if (acc.type !== "deriv") {
      this.hub.log("skipping non-deriv account", { accountId: cfg.account_id, accountType: acc.type });
      return;
    }

    let token = "";
    try {
      token = await this.accountToken(cfg.account_id);
    } catch (e) {
      this.hub.log("Failed to decrypt Deriv token", { error: String(e) });
      return;
    }
    if (!token) {
      this.hub.log("Deriv token missing after decrypt", { accountId: cfg.account_id });
      return;
    }

    const deriv = await this.getDerivClient(cfg.account_id, token);
    const granSec = timeframeToSec(cfg.timeframe);
    const raw = await deriv.candles(cfg.symbol, granSec, 120);
    const candles = raw.map((c: any) => ({
      t: Number(c.epoch),
      o: Number(c.open),
      h: Number(c.high),
      l: Number(c.low),
      c: Number(c.close),
      v: Number(c.volume ?? 0),
    }));

    // Backtest mode
    if (cfg.mode === "backtest") {
      try {
        this.hub.log("starting backtest", { symbol: cfg.symbol, timeframe: cfg.timeframe, accountId: cfg.account_id });

        interface BacktestCandle {
          t: number; // epoch seconds
          o: number;
          h: number;
          l: number;
          c: number;
          v: number;
        }

        interface BacktestInput {
          userId: string;
          symbol: string;
          timeframe: string;
          strategyId: string;
          params: Record<string, unknown>;
          candles: BacktestCandle[];
        }

        interface BacktestLogMessage {
          message: string;
          meta?: Record<string, unknown> | null;
          ts: number | string | Date;
        }

        interface BacktestResult {
          trades?: unknown[];
          metrics?: Record<string, unknown>;
        }

        const result: BacktestResult = await runBacktest(
          {
            userId: bot.userId,
            symbol: cfg.symbol,
            timeframe: cfg.timeframe,
            strategyId: cfg.strategy_id,
            params: cfg.params,
            candles,
          } as BacktestInput,
          (msg: BacktestLogMessage): Promise<void> => {
            try {
              this.hub.log(msg.message, { ...(msg.meta ?? {}), ts: msg.ts });
            } catch {
              /* ignore */
            }
            return Promise.resolve();
          },
        );

        // persist backtest trades
        if (result?.trades?.length) {
          const toInsert = result.trades.map((t: any) => ({
            ...t,
            account_id: cfg.account_id,
            mode: "backtest",
          }));
          try {
            const { data: inserted, error: insertErr } = await supabaseAdmin.from("trades").insert(toInsert).select("*");
            if (insertErr) {
              this.hub.log("backtest persist error", { error: String(insertErr) });
            } else {
              for (const tr of inserted ?? []) this.hub.trade(tr);
            }
          } catch (e) {
            this.hub.log("backtest persist exception", { error: String(e) });
          }
        }

        this.hub.log("backtest finished", { metrics: result?.metrics ?? {} });
      } catch (e) {
        this.hub.log("backtest error", { error: String(e) });
      }
      return; // don't run live/paper flow after backtest
    }

    // Paper/Live modes
    const strat = getStrategy(cfg.strategy_id);
    const ctx: StrategyContext = { symbol: cfg.symbol, timeframe: cfg.timeframe as any, now: new Date() };
    const signal = strat.generateSignal(candles, ctx, cfg.params);

    if (!signal.side) return;
    if (signal.confidence < 0.5) return;

    // Enforce per-bot max open trades
    const maxOpenTrades = Math.max(1, Number(cfg.params?.max_open_trades ?? 5));
    const currentOpen = this.getOpenCount(bot, cfg);
    if (currentOpen >= maxOpenTrades) {
      this.hub.log("open-trade limit reached", {
        runId: bot.runId,
        cfg_id: cfg.id,
        symbol: cfg.symbol,
        limit: maxOpenTrades,
        current: currentOpen,
      });
      return;
    }

    const gate = await canOpenTrade(bot.userId);
    if (!gate.ok) {
      this.hub.log("risk block", { reason: gate.reason, symbol: cfg.symbol });
      return;
    }

    const rules = await getRiskRules(bot.userId);
    const stake = computeStake(rules, 1000);

    if (cfg.mode === "paper") {
      // Paper trades in this implementation close immediately; we still bump the counter
      // for consistency and release right after persisting.
      this.incOpen(bot, cfg);
      try {
        await this.paperTrade(bot.userId, cfg, signal, stake);
      } finally {
        this.decOpen(bot, cfg);
      }
    } else if (cfg.mode === "live") {
      this.hub.log("live mode requested (minimal implementation)", { symbol: cfg.symbol });
      const contractType = signal.side === "buy" ? "CALL" : "PUT";
      const stakeParam = Number(cfg.params?.stake ?? stake);
      const dur = Number(cfg.params?.duration ?? 5);
      const durUnit = (cfg.params?.duration_unit ?? "m") as "m" | "h" | "d" | "t";

      this.incOpen(bot, cfg);
      try {
        const res = await deriv.buyRiseFall({
          symbol: cfg.symbol,
          side: contractType,
          stake: stakeParam,
          duration: dur,
          duration_unit: durUnit,
          currency: "USD",
        });

        // Insert opened live trade
        const buy = res?.buy || res;
        const contractId = Number(buy?.contract_id ?? buy?.contract_id_buy ?? buy?.longcode?.contract_id ?? 0);
        const buyPrice = Number(buy?.buy_price ?? buy?.price ?? stakeParam);
        const openedAt = new Date().toISOString();

        const insert = await supabaseAdmin
          .from("trades")
          .insert({
            user_id: bot.userId,
            account_id: cfg.account_id,
            mode: "live",
            symbol: cfg.symbol,
            strategy_id: cfg.strategy_id,
            timeframe: cfg.timeframe,
            side: signal.side, // "buy" | "sell"
            entry: buyPrice,
            opened_at: openedAt,
            closed_at: null,
            meta: { contract_id: contractId, stake: stakeParam, duration: dur, duration_unit: durUnit },
          })
          .select("*")
          .single();

        if (insert.data) this.hub.trade(insert.data);

        // Finalize after expiry: poll contract until sold, then update trade
        const ms = durationToMs(dur, durUnit) + 2000; // small buffer
        setTimeout(async () => {
          try {
            if (!contractId) {
              this.hub.log("live finalize: missing contract_id");
              return;
            }

            // Poll a few times in case settlement lags
            let snap: any = null;
            for (let i = 0; i < 6; i++) {
              snap = await deriv.openContract(contractId).catch(() => null);
              if (snap?.is_sold) break;
              await new Promise((r) => setTimeout(r, 1500));
            }

            const sellPrice = Number(snap?.sell_price ?? snap?.bid_price ?? 0);
            const profit = Number.isFinite(sellPrice) && Number.isFinite(buyPrice) ? sellPrice - buyPrice : 0;
            const closedAt = snap?.is_sold && snap?.sell_time
              ? new Date(Number(snap.sell_time) * 1000).toISOString()
              : new Date().toISOString();

            if (insert?.data?.id) {
              const { data: updated } = await supabaseAdmin
                .from("trades")
                .update({ exit: sellPrice, profit, closed_at: closedAt })
                .eq("id", insert.data.id)
                .select("*")
                .single();
              if (updated) this.hub.trade(updated);
            }
          } catch (e) {
            this.hub.log("live finalize error", { error: String(e) });
          } finally {
            this.decOpen(bot, cfg);
          }
        }, ms);
      } catch (e) {
        this.decOpen(bot, cfg);
        this.hub.log("live buy error", { error: String(e) });
      }
    }
  }

  private async paperTrade(userId: string, cfg: BotConfig, signal: any, stake: number) {
    const entry = signal.entry ?? 0;
    const sl = signal.sl ?? null;
    const tp = signal.tp ?? null;

    const spread = entry * 0.0002;
    const slippage = entry * 0.0001 * (Math.random() - 0.5);
    const fill = entry + (signal.side === "buy" ? spread : -spread) + slippage;

    // crude close after a random outcome near RR
    const win = Math.random() < 0.52;
    let exit = fill;
    if (win && tp != null) exit = tp;
    if (!win && sl != null) exit = sl;
    const profit = signal.side === "buy" ? exit - fill : fill - exit;

    const { data, error } = await supabaseAdmin
      .from("trades")
      .insert({
        user_id: userId,
        account_id: cfg.account_id,
        mode: "paper",
        symbol: cfg.symbol,
        strategy_id: cfg.strategy_id,
        timeframe: cfg.timeframe,
        side: signal.side,
        entry: fill,
        sl,
        tp,
        exit,
        profit,
        opened_at: new Date().toISOString(),
        closed_at: new Date().toISOString(),
        meta: { confidence: signal.confidence, reason: signal.reason, stake },
      })
      .select("*")
      .single();

    if (error) throw error;
    this.hub.trade(data);
    this.hub.log("paper trade", { symbol: cfg.symbol, side: signal.side, profit });
  }

  // Replace running configs for a user (preserves config ids) and apply immediately
  public async updateConfigs(userId: string, configs: Omit<BotConfig, "id">[]) {
    let updated = 0;
    for (const [, bot] of this.runs) {
      if (bot.userId !== userId) continue;
      bot.configs = configs.map((c) => ({ ...c, id: uuidv4() }));
      updated++;
    }
    this.hub.log("bot.configs.updated", { userId, runs_updated: updated });
    this.hub.status(this.getStatus(userId));
  }

  private handleTickSafely(tick: any) {
    // Defensive, non-intrusive tick handling (no cross-run side effects)
    try {
      if (!tick || typeof tick.epoch !== "number") {
        return;
      }
      const symbol = String(tick.symbol ?? "").trim();
      const epoch = Number(tick.epoch);
      const quote = typeof tick.quote === "number" ? tick.quote : tick.quote ? Number(tick.quote) : undefined;
      if (!symbol) return;

      try {
        this.hub.log("tick", { symbol, epoch, quote });
      } catch {
        /* ignore hub logging errors */
      }

      // Optional lightweight correlation (logging only)
      for (const bot of this.runs.values()) {
        const matches = bot.configs.some((c) => c.enabled && c.symbol === symbol);
        if (matches) {
          try {
            this.hub.log("tick match", { userId: bot.userId, symbol, epoch });
          } catch {}
        }
      }
    } catch (e) {
      console.error("tick error (final)", (e as any) && ((e as any).stack || (e as any).message || e));
      try {
        console.debug("tick payload (final):", JSON.stringify(tick));
      } catch {}
    }
  }
}

function durationToMs(n: number, u: "m" | "h" | "d" | "t"): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  switch (u) {
    case "t": // ticks: approximate as 1s per tick for release purposes
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return 0;
  }
}

function timeframeToSec(timeframe: string): number {
  // Deriv candles supported granularities (in seconds)
  const allowed = [60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400];

  if (!timeframe || typeof timeframe !== "string") {
    throw new Error("Invalid timeframe");
  }

  const tf = timeframe.trim().toLowerCase();

  const num = (s: string) => parseInt(s, 10);
  const toSec = (n: number, u: string) => {
    switch (u) {
      case "s":
        return n;
      case "m":
        return n * 60;
      case "h":
        return n * 3600;
      case "d":
        return n * 86400;
      default:
        return NaN;
    }
  };

  // Accept forms like "5m", "1h", "d1", "H4", "M15", etc.
  const m1 = tf.match(/^(\d+)\s*([smhd])$/); // 5m, 1h, 1d
  const m2 = tf.match(/^([smhd])\s*(\d+)$/); // m5, h1, d1

  let seconds: number | undefined;

  if (m1) {
    seconds = toSec(num(m1[1]), m1[2]);
  } else if (m2) {
    seconds = toSec(num(m2[2]), m2[1]);
  } else if (/^\d+$/.test(tf)) {
    // Bare number: treat as minutes for convenience (e.g., "15" => 15m)
    seconds = num(tf) * 60;
  } else if (/^(\d+)\s*(min|mins|minute|minutes)$/.test(tf)) {
    const mm = tf.match(/^(\d+)\s*(min|mins|minute|minutes)$/)!;
    seconds = num(mm[1]) * 60;
  } else if (/^(\d+)\s*(hr|hour|hours)$/.test(tf)) {
    const hm = tf.match(/^(\d+)\s*(hr|hour|hours)$/)!;
    seconds = num(hm[1]) * 3600;
  } else if (/^(\d+)\s*(day|days|d)$/.test(tf)) {
    const dm = tf.match(/^(\d+)\s*(day|days|d)$/)!;
    seconds = num(dm[1]) * 86400;
  }

  if (!seconds || !isFinite(seconds)) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }

  // Enforce minimum 1m for candles
  if (seconds < 60) seconds = 60;

  // If exact match, return it
  if (allowed.includes(seconds)) return seconds;

  // Otherwise, snap to the nearest supported granularity
  const nearest = allowed.reduce(
    (best, g) => (Math.abs(g - seconds!) < Math.abs(best - seconds!) ? g : best),
    allowed[0],
  );
  return nearest;
}