export type TradingMode = "backtest" | "paper" | "live";
export type AccountType = "deriv" | "mt5";
export type BotState = "stopped" | "running";

export type Timeframe =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "1d";

export type StrategyId =
  | "candle_pattern"
  | "one_hour_trend"
  | "trend_confirmation"
  | "scalping_hwr"
  | "trend_pullback"
  | "supply_demand_sweep"
  | "fvg_retracement"
  | "range_mean_reversion";
