import type { StrategyModule } from "./types";

import { candlePattern } from "./candlePattern";
import { oneHourTrend } from "./oneHourTrend";
import { trendConfirmation } from "./trendConfirmation";
import { scalpingHwr } from "./scalpingHwr";
import { trendPullback } from "./trendPullback";
import { supplyDemandSweep } from "./supplyDemandSweep";
import { fvgRetracement } from "./fvgRetracement";
import { rangeMeanReversion } from "./rangeMeanReversion";
import { volatilityBreak } from "./VolatilityBreakout";
import { aroonTrend } from "./AroonTrendContinuation";
import { bollingerSnap } from "./BollingerSnapReversal";
import { confluenceReversal } from "./ConfluenceReversal";
import { dualMomentum } from "./DualMomentum";
import { macdFlip } from "./MACDHistogramFlip";
import { maPullback } from "./MAMicroPullback";
import { rocBurst } from "./ROCMomentumBurst";
import { stochSnap } from "./StochasticSnap";

export const strategies: StrategyModule[] = [
  candlePattern,
  oneHourTrend,
  trendConfirmation,
  scalpingHwr,
  trendPullback,
  supplyDemandSweep,
  fvgRetracement,
  rangeMeanReversion,
  volatilityBreak,
  aroonTrend,
  bollingerSnap,
  confluenceReversal,
  dualMomentum,
  macdFlip,
  maPullback,
  rocBurst,
  stochSnap,
];

export function getStrategy(id: string) {
  const s = strategies.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown strategy: ${id}`);
  return s;
}
