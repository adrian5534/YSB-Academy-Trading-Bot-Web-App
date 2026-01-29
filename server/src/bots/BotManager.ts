import { v4 as uuidv4 } from "uuid";
import { DerivClient } from "../deriv/DerivClient";
import { getStrategy } from "../strategies";
import type { StrategyContext } from "../strategies/types";
import { canOpenTrade, computeStake, getRiskRules } from "../risk/riskEngine";
import { supabaseAdmin } from "../supabase";
import type { WsHub } from "../ws/hub";
import { runBacktest } from "../backtests/runBacktest";

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
  name: string;
  state: "stopped" | "running";
  started_at: string | null;
  heartbeat_at: string | null;
  configs: BotConfig[];
  timer?: NodeJS.Timeout;
};

function timeframeToSec(tf: string) {
  const m = /^([0-9]+)(m|h|d)$/.exec(tf);
  if (!m) return 60;
  const n = Number(m[1]);
  const u = m[2];
  if (u === "m") return n * 60;
  if (u === "h") return n * 3600;
  return n * 86400;
}

export class BotManager {
  private running = new Map<string, Running>(); // userId -> bot
  private derivClients = new Map<string, DerivClient>(); // accountId -> client

  constructor(private hub: WsHub) {}

  getStatus(userId: string) {
    const bot = this.running.get(userId);
    return bot
      ? {
          state: bot.state,
          name: bot.name,
          started_at: bot.started_at,
          heartbeat_at: bot.heartbeat_at,
          active_configs: bot.configs.filter((c) => c.enabled).length,
        }
      : { state: "stopped", name: "YSB Bot", started_at: null, heartbeat_at: null, active_configs: 0 };
  }

  async start(userId: string, name: string, configs: Omit<BotConfig, "id">[]) {
    await this.stop(userId);
    const bot: Running = {
      userId,
      name,
      state: "running",
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      configs: configs.map((c) => ({ ...c, id: uuidv4() })),
    };
    this.running.set(userId, bot);

    // Debug: show what we will run
    console.log("[BotManager.start] bot created", { userId, configs: bot.configs });
    this.hub.log("bot.configs", { userId, configs: bot.configs });

    bot.timer = setInterval(() => {
      void this.tick(bot).catch((e) => this.hub.log("tick error", { error: String(e) }));
    }, 5000);

    this.hub.status(this.getStatus(userId));
    this.hub.log("bot started", { userId, configs: bot.configs.length });
  }

  async stop(userId: string) {
    const bot = this.running.get(userId);
    if (bot?.timer) clearInterval(bot.timer);
    this.running.delete(userId);
    this.hub.status(this.getStatus(userId));
    this.hub.log("bot stopped", { userId });
  }

  private async getDerivClient(accountId: string, token: string) {
    const existing = this.derivClients.get(accountId);
    if (existing) return existing;
    const c = new DerivClient(token);
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
      await this.runConfig(bot, cfg);
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

        const result = await runBacktest(
          {
            userId: bot.userId,
            symbol: cfg.symbol,
            timeframe: cfg.timeframe,
            strategyId: cfg.strategy_id,
            params: cfg.params,
            candles,
          },
          (msg) => {
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
        const res = await deriv.buyRiseFall(cfg.symbol, stake, 5, "m", contractType);
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
}