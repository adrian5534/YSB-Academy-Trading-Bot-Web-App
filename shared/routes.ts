import { z } from "zod";

// Const tuples for enums
const ACCOUNT_TYPES = ["deriv", "mt5"] as const;
const BOT_STATES = ["stopped", "running"] as const;
const TRADING_MODES = ["backtest", "paper", "live"] as const;
const TIMEFRAMES = ["1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"] as const;
const STRATEGY_IDS = [
  "candle_pattern",
  "one_hour_trend",
  "trend_confirmation",
  "scalping_hwr",
  "trend_pullback",
  "supply_demand_sweep",
  "fvg_retracement",
  "range_mean_reversion",
] as const;

// Shared primitives
export const zUuid = z.string().uuid();
export const zIsoDate = z.string();

// Timeframe export (ensure index.ts does not re-export another Timeframe to avoid TS2308)
export type Timeframe = (typeof TIMEFRAMES)[number];
export const zTimeframe = z.enum(TIMEFRAMES);

// Subscription/Profile
export const zSubscription = z.object({
  plan: z.enum(["free", "pro"]),
  status: z.enum(["active", "past_due", "canceled", "inactive"]),
  current_period_end: zIsoDate.nullable(),
});

export const zProfile = z.object({
  id: z.string(),
  email: z.string().email().nullable(),
  role: z.enum(["user", "admin"]).default("user"),
  created_at: zIsoDate,
});

// Accounts / connections
export const zAccount = z.object({
  id: zUuid,
  user_id: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  label: z.string().min(1),
  status: z.enum(["active", "inactive", "error"]).default("active"),
  created_at: zIsoDate,
});

export const zDerivTokenValidateReq = z.object({ token: z.string().min(5) });
export const zDerivTokenValidateRes = z.object({
  ok: z.boolean(),
  account_id: z.string().optional(),
  currency: z.string().optional(),
  message: z.string().optional(),
});

export const zMt5LoginReq = z.object({
  server: z.string().min(2),
  login: z.string().min(1),
  password: z.string().min(1),
});
export const zMt5LoginRes = z.object({
  ok: z.boolean(),
  account_info: z.record(z.any()).optional(),
  message: z.string().optional(),
});

// Instruments
export const zInstrument = z.object({
  symbol: z.string(),
  display_name: z.string(),
  market: z.string().optional(),
  market_display_name: z.string().optional(),
  subgroup: z.string().optional(),
  subgroup_display_name: z.string().optional(),
  exchange_is_open: z.boolean().optional(),
});

// Strategies
export const zStrategyMeta = z.object({
  id: z.enum(STRATEGY_IDS),
  name: z.string(),
  description: z.string(),
  default_params: z.record(z.any()),
});

// Risk rules
export const zRiskRules = z.object({
  risk_type: z.enum(["fixed_stake", "percent_balance"]),
  fixed_stake: z.number().min(0).default(1),
  percent_risk: z.number().min(0).max(5).default(1),
  max_daily_loss: z.number().min(0).default(50),
  max_drawdown: z.number().min(0).default(200),
  max_open_trades: z.number().min(1).max(50).default(3),
  adaptive_enabled: z.boolean().default(false),
  adaptive_min_percent: z.number().min(0).max(5).default(0.25),
  adaptive_max_percent: z.number().min(0).max(5).default(2),
  adaptive_step: z.number().min(0).max(1).default(0.25),
  adaptive_lookback: z.number().min(5).max(200).default(25),
});

