import { z } from "zod";
import type { StrategyModule } from "./types";

export const candlePattern: StrategyModule = {
  id: "candle_pattern",
  name: "Simple Candle Pattern Strategy",
  description: "Engulfing + reversal candles with basic SL/TP.",
  params: z.object({
    riskReward: z.number().min(0.5).max(5).default(1.5),
    lookback: z.number().min(20).max(300).default(60),
  }),
  defaultParams: { riskReward: 1.5, lookback: 60 },
  generateSignal(candles, _ctx, params) {
    const p = this.params.parse(params);
    if (candles.length < 3) return { side: null, confidence: 0, reason: "not enough candles" };
    const a = candles[candles.length - 2];
    const b = candles[candles.length - 1];

    const bullishEngulf = b.c > b.o && a.c < a.o && b.c >= a.o && b.o <= a.c;
    const bearishEngulf = b.c < b.o && a.c > a.o && b.o >= a.c && b.c <= a.o;

    const range = Math.max(1e-6, b.h - b.l);
    if (bullishEngulf) {
      const entry = b.c;
      const sl = b.l - range * 0.1;
      const tp = entry + (entry - sl) * p.riskReward;
      return { side: "buy", entry, sl, tp, confidence: 0.62, reason: "bullish engulfing" };
    }
    if (bearishEngulf) {
      const entry = b.c;
      const sl = b.h + range * 0.1;
      const tp = entry - (sl - entry) * p.riskReward;
      return { side: "sell", entry, sl, tp, confidence: 0.62, reason: "bearish engulfing" };
    }
    return { side: null, confidence: 0.1, reason: "no pattern" };
  },
};
