export type FieldType = "number" | "select" | "boolean" | "text";

export type FieldDescriptor = {
  key: string;
  label: string;
  type: FieldType;
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  description?: string;
  // category helps consumers decide where to render: strategy-specific vs execution-level
  category?: "strategy" | "execution";
};

export const EXECUTION_FIELDS: FieldDescriptor[] = [
  { key: "stake", label: "Stake (USD)", type: "number", min: 1, step: 1, default: 250, category: "execution" },
  { key: "duration", label: "Duration", type: "number", min: 1, step: 1, default: 5, category: "execution" },
  {
    key: "duration_unit",
    label: "Duration Unit",
    type: "select",
    options: ["t", "m", "h", "d"],
    default: "m",
    category: "execution",
  },

  // Execution/risk controls (per-bot when stored in bot params)
  {
    key: "max_open_trades",
    label: "Max open trades",
    type: "number",
    min: 1,
    step: 1,
    default: 5,
    category: "execution",
    description: "Maximum number of simultaneous open trades for this bot.",
  },
  {
    key: "max_daily_loss",
    label: "Max daily loss (USD)",
    type: "number",
    min: 0,
    step: 1,
    default: 0,
    category: "execution",
    description: "Set to 0 to disable. When exceeded, the bot should stop opening new trades for the day.",
  },
];

export const STRATEGY_SETTINGS: Record<string, FieldDescriptor[]> = {
  fvg_retracement: [
    { key: "minGapPct", label: "Min Gap %", type: "number", min: 0.0001, max: 0.05, step: 0.0001, default: 0.002 },
    { key: "rr", label: "Risk / Reward", type: "number", min: 0.5, max: 5, step: 0.1, default: 1.3 },
  ],
  candle_pattern: [
    { key: "riskReward", label: "Risk / Reward", type: "number", min: 0.5, max: 5, step: 0.1, default: 1.5 },
    { key: "lookback", label: "Lookback (candles)", type: "number", min: 3, max: 300, step: 1, default: 60 },
  ],
  one_hour_trend: [
    { key: "startHourUtc", label: "Start Hour (UTC)", type: "number", min: 0, max: 23, step: 1, default: 8 },
    { key: "endHourUtc", label: "End Hour (UTC)", type: "number", min: 0, max: 23, step: 1, default: 17 },
    { key: "emaPeriod", label: "EMA Period", type: "number", min: 10, max: 200, step: 1, default: 50 },
    { key: "minSlope", label: "Min Slope", type: "number", min: 0, max: 2, step: 0.001, default: 0.02 },
  ],
  trend_confirmation: [
    { key: "emaFast", label: "EMA Fast", type: "number", min: 10, max: 100, step: 1, default: 50 },
    { key: "emaSlow", label: "EMA Slow", type: "number", min: 50, max: 400, step: 1, default: 200 },
    { key: "rsiPeriod", label: "RSI Period", type: "number", min: 7, max: 21, step: 1, default: 14 },
    { key: "rsiBuy", label: "RSI Buy Threshold", type: "number", min: 30, max: 90, step: 1, default: 52 },
    { key: "rsiSell", label: "RSI Sell Threshold", type: "number", min: 10, max: 70, step: 1, default: 48 },
    { key: "rr", label: "Risk / Reward", type: "number", min: 0.5, max: 5, step: 0.1, default: 1.3 },
  ],
  scalping_hwr: [
    { key: "rsiPeriod", label: "RSI Period", type: "number", min: 7, max: 21, step: 1, default: 14 },
    { key: "overbought", label: "Overbought", type: "number", min: 55, max: 90, step: 1, default: 70 },
    { key: "oversold", label: "Oversold", type: "number", min: 10, max: 45, step: 1, default: 30 },
    { key: "atrPeriod", label: "ATR Period", type: "number", min: 7, max: 30, step: 1, default: 14 },
    { key: "minAtr", label: "Min ATR", type: "number", min: 0, max: 100, step: 0.01, default: 0 },
    { key: "rr", label: "Risk / Reward", type: "number", min: 0.5, max: 3, step: 0.1, default: 1 },
  ],
  trend_pullback: [
    { key: "emaPeriod", label: "EMA Period", type: "number", min: 20, max: 200, step: 1, default: 100 },
    { key: "rsiPeriod", label: "RSI Period", type: "number", min: 7, max: 21, step: 1, default: 14 },
    { key: "pullbackBuy", label: "Pullback Buy Threshold", type: "number", min: 30, max: 55, step: 1, default: 45 },
    { key: "pullbackSell", label: "Pullback Sell Threshold", type: "number", min: 45, max: 70, step: 1, default: 55 },
    { key: "rr", label: "Risk / Reward", type: "number", min: 0.5, max: 5, step: 0.1, default: 1.4 },
  ],
  range_mean_reversion: [
    { key: "session", label: "Session", type: "select", options: ["asia", "london", "ny"], default: "london" },
    { key: "lookback", label: "Lookback (candles)", type: "number", min: 30, max: 400, step: 1, default: 120 },
    { key: "rsiPeriod", label: "RSI Period", type: "number", min: 7, max: 21, step: 1, default: 14 },
    { key: "rr", label: "Risk / Reward", type: "number", min: 0.5, max: 3, step: 0.1, default: 1 },
  ],
  // If you have other strategies (supplyDemandSweep, etc.) add descriptors here.
};

export function getEditableFields(strategyId: string): FieldDescriptor[] {
  return STRATEGY_SETTINGS[strategyId] ?? [];
}

/**
 * Helper to build defaults for a strategy.
 * Note: execution defaults are provided separately in EXECUTION_FIELDS.
 */
export function getDefaultParams(strategyId: string): Record<string, any> {
  const fields = getEditableFields(strategyId);
  const out: Record<string, any> = {};
  for (const f of fields) out[f.key] = f.default;
  return out;
}