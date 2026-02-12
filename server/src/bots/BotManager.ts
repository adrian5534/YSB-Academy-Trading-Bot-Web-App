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
  private deriv!: DerivClient;
  private derivClients = new Map<string, DerivClient>();

  private runKey(userId: string, runId: string) {
    return `${userId}::${runId}`;
  }

  constructor(private hub: WsHub) {
    // create deriv client and attach safe handler
    this.deriv = new DerivClient(/* token? */);

    interface DerivTick {
      epoch: number;
      quote?: number;
      symbol?: string;
      [key: string]: unknown;
    }

    interface DerivWsMessage {
      tick?: DerivTick;
      [key: string]: unknown;
    }

    this.deriv.setOnMessage((msg: DerivWsMessage): void => {
      try {
        // only handle tick messages here; ignore others
        if (msg?.tick) {
          this.handleTickSafely(msg.tick);
        }
      } catch (e: unknown) {
        console.error("tick error", (e as any) && ((e as any).stack || (e as any).message || e));
        // optional: log raw payload for debugging
        try {
          console.debug("tick payload:", JSON.stringify(msg));
        } catch {}
      }
    });
  }

  // Aggregate status (any run running => running)
  getStatus(userId: string) {
    const entries = Array.from(this.runs.values()).filter(r => r.userId === userId);
    const anyRunning = entries.some(r => r.state === "running");
    return anyRunning
      ? {
          state: "running",
          name: entries.map(r => r.name).join(", "),
          started_at: entries[0]?.started_at ?? null,
          heartbeat_at: entries[0]?.heartbeat_at ?? null,
          active_configs: entries.reduce((n, r) => n + r.configs.filter(c => c.enabled).length, 0),
        }
      : { state: "stopped", name: "YSB Bot", started_at: null, heartbeat_at: null, active_configs: 0 };
  }

  // Start ONLY this named run (do not stop others)
  async start(userId: string, name: string, configs: Omit<BotConfig, "id">[]) {
    const key = this.runKey(userId, name);

    // replace existing run with same name (only)
    const existing = this.runs.get(key);
    if (existing?.timer) clearInterval(existing.timer);

    const bot: Running = {
      userId,
      runId: name,
      name,
      state: "running",
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      configs: configs.map((c) => ({ ...c, id: uuidv4() })),
    };
    this.runs.set(key, bot);

    console.log("[BotManager.start] run created", { userId, name, configs: bot.configs });
    this.hub.log("bot.configs", { userId, name, configs: bot.configs });

    bot.timer = setInterval(() => {
      void this.tick(bot).catch((e: any) =>
        this.hub.log(`tick error: ${e?.stack || e?.message || String(e)}`)
      );
    }, 5000);

    this.hub.status(this.getStatus(userId));
    this.hub.log("bot started", { userId, name, configs: bot.configs.length });
  }

  // Stop this named run; if no name provided, stop all for user (backward compatible)
  async stop(userId: string, name?: string) {
    if (name) {
      const key = this.runKey(userId, name);
      const bot = this.runs.get(key);
      if (bot?.timer) clearInterval(bot.timer);
      this.runs.delete(key);
      this.hub.log("bot stopped", { userId, name });
    } else {
      // stop all runs for user
      for (const [key, bot] of Array.from(this.runs.entries())) {
        if (bot.userId !== userId) continue;
        if (bot.timer) clearInterval(bot.timer);
        this.runs.delete(key);
      }
      this.hub.log("bot stopped (all)", { userId });
    }
    this.hub.status(this.getStatus(userId));
  }

  private async getDerivClient(accountId: string, token: string) {
    const existing = this.derivClients.get(accountId);
    if (existing) return existing;
    const c = new DerivClient(token);
    // attach same safe handler to per-account client
    c.setOnMessage((msg: any) => {
      try {
        if (msg?.tick) this.handleTickSafely(msg.tick);
      } catch (e) {
        console.error("tick error (per-account)", (e as any) && ((e as any).stack || (e as any).message || e));
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
    const { data, error } = await supabaseAdmin.from("accounts").select("secrets").eq("id", accountId).maybeSingle();
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

    const secrets = acc.secrets as any;
    const enc = secrets?.deriv_token_enc;
    if (!enc) {
      this.hub.log("No Deriv token stored for account", { accountId: cfg.account_id });
      return;
    }

    let token = "";
    try {
      const { decryptJson } = await import("../crypto/secrets");
      const dec: any = decryptJson(enc as any);
      token = String(dec?.token ?? "");
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

    // IMPORTANT: backtest should run unconditionally, not gated on a live signal
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

    // For paper/live modes, generate a current signal and apply risk gates
    const strat = getStrategy(cfg.strategy_id);
    const ctx: StrategyContext = { symbol: cfg.symbol, timeframe: cfg.timeframe as any, now: new Date() };
    const signal = strat.generateSignal(candles, ctx, cfg.params);

    if (!signal.side) return;
    if (signal.confidence < 0.5) return;

    const gate = await canOpenTrade(bot.userId);
    if (!gate.ok) {
      this.hub.log("risk block", { reason: gate.reason, symbol: cfg.symbol });
      return;
    }

    // stake estimation (Deriv balance not fetched here; use placeholder)
    const rules = await getRiskRules(bot.userId);
    const stake = computeStake(rules, 1000);

    if (cfg.mode === "paper") {
      await this.paperTrade(bot.userId, cfg, signal, stake);
    } else if (cfg.mode === "live") {
      this.hub.log("live mode requested (minimal implementation)", { symbol: cfg.symbol });
      try {
        const contractType = signal.side === "buy" ? "CALL" : "PUT";
        const stakeParam = Number(cfg.params?.stake ?? stake);
        const dur = Number(cfg.params?.duration ?? 5);
        const durUnit = (cfg.params?.duration_unit ?? "m") as "m" | "h" | "d" | "t";
        const res = await deriv.buyRiseFall({
          symbol: cfg.symbol,
          side: contractType,
          stake: stakeParam,
          duration: dur,
          duration_unit: durUnit,
          currency: "USD",
        });
        this.hub.trade({ mode: "live", symbol: cfg.symbol, res });
      } catch (e) {
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
    const bot = this.runs.get(userId);
    if (!bot) throw new Error("Bot not running");
    bot.configs = configs.map((c) => ({ ...c, id: uuidv4() }));
    this.hub.log("bot.configs.updated", { userId, configs: bot.configs });
    this.hub.status(this.getStatus(userId));
    // Optionally trigger an immediate tick for the new configs
    try {
      await this.tick(bot);
    } catch (e) {
      this.hub.log("apply-configs error", { error: String(e) });
    }
  }

  private handleTickSafely(tick: any) {
    // existing tick processing moved here (defensive, with sanity checks)
    try {
      if (!tick || typeof tick.epoch !== "number") {
        console.debug("ignoring malformed tick", tick);
        return;
      }

      // Basic sanity: ensure symbol and quote present
      const symbol = String(tick.symbol ?? "").trim();
      const epoch = Number(tick.epoch);
      const quote = typeof tick.quote === "number" ? tick.quote : tick.quote ? Number(tick.quote) : undefined;

      if (!symbol) {
        console.debug("ignoring tick with no symbol", tick);
        return;
      }

      // Lightweight handling: surface ticks to connected clients for visibility
      // and optionally correlate to running bot configs (non-blocking).
      try {
        this.hub.log("tick", { symbol, epoch, quote });
      } catch {
        /* ignore hub logging errors */
      }

      // If any running bot config watches this symbol we could trigger logic here.
      // Keep this cheap and defensive to avoid spamming or throwing.
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
