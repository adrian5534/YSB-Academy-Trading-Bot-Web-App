import { z } from "zod";
import type { StrategyModule } from "./types";
import { bollinger } from "../indicators/advanced";

export const bollingerSnap: StrategyModule = {
  id: "bollinger_snap",
  name: "Bollinger Snap Reversal",
  description: "Trades snapbacks from extreme volatility bands.",
  params: z.object({
    period: z.number().min(10).max(50).default(20),
    mult: z.number().min(1).max(3).default(2),
  }),
  defaultParams: { period: 20, mult: 2 },

generateSignal(
    candles: Array<{ c: number }>,
    _ctx: unknown,
    params: unknown
): {
    side: "buy" | "sell" | null;
    entry?: number;
    confidence: number;
    reason: string;
} {
    const p: { period: number; mult: number } = this.params.parse(params);
    const closes: number[] = candles.map((c: { c: number }) => c.c);

    const b: { lower: number; upper: number } | null = bollinger(
        closes,
        p.period,
        p.mult
    );
    if (!b) return { side: null, confidence: 0, reason: "not ready" };

    const last: { c: number } = candles[candles.length - 1];

    if (last.c <= b.lower) {
        return {
            side: "buy",
            entry: last.c,
            confidence: 0.88,
            reason: "lower band snap",
        };
    }

    if (last.c >= b.upper) {
        return {
            side: "sell",
            entry: last.c,
            confidence: 0.88,
            reason: "upper band snap",
        };
    }

    return { side: null, confidence: 0.2, reason: "inside bands" };
},
};

//ticks chart strategy for ticks