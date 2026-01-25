import { z } from "zod";
import type { StrategyModule } from "./types";

export const fvgRetracement: StrategyModule = {
  id: "fvg_retracement",
  name: "Fair Value Gap (FVG) Retracement",
  description: "Simple 3-candle imbalance detection and retracement entry.",
  params: z.object({
    minGapPct: z.number().min(0.0001).max(0.05).default(0.002),
    rr: z.number().min(0.5).max(5).default(1.3),
  }),
  defaultParams: { minGapPct: 0.002, rr: 1.3 },
  generateSignal(candles, _ctx, params) {
    const p = this.params.parse(params);
    if (candles.length < 4) return { side: null, confidence: 0, reason: "not enough candles" };
    const a = candles[candles.length - 3];
    const b = candles[candles.length - 2];
    const c = candles[candles.length - 1];

    const upGap = a.h < c.l && (c.l - a.h) / a.h >= p.minGapPct;
    const dnGap = a.l > c.h && (a.l - c.h) / a.l >= p.minGapPct;

    if (upGap) {
      const entry = (a.h + c.l) / 2;
      const sl = a.h;
      const tp = entry + (entry - sl) * p.rr;
      return { side: "buy", entry, sl, tp, confidence: 0.55, reason: "bullish fvg" };
    }
    if (dnGap) {
      const entry = (c.h + a.l) / 2;
      const sl = a.l;
      const tp = entry - (sl - entry) * p.rr;
      return { side: "sell", entry, sl, tp, confidence: 0.55, reason: "bearish fvg" };
    }
    return { side: null, confidence: 0.2, reason: "no fvg" };
  },
};
