import { candlePattern } from "./candlePattern";
import { oneHourTrend } from "./oneHourTrend";
import { trendConfirmation } from "./trendConfirmation";
import { scalpingHwr } from "./scalpingHwr";
import { trendPullback } from "./trendPullback";
import { supplyDemandSweep } from "./supplyDemandSweep";
import { fvgRetracement } from "./fvgRetracement";
import { rangeMeanReversion } from "./rangeMeanReversion";
import type { StrategyModule } from "./types";

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

export function getStrategy(id: string) {
  const s = strategies.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown strategy: ${id}`);
  return s;
}
