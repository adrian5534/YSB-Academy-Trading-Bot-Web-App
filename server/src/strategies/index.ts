import { candlePattern } from "./candlePattern";
import { oneHourTrend } from "./oneHourTrend";
import { trendConfirmation } from "./trendConfirmation";
import { scalpingHwr } from "./scalpingHwr";
import { trendPullback } from "./trendPullback";
import { supplyDemandSweep } from "./supplyDemandSweep";
import { fvgRetracement } from "./fvgRetracement";
import { rangeMeanReversion } from "./rangeMeanReversion";
import type { StrategyModule, StrategyCatalogEntry } from "./types";
import { RSI_STRATEGY } from "./rsi";

export const strategies: StrategyModule[] = [
  candlePattern,
  oneHourTrend,
  trendConfirmation,
  scalpingHwr,
  trendPullback,
  supplyDemandSweep,
  fvgRetracement,
  rangeMeanReversion,
];

// Expand this list as you add new strategy files. The non-RSI entries below
// advertise no custom params (UI will still show generic Stake/Duration).
export const STRATEGY_CATALOG: StrategyCatalogEntry[] = [
  { id: "candle_pattern", name: "Candle Pattern", params: [] },
  { id: "one_hour_trend", name: "One Hour Trend", params: [] },
  { id: "trend_confirmation", name: "Trend Confirmation", params: [] },
  { id: "scalping_hwr", name: "Scalping HWR", params: [] },
  { id: "trend_pullback", name: "Trend Pullback", params: [] },
  { id: "supply_demand_sweep", name: "Supply/Demand Sweep", params: [] },
  { id: "fvg_retracement", name: "FVG Retracement", params: [] },
  { id: "range_mean_reversion", name: "Range Mean Reversion", params: [] },
  RSI_STRATEGY,
];

export function getStrategy(id: string) {
  const s = strategies.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown strategy: ${id}`);
  return s;
}

// Helper to fetch a strategy entry by id
export const getStrategyMeta = (id: string) => STRATEGY_CATALOG.find((s) => s.id === id) ?? null;
