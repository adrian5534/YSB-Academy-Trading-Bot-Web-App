import { z } from "zod";
import type { StrategyModule } from "./types";
import { macd } from "../indicators/basic";

interface MacdFlipCandle {
    c: number;
}

interface MacdFlipContext {}

interface MacdFlipSignal {
    side: "buy" | "sell" | null;
    entry?: number;
    confidence: number;
    reason: string;
}

export const macdFlip: StrategyModule = {
  id: "macd_flip",
  name: "MACD Histogram Flip",
  description: "Trades when momentum changes direction.",
  params: z.object({}),
  defaultParams: {},

generateSignal(candles: MacdFlipCandle[], _ctx: MacdFlipContext): MacdFlipSignal {
    const closes = candles.map(c => c.c);

    const m = macd(closes);
    if (!m) return { side: null, confidence: 0, reason: "not ready" };

    const last = candles[candles.length - 1];

    if (m.hist > 0) return { side: "buy", entry: last.c, confidence: 0.8, reason: "bullish flip" };
    if (m.hist < 0) return { side: "sell", entry: last.c, confidence: 0.8, reason: "bearish flip" };

    return { side: null, confidence: 0.2, reason: "neutral" };
},
};
//ticks chart strategy for ticks