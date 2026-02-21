import { z } from "zod";
import type { StrategyModule } from "./types";
import { sma } from "../indicators/basic";

export const maPullback: StrategyModule = {
  id: "ma_pullback",
  name: "MA Micro Pullback",
  description: "Continuation trades after tiny retracements.",
  params: z.object({
    period: z.number().min(5).max(50).default(20),
  }),
  defaultParams: { period: 20 },

generateSignal(
    candles: Array<{ c: number }>,
    _ctx: unknown,
    params: unknown
): { side: "buy" | "sell" | null; entry?: number; confidence: number; reason: string } {
    const p: { period: number } = this.params.parse(params);
    const closes: number[] = candles.map((c) => c.c);

    const m: number | null = sma(closes, p.period);
    if (m == null) return { side: null, confidence: 0, reason: "not ready" };

    const last: { c: number } = candles[candles.length - 1];
    const prev: { c: number } = candles[candles.length - 2];

    // Uptrend pullback
    if (prev.c > m && last.c <= m) {
        return { side: "buy", entry: last.c, confidence: 0.83, reason: "pullback in uptrend" };
    }

    // Downtrend pullback
    if (prev.c < m && last.c >= m) {
        return { side: "sell", entry: last.c, confidence: 0.83, reason: "pullback in downtrend" };
    }

    return { side: null, confidence: 0.2, reason: "no pullback" };
},
};

//ticks chart strategy for ticks