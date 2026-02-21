import { z } from "zod";
import type { StrategyModule } from "./types";
import { roc } from "../indicators/advanced";

export const rocBurst: StrategyModule = {
  id: "roc_burst",
  name: "ROC Momentum Burst",
  description: "Trades explosive short-term momentum.",
  params: z.object({
    period: z.number().min(2).max(10).default(3),
    threshold: z.number().min(0.01).max(5).default(0.2),
  }),
  defaultParams: { period: 3, threshold: 0.2 },

generateSignal(
    candles: Array<{ c: number }>,
    _ctx: unknown,
    params: unknown
):
    | { side: "buy"; entry: number; confidence: number; reason: string }
    | { side: "sell"; entry: number; confidence: number; reason: string }
    | { side: null; confidence: number; reason: string } {
    const p: { period: number; threshold: number } = this.params.parse(params);
    const closes: number[] = candles.map((c: { c: number }) => c.c);

    const r: number | null = roc(closes, p.period);
    if (r == null) return { side: null, confidence: 0, reason: "not ready" };

    const last: { c: number } = candles[candles.length - 1];

    if (r > p.threshold) {
        return {
            side: "buy",
            entry: last.c,
            confidence: 0.85,
            reason: "bullish burst",
        };
    }

    if (r < -p.threshold) {
        return {
            side: "sell",
            entry: last.c,
            confidence: 0.85,
            reason: "bearish burst",
        };
    }

    return { side: null, confidence: 0.2, reason: "weak momentum" };
},
};

//ticks chart strategy for ticks