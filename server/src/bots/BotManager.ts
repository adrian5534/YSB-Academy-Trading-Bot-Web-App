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

  // ✅ track what we believe is subscribed per account (so we can unsubscribe removed symbols)
  private tickSymbolsByAccountId = new Map<string, Set<string>>();

  // ---- runtime state maps/sets (per run/config/account) ----
  private lastTickLogAt = new Map<string, number>(); // `${userId}::${symbol}` -> last log ms

  private openCounts = new Map<string, number>(); // cfgKey -> open count

  private cooldownUntilByCfgKey = new Map<string, number>(); // cfgKey -> epoch ms
  private lastTradeAtByCfgKey = new Map<string, number>(); // cfgKey -> epoch ms
  private tradeTimestamps60sByCfgKey = new Map<string, number[]>(); // cfgKey -> rolling 60s trade timestamps

  private consecutiveLossesByCfgKey = new Map<string, number>(); // cfgKey -> losses
  private lossPauseUntilByCfgKey = new Map<string, number>(); // cfgKey -> epoch ms

  private recentTickQuotesByCfgKey = new Map<string, { quotes: number[] }>(); // cfgKey -> recent quotes
  private spikePauseUntilByCfgKey = new Map<string, number>(); // cfgKey -> epoch ms

  private lastExecutedSignalKeyByCfgKey = new Map<string, string>(); // cfgKey -> last signalKey

  private reconcileTimers = new Map<string, NodeJS.Timeout>(); // accountKey -> timer
  private reconcileInFlight = new Set<string>(); // accountKey
  private lastReconcileAt = new Map<string, number>(); // accountId -> epoch ms

  private hasEarlySellOpenByAccount = new Map<string, boolean>(); // accountKey -> bool
  private armedCountByAccount = new Map<string, number>(); // accountKey -> armed count
  private earlySellState = new Map<
    number,
    { armed: boolean; threshold: number; armedAt: number; maxProfitSeen: number }
  >(); // contractId -> state
  private contractToAccountKey = new Map<number, string>(); // contractId -> accountKey

  private wantsTicks(cfg: BotConfig) {
    // tick-by-tick requires ticks; also allow non-1s bots to opt-in via params.stream_ticks
    return this.isTickByTickCfg(cfg) || Boolean((cfg.params as any)?.stream_ticks);
  }

  private async syncAccountTickSubscriptions(accountId: string) {
    const deriv = this.derivClients.get(accountId);
    if (!deriv) return;

    const desired = new Set<string>();
    for (const run of this.runs.values()) {
      for (const cfg of run.configs) {
        if (!cfg.enabled) continue;
        if (cfg.account_id !== accountId) continue;
        if (!this.wantsTicks(cfg)) continue;
        const sym = String(cfg.symbol ?? "").trim();
        if (sym) desired.add(sym);
      }
    }

    const prev = this.tickSymbolsByAccountId.get(accountId) ?? new Set<string>();

    // subscribe missing
    for (const sym of desired) {
      if (prev.has(sym)) continue;
      await deriv.subscribeTicks(sym).catch(() => void 0);
    }

    // unsubscribe no longer needed
    for (const sym of prev) {
      if (desired.has(sym)) continue;
      await deriv.unsubscribeTicks(sym).catch(() => void 0);
    }

    if (desired.size) this.tickSymbolsByAccountId.set(accountId, desired);
    else this.tickSymbolsByAccountId.delete(accountId);
  }

  private runKey(userId: string, runId: string) {
    return `${userId}::${runId}`;
  }

  private cfgKey(bot: Running, cfg: BotConfig) {
    return `${bot.userId}::${bot.runId}::${cfg.id}`;
  }

  // ---- losing streak protection helpers (runtime state) ----
  private parseMaxConsecutiveLosses(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.max_consecutive_losses;
    const n = typeof raw === "number" ? raw : raw === "" || raw == null ? 0 : Number(raw);
    if (!Number.isFinite(n)) return 0;
    // Clamp (0 disables)
    return Math.min(100, Math.max(0, Math.floor(n)));
  }

  private parsePauseAfterLossMinutes(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.pause_after_loss_minutes;
    const n = typeof raw === "number" ? raw : raw === "" || raw == null ? 0 : Number(raw);
    if (!Number.isFinite(n)) return 0;
    // Clamp (0 disables), max 24h
    return Math.min(1440, Math.max(0, Math.floor(n)));
  }

  private getConsecutiveLosses(cfgKey: string): number {
    return this.consecutiveLossesByCfgKey.get(cfgKey) ?? 0;
  }

  private setConsecutiveLosses(cfgKey: string, n: number) {
    const v = Math.max(0, Math.floor(n));
    if (!v) this.consecutiveLossesByCfgKey.delete(cfgKey);
    else this.consecutiveLossesByCfgKey.set(cfgKey, v);
  }

  private getLossPauseUntil(cfgKey: string): number {
    return this.lossPauseUntilByCfgKey.get(cfgKey) ?? 0;
  }

  private isLossPauseActive(cfgKey: string): { active: boolean; remainingMs: number } {
    const until = this.getLossPauseUntil(cfgKey);
    const now = Date.now();
    if (until > now) return { active: true, remainingMs: until - now };
    return { active: false, remainingMs: 0 };
  }

  private startLossPause(cfgKey: string, minutes: number) {
    const min = Math.max(0, Math.floor(minutes));
    if (!min) return;

    const now = Date.now();
    const nextUntil = now + min * 60_000;

    // If already paused, extend to the later timestamp
    const prev = this.lossPauseUntilByCfgKey.get(cfgKey) ?? 0;
    this.lossPauseUntilByCfgKey.set(cfgKey, Math.max(prev, nextUntil));
  }

  private maybeApplyLosingStreakProtection(opts: {
    userId: string;
    cfgKey: string;
    cfg?: BotConfig;
    profit: number;
    reason: string;
    meta?: Record<string, unknown>;
  }) {
    const { userId, cfgKey, cfg, profit, reason, meta } = opts;

    if (!cfg) return;
    if (!Number.isFinite(profit)) return;

    // Reset after a winning trade
    if (profit > 0) {
      this.setConsecutiveLosses(cfgKey, 0);
      return;
    }

    // Only count losses (profit < 0). Profit === 0 leaves streak unchanged.
    if (profit >= 0) return;

    const maxLosses = this.parseMaxConsecutiveLosses(cfg);
    const pauseMin = this.parsePauseAfterLossMinutes(cfg);
    if (!maxLosses || !pauseMin) {
      // still track losses if maxLosses configured but pause disabled? requirements say pause when reaches max
      // We'll track only when maxLosses is set to avoid surprise state.
      if (maxLosses) this.setConsecutiveLosses(cfgKey, this.getConsecutiveLosses(cfgKey) + 1);
      return;
    }

    const nextLosses = this.getConsecutiveLosses(cfgKey) + 1;
    this.setConsecutiveLosses(cfgKey, nextLosses);

    if (nextLosses >= maxLosses) {
      this.startLossPause(cfgKey, pauseMin);
      const until = this.getLossPauseUntil(cfgKey);

      this.wsLog(userId, "losing-streak pause started", {
        ...meta,
        reason,
        profit,
        consecutive_losses: nextLosses,
        max_consecutive_losses: maxLosses,
        pause_after_loss_minutes: pauseMin,
        pauseUntil: new Date(until).toISOString(),
      });
    }
  }

  // ---- cooldown helpers (runtime state) ----
  private parseCooldownAfterLossSec(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.cooldown_after_loss;
    const n = typeof raw === "number" ? raw : raw === "" || raw == null ? 0 : Number(raw);
    if (!Number.isFinite(n)) return 0;
    // Clamp to sane bounds (0..24h)
    return Math.min(86_400, Math.max(0, Math.floor(n)));
  }

  private getCooldownUntil(cfgKey: string): number {
    return this.cooldownUntilByCfgKey.get(cfgKey) ?? 0;
  }

  private isInCooldown(cfgKey: string): { active: boolean; remainingMs: number } {
    const until = this.getCooldownUntil(cfgKey);
    const now = Date.now();
    if (until > now) return { active: true, remainingMs: until - now };
    return { active: false, remainingMs: 0 };
  }

  private startCooldown(cfgKey: string, seconds: number) {
    const sec = Math.max(0, Math.floor(seconds));
    if (!sec) return;

    const now = Date.now();
    const nextUntil = now + sec * 1000;

    // If already in cooldown, extend to the later timestamp
    const prev = this.cooldownUntilByCfgKey.get(cfgKey) ?? 0;
    this.cooldownUntilByCfgKey.set(cfgKey, Math.max(prev, nextUntil));
  }

  private maybeCooldownAfterLoss(opts: {
    userId: string;
    cfgKey: string;
    cfg?: BotConfig;
    profit: number;
    reason: string;
    meta?: Record<string, unknown>;
  }) {
    const { userId, cfgKey, cfg, profit, reason, meta } = opts;

    if (!Number.isFinite(profit) || profit >= 0) return;

    const seconds = cfg ? this.parseCooldownAfterLossSec(cfg) : 0;
    if (!seconds) return;

    this.startCooldown(cfgKey, seconds);

    const until = this.getCooldownUntil(cfgKey);
    this.wsLog(userId, "cooldown_after_loss started", {
      ...meta,
      reason,
      profit,
      cooldown_after_loss: seconds,
      cooldownUntil: new Date(until).toISOString(),
    });
  }

  // ---- trade frequency limiter helpers (rolling 60 seconds, runtime state) ----
  private parseMaxTradesPerMinute(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.max_trades_per_minute;
    const n = typeof raw === "number" ? raw : raw === "" || raw == null ? 0 : Number(raw);
    if (!Number.isFinite(n)) return 0;
    // Clamp (0 disables), allow up to 600/min
    return Math.min(600, Math.max(0, Math.floor(n)));
  }

  private pruneTradeWindow60s(cfgKey: string, nowMs: number): number[] {
    const cutoff = nowMs - 60_000;
    const arr = this.tradeTimestamps60sByCfgKey.get(cfgKey);
    if (!arr?.length) return [];

    // arr is kept sorted (we only push Date.now()) so we can drop from the front
    let i = 0;
    while (i < arr.length && arr[i] <= cutoff) i++;

    if (i > 0) arr.splice(0, i);

    if (arr.length === 0) {
      this.tradeTimestamps60sByCfgKey.delete(cfgKey);
      return [];
    }

    this.tradeTimestamps60sByCfgKey.set(cfgKey, arr);
    return arr;
  }

  private isTradeFrequencyLimited(
    cfgKey: string,
    cfg: BotConfig,
  ): { active: boolean; remainingMs: number; limit: number; count: number } {
    const limit = this.parseMaxTradesPerMinute(cfg);
    if (!limit) return { active: false, remainingMs: 0, limit: 0, count: 0 };

    const now = Date.now();
    const arr = this.pruneTradeWindow60s(cfgKey, now);
    const count = arr.length;

    if (count >= limit) {
      const oldest = arr[0] ?? now;
      const remainingMs = Math.max(0, oldest + 60_000 - now);
      return { active: true, remainingMs, limit, count };
    }

    return { active: false, remainingMs: 0, limit, count };
  }

  // ---- min time between trades helpers (runtime state) ----
  private parseMinSecondsBetweenTrades(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.min_seconds_between_trades;
    const n = typeof raw === "number" ? raw : raw === "" || raw == null ? 0 : Number(raw);
    if (!Number.isFinite(n)) return 0;
    // Clamp to sane bounds (0..24h)
    return Math.min(86_400, Math.max(0, Math.floor(n)));
  }

  private getLastTradeAt(cfgKey: string): number {
    return this.lastTradeAtByCfgKey.get(cfgKey) ?? 0;
  }

  // ✅ record an executed trade for both:
  // - min_seconds_between_trades (lastTradeAt)
  // - max_trades_per_minute (rolling window)
  private markTradeExecuted(cfgKey: string) {
    const now = Date.now();

    // last trade time (for min interval)
    this.lastTradeAtByCfgKey.set(cfgKey, now);

    // rolling 60s window (for trades/minute)
    const arr = this.tradeTimestamps60sByCfgKey.get(cfgKey) ?? [];
    const cutoff = now - 60_000;

    // prune (sorted array)
    let i = 0;
    while (i < arr.length && arr[i] <= cutoff) i++;
    if (i > 0) arr.splice(0, i);

    arr.push(now);
    this.tradeTimestamps60sByCfgKey.set(cfgKey, arr);
  }

  private isMinTradeIntervalActive(
    cfgKey: string,
    cfg: BotConfig,
  ): { active: boolean; remainingMs: number; seconds: number } {
    const seconds = this.parseMinSecondsBetweenTrades(cfg);
    if (!seconds) return { active: false, remainingMs: 0, seconds: 0 };

    const last = this.getLastTradeAt(cfgKey);
    if (!last) return { active: false, remainingMs: 0, seconds };

    const now = Date.now();
    const until = last + seconds * 1000;

    if (until > now) return { active: true, remainingMs: until - now, seconds };
    return { active: false, remainingMs: 0, seconds };
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

  private clearRunCooldownState(userId: string, runId: string) {
    const prefix = `${userId}::${runId}::`;
    for (const k of Array.from(this.cooldownUntilByCfgKey.keys())) {
      if (k.startsWith(prefix)) this.cooldownUntilByCfgKey.delete(k);
    }
  }

  private clearRunLosingStreakState(userId: string, runId: string) {
    const prefix = `${userId}::${runId}::`;
    for (const k of Array.from(this.consecutiveLossesByCfgKey.keys())) {
      if (k.startsWith(prefix)) this.consecutiveLossesByCfgKey.delete(k);
    }
    for (const k of Array.from(this.lossPauseUntilByCfgKey.keys())) {
      if (k.startsWith(prefix)) this.lossPauseUntilByCfgKey.delete(k);
    }
  }

  private clearRunReconcileTimers(bot: Running) {
    const accountIds = Array.from(new Set(bot.configs.map((c) => c.account_id)));
    for (const accountId of accountIds) {
      const ak = this.accountKey(bot.userId, accountId);
      const t = this.reconcileTimers.get(ak);
      if (t) clearTimeout(t);
      this.reconcileTimers.delete(ak);
      this.reconcileInFlight.delete(ak);
    }
  }

  private clearRunEphemeralState(userId: string, runId: string) {
    // open trade counters are keyed by run
    this.clearRunOpenCounts(userId, runId);

    // cooldown state is keyed by run/config
    this.clearRunCooldownState(userId, runId);

    // ✅ min-time-between-trades state is keyed by run/config
    {
      const prefix = `${userId}::${runId}::`;
      for (const k of Array.from(this.lastTradeAtByCfgKey.keys())) {
        if (k.startsWith(prefix)) this.lastTradeAtByCfgKey.delete(k);
      }
    }

    // ✅ trades-per-minute window state is keyed by run/config
    {
      const prefix = `${userId}::${runId}::`;
      for (const k of Array.from(this.tradeTimestamps60sByCfgKey.keys())) {
        if (k.startsWith(prefix)) this.tradeTimestamps60sByCfgKey.delete(k);
      }
    }

    // ✅ losing-streak protection state is keyed by run/config
    {
      const prefix = `${userId}::${runId}::`;
      for (const k of Array.from(this.consecutiveLossesByCfgKey.keys())) {
        if (k.startsWith(prefix)) this.consecutiveLossesByCfgKey.delete(k);
      }
      for (const k of Array.from(this.lossPauseUntilByCfgKey.keys())) {
        if (k.startsWith(prefix)) this.lossPauseUntilByCfgKey.delete(k);
      }
    }

    // ✅ tick volatility filter buffers are keyed by run/config
    {
      const prefix = `${userId}::${runId}::`;
      for (const k of Array.from(this.recentTickQuotesByCfgKey.keys())) {
        if (k.startsWith(prefix)) this.recentTickQuotesByCfgKey.delete(k);
      }
    }

    // ✅ spike exhaustion pause state is keyed by run/config
    {
      const prefix = `${userId}::${runId}::`;
      for (const k of Array.from(this.spikePauseUntilByCfgKey.keys())) {
        if (k.startsWith(prefix)) this.spikePauseUntilByCfgKey.delete(k);
      }
    }

    // ✅ clear signal-dedupe state for this run
    {
      const prefix = `${userId}::${runId}::`;
      for (const k of Array.from(this.lastExecutedSignalKeyByCfgKey.keys())) {
        if (k.startsWith(prefix)) this.lastExecutedSignalKeyByCfgKey.delete(k);
      }
    }

    // clean tradeId -> cfgKey mappings (cfgKey includes runId)
    const cfgPrefix = `${userId}::${runId}::`;
    for (const [tradeId, cfgKey] of Array.from(this.tradeToCfgKey.entries())) {
      if (cfgKey.startsWith(cfgPrefix)) this.tradeToCfgKey.delete(tradeId);
    }

    // clean release latches for this run
    for (const rk of Array.from(this.releasedTradeKeys.values())) {
      if (rk.startsWith(cfgPrefix)) this.releasedTradeKeys.delete(rk);
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
        this.wsLog(userId, "reconcile (scheduled) failed", { accountId, error: String(e) }),
      );
    }, delayMs);
    this.reconcileTimers.set(ak, t);
  }

  constructor(private hub: WsHub) {
    // No global streaming client. All market data access is scoped via per-account clients.
  }

  // ✅ Emit helpers that scope to a single user (prevents cross-user log/status/trade leakage)
  private redactMeta(meta: any) {
    try {
      if (!meta || typeof meta !== "object") return meta;
      const walk = (v: any): any => {
        if (!v || typeof v !== "object") return v;
        if (Array.isArray(v)) return v.map(walk);

        const out: any = {};
        for (const [k, val] of Object.entries(v)) {
          if (/token|secret|password/i.test(k)) out[k] = "***";
          else out[k] = walk(val);
        }
        return out;
      };
      return walk(meta);
    } catch {
      return meta;
    }
  }

  // ✅ log retention settings
  private static readonly LOG_RETENTION_DAYS = 7;
  private static readonly LOG_MAX_PER_USER = 2000;
  private static readonly LOG_PRUNE_THROTTLE_MS = 60_000;

  // throttle pruning per user
  private logPruneAtByUserId = new Map<string, number>();

  private async pruneLogsForUser(userId: string) {
    const now = Date.now();
    const last = this.logPruneAtByUserId.get(userId) ?? 0;
    if (now - last < BotManager.LOG_PRUNE_THROTTLE_MS) return;
    this.logPruneAtByUserId.set(userId, now);

    try {
      // 1) time-based retention
      const cutoff = new Date(now - BotManager.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      await supabaseAdmin.from("logs").delete().eq("user_id", userId).lt("created_at", cutoff);

      // 2) count-based retention (keep newest LOG_MAX_PER_USER)
      // Fetch ids beyond the cap, then delete them.
      const start = BotManager.LOG_MAX_PER_USER; // offset (0-based)
      const end = start + 999; // prune up to 1000 at a time

      const { data: extra, error: extraErr } = await supabaseAdmin
        .from("logs")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .range(start, end);

      if (extraErr) return;

      const ids = (extra ?? []).map((r: any) => r.id).filter(Boolean);
      if (!ids.length) return;

      await supabaseAdmin.from("logs").delete().in("id", ids);
    } catch {
      // best-effort only
    }
  }

  private async persistLogRow(userId: string, message: string, meta?: any) {
    try {
      await supabaseAdmin.from("logs").insert({
        user_id: userId,
        message,
        meta: meta ?? null,
        created_at: new Date().toISOString(),
      });

      // ✅ prune old/excess logs (throttled)
      void this.pruneLogsForUser(userId);
    } catch {
      // ignore DB logging errors
    }
  }

  private wsLog(userId: string, message: string, meta?: any) {
    const ts = new Date().toISOString();
    const safeMeta = this.redactMeta(meta);
    const payload = { message, ts, meta: safeMeta };

    // ✅ emit to websocket (best-effort, supports different hub implementations)
    const hub: any = this.hub as any;
    try {
      if (typeof hub?.log === "function") {
        try {
          hub.log(payload, userId);
        } catch {
          hub.log(payload);
        }
      } else if (typeof hub?.emit === "function") {
        // fallback generic emitter
        try {
          hub.emit(userId, { type: "bot.log", payload });
        } catch {
          /* ignore */
        }
      }
    } catch {
      // ignore
    }

    // ✅ persist to Supabase (per-user) + prune
    void this.persistLogRow(userId, message, safeMeta);
  }

  private wsTrade(userId: string, trade: any) {
    const hub: any = this.hub as any;
    try {
      if (typeof hub?.trade === "function") {
        try {
          hub.trade(trade, userId);
          return;
        } catch {
          hub.trade(trade);
        }
      }
    } catch {
      // ignore
    }
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
      configs: configs.map((c) => ({
        ...c,
        id: uuidv4(),
        enabled: c.enabled ?? true,
      })),
    };
    this.runs.set(key, bot);

    // ✅ immediate best-effort reconcile on start (cleans previously-stuck opens)
    {
      const liveAccountIds = Array.from(
        new Set(bot.configs.filter((c) => c.enabled && c.mode === "live").map((c) => c.account_id)),
      );
      for (const accountId of liveAccountIds) {
        void this.reconcileAccountLiveTrades(userId, accountId, { force: true }).catch((e) =>
          this.wsLog(userId, "reconcile (start) failed", { accountId, error: String(e) }),
        );
      }
    }

    this.wsLog(userId, "bot.configs", { userId, runId, name, configs: bot.configs });
    bot.timer = setInterval(() => {
      void this.tick(bot).catch((e: any) =>
        this.wsLog(bot.userId, `tick error: ${e?.stack || e?.message || String(e)}`),
      );
    }, 5000);

    this.wsStatus(userId, this.getStatus(userId));
    this.wsLog(userId, "bot started", { userId, runId, name, configs: bot.configs.length });
  }

  // Deprecated global stop; keep no-op unless name provided (back-compat)
  async stop(userId: string, name?: string) {
    if (!name) {
      this.wsLog(userId, "stop called without name; ignoring to avoid stop-all", { userId });
      return;
    }
    const key = this.runKey(userId, name);
    const bot = this.runs.get(key);
    if (bot?.timer) clearInterval(bot.timer);
    if (bot) this.clearRunReconcileTimers(bot);
    this.runs.delete(key);
    this.clearRunEphemeralState(userId, name);
    this.wsLog(userId, "bot stopped", { userId, runId: name });
    this.wsStatus(userId, this.getStatus(userId));
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
          this.wsLog(userId, "reconcile on stop failed", { accountId, error: String(e) });
        }
      }
    }

    if (bot?.timer) clearInterval(bot.timer);
    if (bot) this.clearRunReconcileTimers(bot);
    this.runs.delete(key);

    // ✅ after removing run, resync tick subscriptions for affected accounts
    if (bot) {
      const accountIds = Array.from(new Set(bot.configs.map((c) => c.account_id)));
      for (const accountId of accountIds) {
        await this.syncAccountTickSubscriptions(accountId).catch(() => void 0);
      }
    }

    this.clearRunEphemeralState(userId, runId);
    this.wsLog(userId, "bot stopped", { userId, runId });
    this.wsStatus(userId, this.getStatus(userId));
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

    if (this.reconcileInFlight.has(ak)) return;

    const now = Date.now();
    const last = this.lastReconcileAt.get(accountId) ?? 0;

    const hasEarly = this.hasEarlySellOpenByAccount.get(ak) ?? false;
    const armedCount = this.armedCountByAccount.get(ak) ?? 0;

    const BASE_MS = 15_000;
    const EARLY_MS = 3_000;
    const ARMED_MS = 1_500;

    const throttleMs = armedCount > 0 ? ARMED_MS : hasEarly ? EARLY_MS : BASE_MS;

    if (!opts?.force) {
      if (now - last < throttleMs) return;
    }

    this.lastReconcileAt.set(accountId, now);

    this.reconcileInFlight.add(ak);
    try {
      let token = "";
      try {
        token = await this.accountToken(accountId);
      } catch (e) {
        this.wsLog(userId, "reconcile: token decrypt failed", { accountId, error: String(e) });
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

      const anyEarlyEnabled = (openTrades as any[]).some(
        (tr) => Boolean(tr?.meta?.early_sell_enabled) && toNum(tr?.meta?.early_sell_profit, 0) > 0,
      );
      this.hasEarlySellOpenByAccount.set(ak, anyEarlyEnabled);

      const MAX_CHECK = armedCount > 0 ? 15 : anyEarlyEnabled ? 12 : 8;

      const scored = (openTrades as any[]).map((tr) => {
        const cid = Number(tr?.meta?.contract_id ?? 0);
        const st = cid ? this.earlySellState.get(cid) : undefined;
        const earlyEnabled = Boolean(tr?.meta?.early_sell_enabled) && toNum(tr?.meta?.early_sell_profit, 0);
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

        this.contractToAccountKey.set(contractId, ak);

        let snap: any = null;
        try {
          snap = await deriv.openContract(contractId);
        } catch {
          continue;
        } finally {
          checked++;
        }

        if (snap?.is_sold) {
          this.deleteEarlySellState(contractId);

          const buyPrice = toNum(tr?.entry, 0);
          const sellPrice = toNum(snap?.sell_price ?? snap?.bid_price, 0);
          const profit = Number.isFinite(sellPrice) && Number.isFinite(buyPrice) ? sellPrice - buyPrice : 0;
          const closedAt =
            snap?.sell_time ? new Date(Number(snap.sell_time) * 1000).toISOString() : new Date().toISOString();

          // try to attribute cooldown to the originating cfg (best-effort)
          const tradeIdStr = String(tr.id);
          const cfgKey = this.tradeToCfgKey.get(tradeIdStr);

          try {
            const { data: updated } = await supabaseAdmin
              .from("trades")
              .update({ exit: sellPrice, profit, closed_at: closedAt })
              .eq("id", tr.id)
              .select("*")
              .single();

            if (updated) this.wsTrade(userId, updated);

            if (cfgKey) {
              const botAndCfg = this.findBotAndCfgByCfgKey(cfgKey);

              // ✅ do not reset cooldown_after_loss behavior
              this.maybeCooldownAfterLoss({
                userId,
                cfgKey,
                cfg: botAndCfg?.cfg,
                profit,
                reason: "reconcile:settled_loss",
                meta: { tradeId: tr.id, contractId, accountId },
              });

              // ✅ losing-streak protection (independent per cfg)
              this.maybeApplyLosingStreakProtection({
                userId,
                cfgKey,
                cfg: botAndCfg?.cfg,
                profit,
                reason: "reconcile:settled_result",
                meta: { tradeId: tr.id, contractId, accountId },
              });
            }

            this.releaseOpenOnceByTradeId(tradeIdStr);
            this.wsLog(userId, "reconciled live trade closed", { tradeId: tr.id, contractId, sellPrice, profit });
          } catch (e) {
            this.wsLog(userId, "reconcile: db update failed", { tradeId: tr.id, error: String(e) });
          }
          continue;
        }

        const earlyEnabled = Boolean(tr?.meta?.early_sell_enabled ?? false);
        const earlySellProfit = earlyEnabled ? toNum(tr?.meta?.early_sell_profit ?? 0, 0) : 0;

        if (!earlyEnabled || earlySellProfit <= 0) {
          this.deleteEarlySellState(contractId);
          continue;
        }

        const profitNow = toNum(snap?.profit ?? 0, 0);

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

          this.wsLog(userId, "early sell armed", {
            tradeId: tr.id,
            contractId,
            profitNow,
            threshold: earlySellProfit,
          });

          this.scheduleReconcileSoon(userId, accountId, 1500);
        }

        this.earlySellState.set(contractId, st);

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

              const tradeIdStr = String(tr.id);
              const cfgKey = this.tradeToCfgKey.get(tradeIdStr);

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

              if (updated) this.wsTrade(userId, updated);

              if (cfgKey) {
                const botAndCfg = this.findBotAndCfgByCfgKey(cfgKey);

                // ✅ do not reset cooldown_after_loss behavior
                this.maybeCooldownAfterLoss({
                  userId,
                  cfgKey,
                  cfg: botAndCfg?.cfg,
                  profit,
                  reason: "reconcile:early_sell_loss",
                  meta: { tradeId: tr.id, contractId, accountId, early_sold: true },
                });

                // ✅ losing-streak protection (independent per cfg)
                this.maybeApplyLosingStreakProtection({
                  userId,
                  cfgKey,
                  cfg: botAndCfg?.cfg,
                  profit,
                  reason: "reconcile:early_sell_result",
                  meta: { tradeId: tr.id, contractId, accountId, early_sold: true },
                });
              }

              this.releaseOpenOnceByTradeId(tradeIdStr);

              this.wsLog(userId, "early sell executed", {
                tradeId: tr.id,
                contractId,
                profitNow,
                threshold: earlySellProfit,
                sellPrice,
              });

              this.deleteEarlySellState(contractId);
            } else {
              this.wsLog(userId, "early sell attempted (not sold yet)", {
                tradeId: tr.id,
                contractId,
                profitNow,
                threshold: earlySellProfit,
              });

              this.scheduleReconcileSoon(userId, accountId, 1500);
            }
          } catch (e) {
            this.wsLog(userId, "early sell failed", { tradeId: tr.id, contractId, error: String(e) });
            this.scheduleReconcileSoon(userId, accountId, 1500);
          }
        }
      }

      if ((this.armedCountByAccount.get(ak) ?? 0) > 0) {
        this.scheduleReconcileSoon(userId, accountId, 1500);
      }
    } finally {
      this.reconcileInFlight.delete(ak);
    }
  }

  // ✅ resolve cfgKey -> actual cfg (for cooldown config lookup)
  private findBotAndCfgByCfgKey(cfgKey: string): { bot: Running; cfg: BotConfig } | null {
    // cfgKey format: `${userId}::${runId}::${cfgId}`
    const parts = String(cfgKey ?? "").split("::");
    if (parts.length < 3) return null;

    const userId = parts[0];
    const runId = parts[1];
    const cfgId = parts.slice(2).join("::");

    const bot = this.runs.get(this.runKey(userId, runId));
    if (!bot) return null;

    const cfg = bot.configs.find((c) => c.id === cfgId);
    if (!cfg) return null;

    return { bot, cfg };
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
    bot.heartbeat_at = new Date().toISOString();
    this.wsStatus(bot.userId, this.getStatus(bot.userId));

    // ✅ periodically reconcile live trades (closes stuck open rows after restarts/timeouts)
    {
      const liveAccountIds = Array.from(
        new Set(
          bot.configs
            .filter((c) => c.enabled && c.mode === "live")
            .map((c) => c.account_id)
            .filter(Boolean),
        ),
      );

      for (const accountId of liveAccountIds) {
        void this.reconcileAccountLiveTrades(bot.userId, accountId).catch((e) =>
          this.wsLog(bot.userId, "reconcile (tick) failed", { accountId, error: String(e) }),
        );
      }
    }

    for (const cfg of bot.configs.filter((c) => c.enabled)) {
      try {
        await this.runConfig(bot, cfg);
      } catch (e: any) {
        this.wsLog(bot.userId, `runConfig error: ${e?.stack || e?.message || String(e)}`, {
          symbol: cfg.symbol,
          timeframe: cfg.timeframe,
          strategy_id: cfg.strategy_id,
        });
      }
    }
  }

  // ---- spike exhaustion protection helpers (runtime state) ----
  private parseSpikeWindowTicks(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.spike_window_ticks;
    const n = typeof raw === "number" ? raw : raw === "" || raw == null ? NaN : Number(raw);
    // default 30 ticks, clamp 5..500
    const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
    return Math.min(500, Math.max(5, v));
  }

  private parseSpikeMoveThreshold(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.spike_move_threshold;
    const n = typeof raw === "number" ? raw : raw === "" || raw == null ? 0 : Number(raw);
    // 0 disables
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }

  private parseSpikePauseSeconds(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.spike_pause_seconds;
    const n = typeof raw === "number" ? raw : raw === "" || raw == null ? 0 : Number(raw);
    // 0 disables; clamp to 0..1h
    return Number.isFinite(n) ? Math.min(3600, Math.max(0, Math.floor(n))) : 0;
  }

  private getSpikePauseUntil(cfgKey: string): number {
    return this.spikePauseUntilByCfgKey.get(cfgKey) ?? 0;
  }

  private isSpikePauseActive(cfgKey: string): { active: boolean; remainingMs: number } {
    const until = this.getSpikePauseUntil(cfgKey);
    const now = Date.now();
    if (until > now) return { active: true, remainingMs: until - now };
    return { active: false, remainingMs: 0 };
  }

  private startSpikePause(cfgKey: string, seconds: number) {
    const sec = Math.max(0, Math.floor(seconds));
    if (!sec) return;

    const now = Date.now();
    const nextUntil = now + sec * 1000;

    // Extend if already paused
    const prev = this.spikePauseUntilByCfgKey.get(cfgKey) ?? 0;
    this.spikePauseUntilByCfgKey.set(cfgKey, Math.max(prev, nextUntil));
  }

  private getSpikeExhaustionGate(
    cfgKey: string,
    cfg: BotConfig,
  ):
    | { ok: true; triggered: false; move: number; window: number; threshold: number; pauseSec: number; quotesUsed: number }
    | { ok: false; triggered: true; move: number; window: number; threshold: number; pauseSec: number; quotesUsed: number } {
    const threshold = this.parseSpikeMoveThreshold(cfg);
    const pauseSec = this.parseSpikePauseSeconds(cfg);
    const window = this.parseSpikeWindowTicks(cfg);

    // disabled unless both threshold+pause are set
    if (!(threshold > 0) || !(pauseSec > 0)) {
      return { ok: true, triggered: false, move: 0, window, threshold, pauseSec, quotesUsed: 0 };
    }

    const st = this.recentTickQuotesByCfgKey.get(cfgKey);
    const arr = st?.quotes ?? [];
    if (arr.length < window) {
      // Fail-open until we have enough ticks
      return { ok: true, triggered: false, move: 0, window, threshold, pauseSec, quotesUsed: arr.length };
    }

    const slice = arr.slice(-window);
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const q of slice) {
      if (q < lo) lo = q;
      if (q > hi) hi = q;
    }
    const move = Number.isFinite(hi) && Number.isFinite(lo) ? hi - lo : 0;

    if (move > threshold) {
      return { ok: false, triggered: true, move, window, threshold, pauseSec, quotesUsed: window };
    }

    return { ok: true, triggered: false, move, window, threshold, pauseSec, quotesUsed: window };
  }

  // ---- tick volatility filter helpers (runtime state) ----
  private parseTickWindow(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.tick_window;
    const n = typeof raw === "number" ? raw : raw === "" || raw == null ? 0 : Number(raw);
    // default 30 ticks, clamp 5..500
    const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
    return Math.min(500, Math.max(5, v));
  }

  private parseTickRangeMin(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.tick_range_min;
    const n = typeof raw === "number" ? raw : raw === "" || raw == null ? 0 : Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }

  private parseTickRangeMax(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.tick_range_max;
    const n = typeof raw === "number" ? raw : raw === "" || raw == null ? 0 : Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }

  private pushTickQuote(cfgKey: string, quote: number, keepLastN: number) {
    if (!Number.isFinite(quote)) return;

    const st = this.recentTickQuotesByCfgKey.get(cfgKey) ?? { quotes: [] };
    st.quotes.push(quote);

    // Trim to keepLastN (plus a small cushion)
    const MAX_KEEP = Math.min(600, Math.max(keepLastN, 50));
    if (st.quotes.length > MAX_KEEP) st.quotes.splice(0, st.quotes.length - MAX_KEEP);

    this.recentTickQuotesByCfgKey.set(cfgKey, st);
  }

  private getTickRangeGate(
    cfgKey: string,
    cfg: BotConfig,
  ):
    | { ok: true; range: number; window: number; min: number; max: number; quotesUsed: number }
    | { ok: false; reason: "below_min" | "above_max"; range: number; window: number; min: number; max: number; quotesUsed: number } {
    const window = this.parseTickWindow(cfg);
    const min = this.parseTickRangeMin(cfg);
    const max = this.parseTickRangeMax(cfg);

    // if both disabled, gate is off
    if (!(min > 0) && !(max > 0)) {
      return { ok: true, range: 0, window, min, max, quotesUsed: 0 };
    }

    const st = this.recentTickQuotesByCfgKey.get(cfgKey);
    const arr = st?.quotes ?? [];
    if (arr.length < window) {
      // Fail-open until we have enough ticks (do not block execution due to missing stream)
      return { ok: true, range: 0, window, min, max, quotesUsed: arr.length };
    }

    const slice = arr.slice(-window);
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const q of slice) {
      if (q < lo) lo = q;
      if (q > hi) hi = q;
    }

    const range = Number.isFinite(hi) && Number.isFinite(lo) ? hi - lo : 0;

    if (min > 0 && range < min) {
      return { ok: false, reason: "below_min", range, window, min, max, quotesUsed: window };
    }
    if (max > 0 && range > max) {
      return { ok: false, reason: "above_max", range, window, min, max, quotesUsed: window };
    }

    return { ok: true, range, window, min, max, quotesUsed: window };
  }

  // ✅ tick->1s candle builder state (per run/config)
  private tick1sCandleStateByCfgKey = new Map<
    string,
    { sec: number; o: number; h: number; l: number; c: number; v: number; candles: any[] }
  >();

  // ✅ tick execution throttle / in-flight (per run/config)
  private tickExecInFlightByCfgKey = new Set<string>();
  private lastTickExecAtByCfgKey = new Map<string, number>();

  private isTickByTickCfg(cfg: BotConfig): boolean {
    return String(cfg.timeframe ?? "").trim().toLowerCase() === "1s";
  }

  private update1sCandleFromTick(cfgKey: string, epochSec: number, quote: number) {
    const sec = Math.floor(epochSec);
    if (!Number.isFinite(sec) || !Number.isFinite(quote)) return;

    const st = this.tick1sCandleStateByCfgKey.get(cfgKey);
    if (!st) {
      this.tick1sCandleStateByCfgKey.set(cfgKey, {
        sec,
        o: quote,
        h: quote,
        l: quote,
        c: quote,
        v: 1,
        candles: [],
      });
      return;
    }

    if (st.sec === sec) {
      st.h = Math.max(st.h, quote);
      st.l = Math.min(st.l, quote);
      st.c = quote;
      st.v += 1;
      return;
    }

    // close previous second candle
    st.candles.push({ t: st.sec, o: st.o, h: st.h, l: st.l, c: st.c, v: st.v });
    if (st.candles.length > 300) st.candles.splice(0, st.candles.length - 300);

    // start new candle
    st.sec = sec;
    st.o = quote;
    st.h = quote;
    st.l = quote;
    st.c = quote;
    st.v = 1;
  }

  private get1sCandles(cfgKey: string, count: number) {
    const st = this.tick1sCandleStateByCfgKey.get(cfgKey);
    if (!st) return [];
    const arr = st.candles.slice(-Math.max(1, count - 1));
    // include current forming candle as last candle
    arr.push({ t: st.sec, o: st.o, h: st.h, l: st.l, c: st.c, v: st.v });
    return arr.slice(-count);
  }

  private buildSignalKey(candles: Array<{ t: number }>, signal: any): string {
    const last = candles?.[candles.length - 1];
    const t = Math.floor(Number(last?.t) || 0);
    const side = String(signal?.side ?? "");
    const reason = String(signal?.reason ?? "");
    return `${t}::${side}::${reason}`;
  }

  private buildTickSignalKey(epochSec: number, signal: any): string {
    const t = Math.floor(Number(epochSec) || 0);
    const side = String(signal?.side ?? "");
    const reason = String(signal?.reason ?? "");
    return `${t}::${side}::${reason}`;
  }

  // ✅ Dedup helpers: one execution per candle/signal (per run/config)
  private hasExecutedSignal(cfgKey: string, signalKey: string): boolean {
    if (!cfgKey || !signalKey) return false;
    return (this.lastExecutedSignalKeyByCfgKey.get(cfgKey) ?? "") === signalKey;
  }

  private markSignalExecuted(cfgKey: string, signalKey: string) {
    if (!cfgKey || !signalKey) return;
    this.lastExecutedSignalKeyByCfgKey.set(cfgKey, signalKey);
  }

  private async runTickByTick(bot: Running, cfg: BotConfig, epochSec: number, quote: number) {
    const ck = this.cfgKey(bot, cfg);

    // throttle + prevent overlap
    const throttleMs = Math.max(0, Number((cfg.params as any)?.tick_exec_throttle_ms ?? 250) || 250);
    const now = Date.now();
    const last = this.lastTickExecAtByCfgKey.get(ck) ?? 0;
    if (now - last < throttleMs) return;
    if (this.tickExecInFlightByCfgKey.has(ck)) return;

    this.lastTickExecAtByCfgKey.set(ck, now);
    this.tickExecInFlightByCfgKey.add(ck);

    try {
      // need an already-connected client (runConfig subscribes/creates it)
      const deriv = this.derivClients.get(cfg.account_id);
      if (!deriv) return;

      const candles = this.get1sCandles(ck, 120);
      if (candles.length < 20) return; // warm-up

      const strat = getStrategy(cfg.strategy_id);
      const ctx: StrategyContext = { symbol: cfg.symbol, timeframe: cfg.timeframe as any, now: new Date() };
      const signal = strat.generateSignal(candles, ctx, cfg.params);

      if (!signal?.side) return;
      if ((signal?.confidence ?? 0) < 0.5) return;

      // tick-level dedupe key (1 per second per side/reason)
      const signalKey = this.buildTickSignalKey(epochSec, signal);

      // --- BEGIN: reuse existing execution section (copied from runConfig) ---
      if (this.hasExecutedSignal(ck, signalKey)) return;

      // spike pause gate
      const sp = this.isSpikePauseActive(ck);
      if (sp.active) return;

      // spike exhaustion trigger
      const sg = this.getSpikeExhaustionGate(ck, cfg);
      if (!sg.ok && sg.triggered) {
        this.startSpikePause(ck, sg.pauseSec);
        return;
      }

      // tick range gate
      const tg = this.getTickRangeGate(ck, cfg);
      if (!tg.ok) return;

      // cooldown gate
      const cd = this.isInCooldown(ck);
      if (cd.active) return;

      // min time between trades gate
      const mt = this.isMinTradeIntervalActive(ck, cfg);
      if (mt.active) return;

      // trades-per-minute gate
      const tf = this.isTradeFrequencyLimited(ck, cfg);
      if (tf.active) return;

      // losing-streak pause gate
      const lp = this.isLossPauseActive(ck);
      if (lp.active) return;

      const maxOpenTrades = this.parseCfgMaxOpenTrades(cfg);
      const currentOpen = this.getOpenCount(bot, cfg);
      if (currentOpen >= maxOpenTrades) return;

      // ✅ DB/risk gate should NOT be per-config (that blocks other bots).
      // Use a global cap equal to sum of enabled bots' max_open_trades.
      const globalCap = this.computeUserGlobalOpenTradesCap(bot.userId);
      const gate = await canOpenTrade(bot.userId, {
        max_open_trades: maxOpenTrades,
        run_id: bot.runId, // ✅ per-bot
      });
      if (!gate.ok) return;

      const rules = await getRiskRules(bot.userId);
      const stake = computeStake(rules, 1000);

      if (cfg.mode === "paper") {
        this.incOpen(bot, cfg);
        try {
          const { profit } = await this.paperTrade(bot.userId, cfg, signal, stake);
          this.markSignalExecuted(ck, signalKey);
          this.markTradeExecuted(ck);

          this.maybeCooldownAfterLoss({
            userId: bot.userId,
            cfgKey: ck,
            cfg,
            profit,
            reason: "paper_trade_loss(tick)",
            meta: { runId: bot.runId, cfg_id: cfg.id, symbol: cfg.symbol, timeframe: cfg.timeframe },
          });

          this.maybeApplyLosingStreakProtection({
            userId: bot.userId,
            cfgKey: ck,
            cfg,
            profit,
            reason: "paper_trade_result(tick)",
            meta: { runId: bot.runId, cfg_id: cfg.id, symbol: cfg.symbol, timeframe: cfg.timeframe },
          });
        } finally {
          this.decOpen(bot, cfg);
        }
      } else if (cfg.mode === "live") {
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

          this.markSignalExecuted(ck, signalKey);
          this.markTradeExecuted(ck);

          const buy = res?.buy || res;
          const contractId = Number(buy?.contract_id ?? buy?.contract_id_buy ?? 0);
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
                early_sell_enabled: earlyEnabled,
                early_sell_profit: earlyEnabled ? earlyProfit : 0,

                // ✅ NEW: attribute trade to this bot/run (per-card in your UI)
                run_id: bot.runId,
                cfg_id: cfg.id,
              },
            })
            .select("*")
            .single();

          if (insert.data) {
            this.wsTrade(bot.userId, insert.data);
            this.tradeToCfgKey.set(String(insert.data.id), ck);
          }

          const ms = durationToMs(dur, durUnit) + 2000;
          setTimeout(async () => {
            const tradeId = String(insert?.data?.id ?? "");
            try {
              if (!contractId) return;

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
                snap?.sell_time ? new Date(Number(snap.sell_time) * 1000).toISOString() : new Date().toISOString();

              if (tradeId) {
                const { data: updated } = await supabaseAdmin
                  .from("trades")
                  .update({ exit: sellPrice, profit, closed_at: closedAt })
                  .eq("id", tradeId)
                  .select("*")
                  .single();
                if (updated) this.wsTrade(bot.userId, updated);
              }

              this.maybeCooldownAfterLoss({
                userId: bot.userId,
                cfgKey: ck,
                cfg,
                profit,
                reason: "live_finalize_loss(tick)",
                meta: { runId: bot.runId, tradeId, contractId, symbol: cfg.symbol },
              });

              this.maybeApplyLosingStreakProtection({
                userId: bot.userId,
                cfgKey: ck,
                cfg,
                profit,
                reason: "live_finalize_result(tick)",
                meta: { runId: bot.runId, tradeId, contractId, symbol: cfg.symbol },
              });
            } finally {
              if (tradeId) this.releaseOpenOnceByTradeId(tradeId);
              else this.decOpen(bot, cfg);
            }
          }, ms);
        } catch (e) {
          this.decOpen(bot, cfg);
          this.wsLog(bot.userId, "live buy error (tick)", { error: String(e) });
        }
      }
      // --- END: execution section ---
    } finally {
      this.tickExecInFlightByCfgKey.delete(ck);
    }
  }

  private handleTickSafely(tick: any) {
    try {
      if (!tick || typeof tick.epoch !== "number") return;

      const symbol = String(tick.symbol ?? "").trim();
      const quote = typeof tick.quote === "number" ? tick.quote : tick.quote ? Number(tick.quote) : undefined;
      if (!symbol) return;
      if (!Number.isFinite(quote)) return;

      const epochSec = Number(tick.epoch);

      const now = Date.now();
      const THROTTLE_MS = 2000;

      for (const bot of this.runs.values()) {
        for (const cfg of bot.configs) {
          if (!cfg.enabled) continue;
          if (cfg.symbol !== symbol) continue;

          const ck = this.cfgKey(bot, cfg);

          const keepN = Math.max(this.parseTickWindow(cfg), this.parseSpikeWindowTicks(cfg));
          this.pushTickQuote(ck, quote, keepN);

          // ✅ build 1s candles + execute tick-by-tick
          if (this.isTickByTickCfg(cfg)) {
            this.update1sCandleFromTick(ck, epochSec, quote);
            void this.runTickByTick(bot, cfg, epochSec, quote).catch(() => void 0);
          }
        }

        const matches = bot.configs.some((c) => c.enabled && c.symbol === symbol);
        if (!matches) continue;

        const k = `${bot.userId}::${symbol}`;
        const last = this.lastTickLogAt.get(k) ?? 0;
        if (now - last < THROTTLE_MS) continue;
        this.lastTickLogAt.set(k, now);

        this.wsLog(bot.userId, "tick", { symbol, epoch: Number(tick.epoch), quote });
      }
    } catch (e) {
      console.error("tick error (final)", (e as any) && ((e as any).stack || (e as any).message || e));
      try {
        console.debug("tick payload (final):", JSON.stringify(tick));
      } catch {}
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
      this.wsLog(bot.userId, "skipping non-deriv account", { accountId: cfg.account_id, accountType: acc.type });
      return;
    }

    let token = "";
    try {
      token = await this.accountToken(cfg.account_id);
    } catch (e) {
      this.wsLog(bot.userId, "Failed to decrypt Deriv token", { error: String(e) });
      return;
    }
    if (!token) {
      this.wsLog(bot.userId, "Deriv token missing after decrypt", { accountId: cfg.account_id });
      return;
    }

    const deriv = await this.getDerivClient(cfg.account_id, token);

    // ✅ ensure tick subscriptions are correct for this account (multiple symbols supported)
    await this.syncAccountTickSubscriptions(cfg.account_id);

    // ✅ if timeframe is 1s => tick-by-tick execution; skip candle polling execution
    if (this.isTickByTickCfg(cfg)) return;

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
        this.wsLog(bot.userId, "starting backtest", { symbol: cfg.symbol, timeframe: cfg.timeframe, accountId: cfg.account_id });

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
              this.wsLog(bot.userId, msg.message, { ...(msg.meta ?? {}), ts: msg.ts });
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
              this.wsLog(bot.userId, "backtest persist error", { error: String(insertErr) });
            } else {
              for (const tr of inserted ?? []) this.wsTrade(bot.userId, tr);
                       }
          } catch (e) {
            this.wsLog(bot.userId, "backtest persist exception", { error: String(e) });
          }
        }

        this.wsLog(bot.userId, "backtest finished", { metrics: result?.metrics ?? {} });
      } catch (e) {
        this.wsLog(bot.userId, "backtest error", { error: String(e) });
      }
      return; // don't run live/paper flow after backtest
    }

    // Paper/Live modes
    const strat = getStrategy(cfg.strategy_id);
    const ctx: StrategyContext = { symbol: cfg.symbol, timeframe: cfg.timeframe as any, now: new Date() };
    const signal = strat.generateSignal(candles, ctx, cfg.params);

    if (!signal.side) return;
    if (signal.confidence < 0.5) return;

    const ck = this.cfgKey(bot, cfg);

    // ✅ Dedup: don't execute more than once per same candle/signal
    const signalKey = this.buildSignalKey(candles, signal);
    if (this.hasExecutedSignal(ck, signalKey)) {
      this.wsLog(bot.userId, "duplicate signal (skipping execution)", {
        runId: bot.runId,
        cfg_id: cfg.id,
        symbol: cfg.symbol,
        signalKey,
      });
      return;
    }

    // ✅ spike exhaustion pause gate (execution only; does not block signal generation)
    const sp = this.isSpikePauseActive(ck);
    if (sp.active) {
      this.wsLog(bot.userId, "spike exhaustion pause active (skipping execution)", {
        runId: bot.runId,
        cfg_id: cfg.id,
        symbol: cfg.symbol,
        remaining_sec: Math.ceil(sp.remainingMs / 1000),
        pauseUntil: new Date(this.getSpikePauseUntil(ck)).toISOString(),
      });
      return;
    }

    // ✅ detect extreme move in last M ticks; start pause if triggered (execution only)
    const sg = this.getSpikeExhaustionGate(ck, cfg);
    if (!sg.ok && sg.triggered) {
      this.startSpikePause(ck, sg.pauseSec);
      this.wsLog(bot.userId, "spike exhaustion triggered (pausing execution)", {
        runId: bot.runId,
        cfg_id: cfg.id,
        symbol: cfg.symbol,
        spike_window_ticks: sg.window,
        spike_move_threshold: sg.threshold,
        spike_pause_seconds: sg.pauseSec,
        observed_move: sg.move,
        quotes_used: sg.quotesUsed,
        pauseUntil: new Date(this.getSpikePauseUntil(ck)).toISOString(),
      });
      return;
    }

    // ✅ tick volatility filter gate (execution only; does not block signal generation)
    const tg = this.getTickRangeGate(ck, cfg);
    if (!tg.ok) {
      this.wsLog(bot.userId, "tick range filter (skipping execution)", {
        runId: bot.runId,
        cfg_id: cfg.id,
        symbol: cfg.symbol,
        reason: tg.reason,
        tick_window: tg.window,
        tick_range_min: tg.min,
        tick_range_max: tg.max,
        tick_range: tg.range,
        quotes_used: tg.quotesUsed,
      });
      return;
    }

    // ✅ cooldown gate (execution only; does not block signal generation)
    const cd = this.isInCooldown(ck);
    if (cd.active) {
      this.wsLog(bot.userId, "cooldown active (skipping execution)", {
        runId: bot.runId,
        cfg_id: cfg.id,
        symbol: cfg.symbol,
        remaining_sec: Math.ceil(cd.remainingMs / 1000),
        cooldownUntil: new Date(this.getCooldownUntil(ck)).toISOString(),
      });
      return;
    }

    // ✅ min time between trades gate (execution only; does not block signal generation)
    const mt = this.isMinTradeIntervalActive(ck, cfg);
    if (mt.active) {
      this.wsLog(bot.userId, "min-trade-interval active (skipping execution)", {
        runId: bot.runId,
        cfg_id: cfg.id,
        symbol: cfg.symbol,
        remaining_sec: Math.ceil(mt.remainingMs / 1000),
        min_seconds_between_trades: mt.seconds,
        lastTradeAt: new Date(this.getLastTradeAt(ck)).toISOString(),
      });
      return;
    }

    // ✅ trades-per-minute gate (execution only; does not block signal generation)
    const tf = this.isTradeFrequencyLimited(ck, cfg);
    if (tf.active) {
      this.wsLog(bot.userId, "trade frequency limit reached (skipping execution)", {
        runId: bot.runId,
        cfg_id: cfg.id,
        symbol: cfg.symbol,
        remaining_sec: Math.ceil(tf.remainingMs / 1000),
        max_trades_per_minute: tf.limit,
        trades_in_last_60s: tf.count,
      });
      return;
    }

    // ✅ losing-streak pause gate (execution only; does not block signal generation)
    const lp = this.isLossPauseActive(ck);
    if (lp.active) {
      this.wsLog(bot.userId, "losing-streak pause active (skipping execution)", {
        runId: bot.runId,
        cfg_id: cfg.id,
        symbol: cfg.symbol,
        remaining_sec: Math.ceil(lp.remainingMs / 1000),
        pauseUntil: new Date(this.getLossPauseUntil(ck)).toISOString(),
        consecutive_losses: this.getConsecutiveLosses(ck),
        max_consecutive_losses: this.parseMaxConsecutiveLosses(cfg),
        pause_after_loss_minutes: this.parsePauseAfterLossMinutes(cfg),
      });
      return;
    }

    // Enforce per-bot max open trades
    const maxOpenTrades = Math.max(1, Number(cfg.params?.max_open_trades ?? 5));
    const currentOpen = this.getOpenCount(bot, cfg);
    if (currentOpen >= maxOpenTrades) {
      this.wsLog(bot.userId, "open-trade limit reached", {
        runId: bot.runId,
        cfg_id: cfg.id,
        symbol: cfg.symbol,
        limit: maxOpenTrades,
        current: currentOpen,
      });
      return;
    }

    // ✅ also apply the same limit to the global risk gate
    const globalCap = this.computeUserGlobalOpenTradesCap(bot.userId);
    const gate = await canOpenTrade(bot.userId, {
      max_open_trades: maxOpenTrades,
      run_id: bot.runId, // ✅ per-bot
    });
    if (!gate.ok) {
      this.wsLog(bot.userId, "risk block", {
        reason: gate.reason,
        symbol: cfg.symbol,
        global_max_open_trades: globalCap,
      });
      return;
    }

    const rules = await getRiskRules(bot.userId);
    const stake = computeStake(rules, 1000);

    if (cfg.mode === "paper") {
      this.incOpen(bot, cfg);
      try {
        const { profit } = await this.paperTrade(bot.userId, cfg, signal, stake);

        // ✅ mark executed (dedupe) + record trade execution (min interval + trades/minute)
        this.markSignalExecuted(ck, signalKey);
        this.markTradeExecuted(ck);

        // ✅ do not reset cooldown_after_loss behavior
        this.maybeCooldownAfterLoss({
          userId: bot.userId,
          cfgKey: ck,
          cfg,
          profit,
          reason: "paper_trade_loss",
          meta: {
            runId: bot.runId,
            cfg_id: cfg.id,
            symbol: cfg.symbol,
            timeframe: cfg.timeframe,
            strategy_id: cfg.strategy_id,
          },
        });

        // ✅ losing-streak protection (independent per cfg)
        this.maybeApplyLosingStreakProtection({
          userId: bot.userId,
          cfgKey: ck,
          cfg,
          profit,
          reason: "paper_trade_result",
          meta: { runId: bot.runId, cfg_id: cfg.id, symbol: cfg.symbol, timeframe: cfg.timeframe, strategy_id: cfg.strategy_id },
        });
      } finally {
        this.decOpen(bot, cfg);
      }
    } else if (cfg.mode === "live") {
      this.wsLog(bot.userId, "live mode requested (minimal implementation)", { symbol: cfg.symbol });

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

        // ✅ Dedup latch for LIVE too (prevents re-buying same candle/signal on next 5s tick)
        this.markSignalExecuted(ck, signalKey);

        // ✅ record trade execution as soon as buy succeeds (min interval + trades/minute)
        this.markTradeExecuted(ck);

        // Insert opened live trade
        const buy = res?.buy || res;
        const contractId = Number(buy?.contract_id ?? buy?.contract_id_buy ?? buy?.longcode?.contract_id ?? 0);
        const buyPrice = Number(buy?.buy_price ?? buy?.price ?? stakeParam);
        const openedAt = new Date().toISOString();

        const earlyEnabled = Boolean((cfg.params as any)?.early_sell_enabled ?? false);
        const earlyProfit = Math.max(0, Number((cfg.params as any)?.early_sell_profit ?? 0) || 0);

        const insert = await supabaseAdmin // ✅ make sure this is not truncated to "dmin"
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
              early_sell_enabled: earlyEnabled,
              early_sell_profit: earlyEnabled ? earlyProfit : 0,

              // ✅ NEW: attribute trade to this bot/run (per-card in your UI)
              run_id: bot.runId,
              cfg_id: cfg.id,
            },
          })
          .select("*")
          .single();

        if (insert.data) {
          this.wsTrade(bot.userId, insert.data);
          // ✅ map trade -> cfgKey so reconciliation/loss cooldown is per run/config
          this.tradeToCfgKey.set(String(insert.data.id), ck);
        }

        // Finalize after expiry
        const ms = durationToMs(dur, durUnit) + 2000;
        setTimeout(async () => {
          const tradeId = String(insert?.data?.id ?? "");
          try {
            if (!contractId) {
              this.wsLog(bot.userId, "live finalize: missing contract_id");
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
              snap?.is_sold && snap?.sell_time
                ? new Date(Number(snap.sell_time) * 1000).toISOString()
                : new Date().toISOString();

            if (tradeId) {
              const { data: updated } = await supabaseAdmin
                .from("trades")
                .update({ exit: sellPrice, profit, closed_at: closedAt })
                .eq("id", tradeId)
                .select("*")
                .single();
              if (updated) this.wsTrade(bot.userId, updated);
            }

            // ✅ do not reset cooldown_after_loss behavior
            this.maybeCooldownAfterLoss({
              userId: bot.userId,
              cfgKey: ck,
              cfg,
              profit,
              reason: "live_finalize_loss",
              meta: { runId: bot.runId, tradeId, contractId, symbol: cfg.symbol },
            });

            // ✅ losing-streak protection (independent per cfg)
            this.maybeApplyLosingStreakProtection({
              userId: bot.userId,
              cfgKey: ck,
              cfg,
              profit,
              reason: "live_finalize_result",
              meta: { runId: bot.runId, tradeId, contractId, symbol: cfg.symbol },
            });
          } catch (e) {
            this.wsLog(bot.userId, "live finalize error", { error: String(e) });
          } finally {
            if (tradeId) this.releaseOpenOnceByTradeId(tradeId);
            else this.decOpen(bot, cfg);
          }
        }, ms);
      } catch (e) {
        this.decOpen(bot, cfg);
        this.wsLog(bot.userId, "live buy error", { error: String(e) });
      }
    }
  }

  private async paperTrade(userId: string, cfg: BotConfig, signal: any, stake: number): Promise<{ profit: number; trade: any }> {
    const entry = signal.entry ?? 0;
    const sl = signal.sl ?? null;
    const tp = signal.tp ?? null;

    const spread = entry * 0.0002;
    const slippage = entry * 0.0001 * (Math.random() - 0.5);
    const fill = entry + (signal.side === "buy" ? spread : -spread) + slippage;

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
    this.wsTrade(userId, data);
    this.wsLog(userId, "paper trade", { symbol: cfg.symbol, side: signal.side, profit });

    return { profit, trade: data };
  }

  // Replace running configs for a user and apply immediately
  public async updateConfigs(userId: string, configs: Omit<BotConfig, "id">[]) {
    let updated = 0;
    for (const [, bot] of this.runs) {
      if (bot.userId !== userId) continue;
      bot.configs = configs.map((c) => ({ ...c, id: uuidv4() }));
      updated++;
    }
    this.wsLog(userId, "bot.configs.updated", { userId, runs_updated: updated });
    this.wsStatus(userId, this.getStatus(userId));

    const accountIds = Array.from(new Set(configs.map((c) => c.account_id)));
    for (const accountId of accountIds) {
      await this.syncAccountTickSubscriptions(accountId).catch(() => void 0);

      // ✅ schedule a forced reconcile after config change (best-effort)
      this.scheduleReconcileSoon(userId, accountId, 500);
    }
  }

  private parseCfgMaxOpenTrades(cfg: BotConfig): number {
    const raw = (cfg?.params as any)?.max_open_trades;
    const n = typeof raw === "number" ? raw : raw == null || raw === "" ? 5 : Number(raw);
    const v = Number.isFinite(n) ? Math.floor(n) : 5;
    // clamp 1..100 (per config)
    return Math.min(100, Math.max(1, v));
  }

  // ✅ Global cap used only for DB-based safety gate (canOpenTrade).
  // Make it "per bot" by summing each enabled config's max_open_trades.
  private computeUserGlobalOpenTradesCap(userId: string): number {
    let sum = 0;

    for (const run of this.runs.values()) {
      if (run.userId !== userId) continue;
      for (const cfg of run.configs) {
        if (!cfg.enabled) continue;
        sum += this.parseCfgMaxOpenTrades(cfg);
      }
    }

    // fail-safe clamp (prevents runaway caps if user starts many bots)
    if (!sum) sum = 1;
    return Math.min(500, Math.max(1, sum));
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