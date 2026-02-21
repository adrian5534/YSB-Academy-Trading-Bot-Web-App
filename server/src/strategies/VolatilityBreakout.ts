import { z } from "zod";
import type { StrategyModule } from "./types";
import { bollinger } from "../indicators/advanced";

export const volatilityBreak: StrategyModule = {
  id: "vol_break",
  name: "Volatility Breakout",
  description: "Trades breakouts after compression.",
  params: z.object({
    period: z.number().min(10).max(50).default(20),
  }),
  defaultParams: { period: 20 },

  generateSignal(candles, _ctx, params) {
    const p = this.params.parse(params);
    const closes = candles.map(c => c.c);

    const b = bollinger(closes, p.period);
    if (!b) return { side: null, confidence: 0, reason: "not ready" };

    const width = b.upper - b.lower;
    const last = candles[candles.length - 1];

    if (width < last.c * 0.001) {
      // compressed
      if (last.c > b.mid) return { side: "buy", entry: last.c, confidence: 0.82, reason: "compression breakout up" };
      if (last.c < b.mid) return { side: "sell", entry: last.c, confidence: 0.82, reason: "compression breakout down" };
    }

    return { side: null, confidence: 0.2, reason: "no compression" };
  },
};

//ticks chart strategy for ticks