// Candle
export const zCandle = z.object({
  t: z.number(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number().optional(),
});

// Bot config/status
export const zBotConfig = z.object({
  id: zUuid.optional(),
  account_id: zUuid,
  symbol: z.string(),
  timeframe: z.enum(TIMEFRAMES),
  strategy_id: zStrategyMeta.shape.id,
  mode: z.enum(TRADING_MODES),
  params: z.record(z.any()).default({}),
  enabled: z.boolean().default(true),
});

export const zBotStartReq = z.object({
  name: z.string().min(1).default("Bot"),
  configs: z.array(zBotConfig).min(1),
});

export const zBotStatus = z.object({
  state: z.enum(BOT_STATES),
  name: z.string(),
  started_at: zIsoDate.nullable(),
  heartbeat_at: zIsoDate.nullable(),
  active_configs: z.number(),
});

// Trades / Journals
export const zTrade = z.object({
  id: zUuid,
  user_id: z.string(),
  account_id: zUuid,
  mode: z.enum(TRADING_MODES),
  symbol: z.string(),
  strategy_id: zStrategyMeta.shape.id,
  timeframe: zBotConfig.shape.timeframe,
  side: z.enum(["buy", "sell"]),
  entry: z.number(),
  sl: z.number().nullable(),
  tp: z.number().nullable(),
  exit: z.number().nullable(),
  profit: z.number().nullable(),
  opened_at: zIsoDate,
  closed_at: zIsoDate.nullable(),
  meta: z.record(z.any()).default({}),
});

export const zJournal = z.object({
  id: zUuid,
  user_id: z.string(),
  trade_id: zUuid.nullable(),
  title: z.string().min(1),
  note: z.string().default(""),
  tags: z.array(z.string()).default([]),
  screenshot_path: z.string().nullable(),
  created_at: zIsoDate,
});

// Backtests
export const zBacktestReq = z.object({
  strategy_id: zStrategyMeta.shape.id,
  symbol: z.string(),
  timeframe: zBotConfig.shape.timeframe,
  params: z.record(z.any()).default({}),
  csv: z.string().min(1),
});

export const zBacktestRes = z.object({
  ok: z.boolean(),
  metrics: z.object({
    trades: z.number(),
    win_rate: z.number(),
    profit_factor: z.number(),
    expectancy: z.number(),
    max_drawdown: z.number(),
    pnl: z.number(),
  }),
  sample_trades: z.array(zTrade).default([]),
});

// API contract
export const api = {
  auth: {
    me: { path: "/api/me", responses: { 200: zProfile } },
    subscription: { path: "/api/subscription", responses: { 200: zSubscription } },
  },
  stripe: {
    createCheckout: {
      path: "/api/stripe/create-checkout-session",
      input: z.object({ return_url: z.string().url() }),
      responses: { 200: z.object({ url: z.string().url() }) },
    },
    webhook: { path: "/api/stripe/webhook" },
  },
  accounts: {
    list: { path: "/api/accounts", responses: { 200: z.array(zAccount) } },
    upsertDeriv: {
      path: "/api/accounts/deriv",
      input: z.object({ label: z.string().min(1), token: z.string().min(5) }),
      responses: { 200: zAccount },
    },
    validateDeriv: { path: "/api/accounts/deriv/validate", input: zDerivTokenValidateReq, responses: { 200: zDerivTokenValidateRes } },
    upsertMt5: {
      path: "/api/accounts/mt5",
      input: z.object({ label: z.string().min(1), server: z.string(), login: z.string(), password: z.string() }),
      responses: { 200: zAccount },
    },
    validateMt5: { path: "/api/accounts/mt5/validate", input: zMt5LoginReq, responses: { 200: zMt5LoginRes } },
  },
  instruments: {
    list: { path: "/api/instruments", responses: { 200: z.array(zInstrument) } },
    setEnabled: {
      path: "/api/instruments/enabled",
      input: z.object({ account_id: zUuid, symbol: z.string(), enabled: z.boolean() }),
      responses: { 200: z.object({ ok: z.boolean() }) },
    },
    enabledForAccount: { path: "/api/instruments/enabled/:accountId", responses: { 200: z.array(z.object({ symbol: z.string(), enabled: z.boolean() })) } },
  },
  strategies: {
    list: { path: "/api/strategies", responses: { 200: z.array(zStrategyMeta) } },
    setSettings: {
      path: "/api/strategies/settings",
      input: z.object({
        account_id: zUuid,
        symbol: z.string(),
        timeframe: zBotConfig.shape.timeframe,
        strategy_id: zStrategyMeta.shape.id,
        params: z.record(z.any()),
        enabled: z.boolean(),
      }),
      responses: { 200: z.object({ ok: z.boolean() }) },
    },
    settingsForAccount: { path: "/api/strategies/settings/:accountId", responses: { 200: z.array(z.record(z.any())) } },
  },
  bots: {
    status: { path: "/api/bots/status", responses: { 200: zBotStatus } },
    start: { path: "/api/bots/start", input: zBotStartReq, responses: { 200: z.object({ ok: z.boolean() }) } },
    stop: { path: "/api/bots/stop", responses: { 200: z.object({ ok: z.boolean() }) } },
  },
  trades: {
    list: { path: "/api/trades", responses: { 200: z.array(zTrade) } },
    stats: {
      path: "/api/trades/stats",
      responses: {
        200: z.object({
          totalProfit: z.number(),
          winRate: z.number(),
          totalTrades: z.number(),
          profitFactor: z.number(),
          maxDrawdown: z.number(),
        }),
      },
    },
  },
  journals: {
    list: { path: "/api/journals", responses: { 200: z.array(zJournal) } },
    create: {
      path: "/api/journals",
      input: z.object({
        trade_id: zUuid.nullable().optional(),
        title: z.string().min(1),
        note: z.string().default(""),
        tags: z.array(z.string()).default([]),
        screenshot_path: z.string().nullable().optional(),
      }),
      responses: { 200: zJournal },
    },
    signedUrl: { path: "/api/journals/signed-url", input: z.object({ path: z.string().min(1) }), responses: { 200: z.object({ url: z.string().url() }) } },
  },
  backtests: {
    run: { path: "/api/backtests/run", input: zBacktestReq, responses: { 200: zBacktestRes } },
  },
};

export const WS_EVENTS = {
  BOT_STATUS: "bot.status",
  BOT_LOG: "bot.log",
  TRADE_EVENT: "trade.event",
} as const;