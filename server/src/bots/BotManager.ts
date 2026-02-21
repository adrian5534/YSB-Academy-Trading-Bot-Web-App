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
  private derivClients = new Map<string, DerivClient>();
  private openCounts = new Map<string, number>();

  // ✅ throttle reconciliation per account (kept as accountId-keyed for backward behavior)
  private lastReconcileAt = new Map<string, number>();

  // ✅ early-sell latch state (in-memory, per server process)
  // contractId -> state
  private earlySellState = new Map<
    number,
    { armed: boolean; threshold: number; armedAt: number; maxProfitSeen: number }
  >();

  // ✅ adaptive reconcile helpers (per user+account)
  private hasEarlySellOpenByAccount = new Map<string, boolean>(); // key = `${userId}::${accountId}` -> boolean
  private armedCountByAccount = new Map<string, number>(); // key = `${userId}::${accountId}` -> count
  private contractToAccountKey = new Map<number, string>(); // contractId -> `${userId}::${accountId}`

  private reconcileTimers = new Map<string, NodeJS.Timeout>(); // key = `${userId}::${accountId}`
  private reconcileInFlight = new Set<string>(); // key = `${userId}::${accountId}`

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

  private accountKey(userId: string, accountId: string) {
    return `${userId}::${accountId}`;
  }

  private incArmed(accountKey: string) {
    const n = (this.armedCountByAccount.get(accountKey) ?? 0) + 1;
    this.armedCountByAccount.set(accountKey, n);
  }

  private decArmed(accountKey: string) {
    const n = (this.armedCountByAccount.get(accountKey) ?? 0) - 1;
    if (n <= 0) this.armedCountByAccount.delete(accountKey);
    else this.armedCountByAccount.set(accountKey, n);
  }

  private deleteEarlySellState(contractId: number) {
    const st = this.earlySellState.get(contractId);
    if (st?.armed) {
      const ak = this.contractToAccountKey.get(contractId);
      if (ak) this.decArmed(ak);
    }
    this.earlySellState.delete(contractId);
    this.contractToAccountKey.delete(contractId);
  }

  private scheduleReconcileSoon(userId: string, accountId: string, delayMs: number) {
    const ak = this.accountKey(userId, accountId);
    if (this.reconcileTimers.has(ak)) return; // don't stack timers
    const t = setTimeout(() => {
      this.reconcileTimers.delete(ak);
      void this.reconcileAccountLiveTrades(userId, accountId, { force: true }).catch((e) =>
        this.hub.log("reconcile (scheduled) failed", { accountId, error: String(e) }),
      );
    }, delayMs);
    this.reconcileTimers.set(ak, t);
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
    if (existing) {
      this.clearRunReconcileTimers(existing);
      this.clearRunEphemeralState(userId, runId);
    }

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
      void this.tick(bot).catch((e: any) => this.hub.log(`tick error: ${e?.stack || e?.message || String(e)}`));
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
    if (bot) this.clearRunReconcileTimers(bot);
    this.runs.delete(key);
    this.clearRunEphemeralState(userId, name);
    this.hub.log("bot stopped", { userId, runId: name });
    this.hub.status(this.getStatus(userId));
  }

  // Stop this specific runId
  async stopById(userId: string, runId: string) {
    const key = this.runKey(userId, runId);
    const bot = this.runs.get(key);

    // ✅ best-effort reconciliation before stopping (prevents stuck open trades)
    if (bot) {
      const liveAccountIds = Array.from(new Set(bot.configs.filter((c) => c.mode === "live").map((c) => c.account_id)));
      for (const accountId of liveAccountIds) {
        try {
          await this.reconcileAccountLiveTrades(userId, accountId, { force: true });
        } catch (e) {
          this.hub.log("reconcile on stop failed", { accountId, error: String(e) });
        }
      }
    }

    if (bot?.timer) clearInterval(bot.timer);
    if (bot) this.clearRunReconcileTimers(bot);
    this.runs.delete(key);
    this.clearRunEphemeralState(userId, runId);
    this.hub.log("bot stopped", { userId, runId });
    this.hub.status(this.getStatus(userId));
  }

  // prevent double-decrement when a trade is closed early + later finalized
  private releasedTradeKeys = new Set<string>(); // `${cfgKey}::${tradeId}`
  private tradeToCfgKey = new Map<string, string>(); // tradeId -> cfgKey

  private decOpenByCfgKey(cfgKey: string) {
    const v = (this.openCounts.get(cfgKey) ?? 0) - 1;
    if (v <= 0) this.openCounts.delete(cfgKey);
    else this.openCounts.set(cfgKey, v);
  }

  private releaseOpenOnceByTradeId(tradeId: string) {
    const cfgKey = this.tradeToCfgKey.get(tradeId);
    if (!cfgKey) return;

    const rk = `${cfgKey}::${tradeId}`;
    if (this.releasedTradeKeys.has(rk)) return;

    this.releasedTradeKeys.add(rk);
    this.decOpenByCfgKey(cfgKey);
    this.tradeToCfgKey.delete(tradeId);
  }

  private async reconcileAccountLiveTrades(userId: string, accountId: string, opts?: { force?: boolean }) {
    const ak = this.accountKey(userId, accountId);

    // ✅ in-flight guard (prevents overlapping reconcile bursts)
    if (this.reconcileInFlight.has(ak)) return;

    const now = Date.now();
    const last = this.lastReconcileAt.get(accountId) ?? 0;

    // ✅ adaptive throttle: faster only when early-sell is relevant
    const hasEarly = this.hasEarlySellOpenByAccount.get(ak) ?? false;
    const armedCount = this.armedCountByAccount.get(ak) ?? 0;

    const BASE_MS = 15_000;
    const EARLY_MS = 3_000;
    const ARMED_MS = 1_500;

    const throttleMs = armedCount > 0 ? ARMED_MS : hasEarly ? EARLY_MS : BASE_MS;

    if (!opts?.force) {
      if (now - last < throttleMs) return;
    }

    // record last reconcile (even for forced runs) to keep behavior stable
    this.lastReconcileAt.set(accountId, now);

    this.reconcileInFlight.add(ak);
    try {
      let token = "";
      try {
        token = await this.accountToken(accountId);
      } catch (e) {
        this.hub.log("reconcile: token decrypt failed", { accountId, error: String(e) });
        return;
      }
      if (!token) return;

      const deriv = await this.getDerivClient(accountId, token);

      const { data: openTrades, error } = await supabaseAdmin
        .from("trades")
        .select("id, entry, opened_at, meta")
        .eq("user_id", userId)
        .eq("account_id", accountId)
        .eq("mode", "live")
        .is("closed_at", null)
        .order("opened_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      if (!openTrades?.length) {
        // no open trades => clear account-level flags and timers
        this.hasEarlySellOpenByAccount.delete(ak);
        const timer = this.reconcileTimers.get(ak);
        if (timer) clearTimeout(timer);
        this.reconcileTimers.delete(ak);
        return;
      }

      const toNum = (v: any, fb = 0) => {
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) ? n : fb;
      };

      const canResell = (s: any) => s?.is_valid_to_sell === 1 || s?.is_valid_to_sell === true;

      // ✅ update “hasEarly” for next throttle decision (based on DB only; cheap)
      const anyEarlyEnabled = (openTrades as any[]).some(
        (tr) => Boolean(tr?.meta?.early_sell_enabled) && toNum(tr?.meta?.early_sell_profit, 0) > 0,
      );
      this.hasEarlySellOpenByAccount.set(ak, anyEarlyEnabled);

      // ✅ cap Deriv openContract calls per pass
      // (keeps API usage bounded even when polling more frequently)
      const MAX_CHECK = armedCount > 0 ? 15 : anyEarlyEnabled ? 12 : 8;

      // ✅ prioritize armed contracts first, then early-enabled, then the rest
      const scored = (openTrades as any[]).map((tr) => {
        const cid = Number(tr?.meta?.contract_id ?? 0);
        const st = cid ? this.earlySellState.get(cid) : undefined;
        const earlyEnabled = Boolean(tr?.meta?.early_sell_enabled) && toNum(tr?.meta?.early_sell_profit, 0) > 0;
        const score = (st?.armed ? 100 : 0) + (earlyEnabled ? 10 : 0);
        return { tr, cid, score };
      });

      scored.sort((a, b) => b.score - a.score);

      let checked = 0;

      for (const it of scored) {
        if (checked >= MAX_CHECK) break;

        const tr = it.tr;
        const contractId = it.cid;
        if (!contractId) continue;

        // map contract -> account for correct armed counts / cleanup
        this.contractToAccountKey.set(contractId, ak);

        let snap: any = null;
        try {
          snap = await deriv.openContract(contractId);
        } catch {
          continue; // transient; leave open
        } finally {
          checked++;
        }

        // If already settled, close in DB (existing behavior)
        if (snap?.is_sold) {
          this.deleteEarlySellState(contractId);

          const buyPrice = toNum(tr?.entry, 0);
          const sellPrice = toNum(snap?.sell_price ?? snap?.bid_price, 0);
          const profit = Number.isFinite(sellPrice) && Number.isFinite(buyPrice) ? sellPrice - buyPrice : 0;
          const closedAt =
            snap?.sell_time ? new Date(Number(snap.sell_time) * 1000).toISOString() : new Date().toISOString();

          try {
            const { data: updated } = await supabaseAdmin
              .from("trades")
              .update({ exit: sellPrice, profit, closed_at: closedAt })
              .eq("id", tr.id)
              .select("*")
              .single();

            if (updated) this.hub.trade(updated);
            this.releaseOpenOnceByTradeId(String(tr.id));
            this.hub.log("reconciled live trade closed", { tradeId: tr.id, contractId, sellPrice, profit });
          } catch (e) {
            this.hub.log("reconcile: db update failed", { tradeId: tr.id, error: String(e) });
          }
          continue;
        }

        // Early-sell logic (only if enabled)
        const earlyEnabled = Boolean(tr?.meta?.early_sell_enabled ?? false);
        const earlySellProfit = earlyEnabled ? toNum(tr?.meta?.early_sell_profit ?? 0, 0) : 0;

        // If disabled, ensure latch state is cleared
        if (!earlyEnabled || earlySellProfit <= 0) {
          this.deleteEarlySellState(contractId);
          continue;
        }

        const profitNow = toNum(snap?.profit ?? 0, 0);

        // Arm once profit first reaches threshold (even if not sellable yet)
        const st =
          this.earlySellState.get(contractId) ?? {
            armed: false,
            threshold: earlySellProfit,
            armedAt: 0,
            maxProfitSeen: Number.NEGATIVE_INFINITY,
          };

        st.threshold = earlySellProfit;
        st.maxProfitSeen = Math.max(st.maxProfitSeen, profitNow);

        if (!st.armed && profitNow >= earlySellProfit) {
          st.armed = true;
          st.armedAt = Date.now();
          this.incArmed(ak);

          this.hub.log("early sell armed", {
            tradeId: tr.id,
            contractId,
            profitNow,
            threshold: earlySellProfit,
          });

          // ✅ when armed, schedule a fast follow-up reconcile for this account
          this.scheduleReconcileSoon(userId, accountId, 1500);
        }

        this.earlySellState.set(contractId, st);

        // ✅ Safety: once armed, only sell if sellable AND profit is non-negative
        // This avoids “armed at +X, sell later at -Y”.
        const minProfitToSell = 0;

        if (st.armed && canResell(snap) && profitNow >= minProfitToSell) {
          try {
            await deriv.sellContract(contractId, 0);

            const snap2 = await deriv.openContract(contractId).catch(() => null);

            if (snap2?.is_sold) {
              const buyPrice = toNum(tr?.entry, 0);
              const sellPrice = toNum(snap2?.sell_price ?? snap2?.bid_price, 0);
              const profit = Number.isFinite(sellPrice) && Number.isFinite(buyPrice) ? sellPrice - buyPrice : profitNow;
              const closedAt =
                snap2?.sell_time ? new Date(Number(snap2.sell_time) * 1000).toISOString() : new Date().toISOString();

              const { data: updated } = await supabaseAdmin
                .from("trades")
                .update({
                  exit: sellPrice,
                  profit,
                  closed_at: closedAt,
                  meta: { ...(tr?.meta ?? {}), early_sold: true, early_sold_at: new Date().toISOString() },
                })
                .eq("id", tr.id)
                .select("*")
                .single();

              if (updated) this.hub.trade(updated);
              this.releaseOpenOnceByTradeId(String(tr.id));

              this.hub.log("early sell executed", {
                tradeId: tr.id,
                contractId,
                profitNow,
                threshold: earlySellProfit,
                sellPrice,
              });

              this.deleteEarlySellState(contractId);
            } else {
              this.hub.log("early sell attempted (not sold yet)", {
                tradeId: tr.id,
                contractId,
                profitNow,
                threshold: earlySellProfit,
              });

              // still armed -> try again soon, but bounded by in-flight/timer logic
              this.scheduleReconcileSoon(userId, accountId, 1500);
            }
          } catch (e) {
            this.hub.log("early sell failed", { tradeId: tr.id, contractId, error: String(e) });
            // keep armed; retry soon
            this.scheduleReconcileSoon(userId, accountId, 1500);
          }
        }
      }

      // If anything is still armed for this account, keep the fast loop alive
      if ((this.armedCountByAccount.get(ak) ?? 0) > 0) {
        this.scheduleReconcileSoon(userId, accountId, 1500);
      }
    } finally {
      this.reconcileInFlight.delete(ak);
    }
  }

  private async getDerivClient(accountId: string, token: string) {
    const existing = this.derivClients.get(accountId);
    if (existing) return existing;
    const c = new DerivClient(token);
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
    // Only touch this run
    bot.heartbeat_at = new Date().toISOString();
    this.hub.status(this.getStatus(bot.userId));

    for (const cfg of bot.configs.filter((c) => c.enabled)) {
      try {
        await this.runConfig(bot, cfg);
      } catch (e: any) {
        this.hub.log(`runConfig error: ${e?.stack || e?.message || String(e)}`, {
          symbol: cfg.symbol,
          timeframe: cfg.timeframe,
          strategy_id: cfg.strategy_id,
        });
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

    // ✅ reconcile stuck open DB trades (especially after stop/restart)
    if (cfg.mode === "live") {
      await this.reconcileAccountLiveTrades(bot.userId, cfg.account_id).catch((e) =>
        this.hub.log("reconcile failed", { accountId: cfg.account_id, error: String(e) }),
      );
    }

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

    // ✅ also apply the same limit to the global risk gate
    const gate = await canOpenTrade(bot.userId, { max_open_trades: maxOpenTrades });
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

        const earlyEnabled = Boolean((cfg.params as any)?.early_sell_enabled ?? false);
        const earlyProfit = Math.max(0, Number((cfg.params as any)?.early_sell_profit ?? 0) || 0);

        const insert = await supabaseAdmin
          .from("trades")
          .insert({
            user_id: bot.userId,
            account_id: cfg.account_id,
            mode: "live",
            symbol: cfg.symbol,
            strategy_id: cfg.strategy_id,
            timeframe: cfg.timeframe,
            side: signal.side,
            entry: buyPrice,
            opened_at: openedAt,
            closed_at: null,
            meta: {
              contract_id: contractId,
              stake: stakeParam,
              duration: dur,
              duration_unit: durUnit,

              // ✅ persist both; profit only applies when enabled
              early_sell_enabled: earlyEnabled,
              early_sell_profit: earlyEnabled ? earlyProfit : 0,
            },
          })
          .select("*")
          .single();

        if (insert.data) {
          this.hub.trade(insert.data);
          // track mapping so reconciliation / early sell can release the in-memory counter safely
          this.tradeToCfgKey.set(String(insert.data.id), this.cfgKey(bot, cfg));
        }

        // Finalize after expiry
        const ms = durationToMs(dur, durUnit) + 2000;
        setTimeout(async () => {
          const tradeId = String(insert?.data?.id ?? "");
          try {
            if (!contractId) {
              this.hub.log("live finalize: missing contract_id");
              return;
            }

            // If already closed (e.g., early-sold), skip finalize update
            if (tradeId) {
              const { data: row } = await supabaseAdmin.from("trades").select("closed_at").eq("id", tradeId).maybeSingle();
              if (row?.closed_at) return;
            }

            let snap: any = null;
            for (let i = 0; i < 6; i++) {
              snap = await deriv.openContract(contractId).catch(() => null);
              if (snap?.is_sold) break;
              await new Promise((r) => setTimeout(r, 1500));
            }

            const sellPrice = Number(snap?.sell_price ?? snap?.bid_price ?? 0);
            const profit = Number.isFinite(sellPrice) && Number.isFinite(buyPrice) ? sellPrice - buyPrice : 0;
            const closedAt =
              snap?.is_sold && snap?.sell_time ? new Date(Number(snap.sell_time) * 1000).toISOString() : new Date().toISOString();

            if (tradeId) {
              const { data: updated } = await supabaseAdmin
                .from("trades")
                .update({ exit: sellPrice, profit, closed_at: closedAt })
                .eq("id", tradeId)
                .select("*")
                .single();
              if (updated) this.hub.trade(updated);
            }
          } catch (e) {
            this.hub.log("live finalize error", { error: String(e) });
          } finally {
            if (tradeId) this.releaseOpenOnceByTradeId(tradeId);
            else this.decOpen(bot, cfg);
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

  // Replace running configs for a user and apply immediately
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
  const nearest = allowed.reduce((best, g) => (Math.abs(g - seconds!) < Math.abs(best - seconds!) ? g : best), allowed[0]);
  return nearest;
}