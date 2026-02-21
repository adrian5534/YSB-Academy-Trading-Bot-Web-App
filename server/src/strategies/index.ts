import { candlePattern } from "./candlePattern";
import { oneHourTrend } from "./oneHourTrend";
import { trendConfirmation } from "./trendConfirmation";
import { scalpingHwr } from "./scalpingHwr";
import { trendPullback } from "./trendPullback";
import { supplyDemandSweep } from "./supplyDemandSweep";
import { fvgRetracement } from "./fvgRetracement";
import { rangeMeanReversion } from "./rangeMeanReversion";
import { volatilityBreakout } from "./VolatilityBreakout";
import { aroonTrendContinuation } from "./aroonTrendContinuation";
import { bollingerSnapreversal } from "./bollingerSnapReversal";
import { confluenceReversal } from "./confluenceReversal";
import { dualMomentum } from "./dualMomentum";
import { macdHistogramFlip } from "./macdHistogramFlip";
import { maMicroPullback } from "./maMicroPullback";
import { rocMomomentumBurst } from "./rocMomentumBurst";
import { stochasticSnap } from "./StochasticSnap";
import type { StrategyModule } from "./types";
import { stochSnap } from "./StochasticSnap.js";
import { stochastic } from "../indicators/advanced.js";

export const strategies: StrategyModule[] = [
  candlePattern,
  oneHourTrend,
  trendConfirmation,
  scalpingHwr,
  trendPullback,
  supplyDemandSweep,
  fvgRetracement,
  rangeMeanReversion,
  volatilityBreakout,
  aroonTrendContinuation,
  bollingerSnapreversal,
  confluenceReversal,
  dualMomentum,
  macdHistogramFlip,
  maMicroPullback,
  rocMomomentumBurst,
  stochasticSnap,
];

export function getStrategy(id: string) {
  const s = strategies.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown strategy: ${id}`);
  return s;
}
