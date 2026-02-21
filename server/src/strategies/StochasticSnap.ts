import { z } from "zod";
import type { StrategyModule } from "./types";
import { stochastic } from "../indicators/advanced";

export const stochSnap: StrategyModule = {
  id: "stoch_snap",
  name: "Stochastic Snap",
  description: "Trades sharp overbought/oversold reversals.",
  params: z.object({
    period: z.number().min(5).max(30).default(14),
  }),
  defaultParams: { period: 14 },

generateSignal(
    candles: Array<{ h: number; l: number; c: number }>,
    _ctx: unknown,
    params: unknown
): { side: "buy" | "sell" | null; entry?: number; confidence: number; reason: string } {
    const p: { period: number } = this.params.parse(params);

    const highs: number[] = candles.map((c: { h: number; l: number; c: number }) => c.h);
    const lows: number[] = candles.map((c: { h: number; l: number; c: number }) => c.l);
    const closes: number[] = candles.map((c: { h: number; l: number; c: number }) => c.c);

    const s: number | null = stochastic(highs, lows, closes, p.period);
    if (s == null) return { side: null, confidence: 0, reason: "not ready" };

    const last: { h: number; l: number; c: number } = candles[candles.length - 1];

    if (s < 15) return { side: "buy", entry: last.c, confidence: 0.86, reason: "oversold snap" };
    if (s > 85) return { side: "sell", entry: last.c, confidence: 0.86, reason: "overbought snap" };

    return { side: null, confidence: 0.2, reason: "neutral" };
},
};

//ticks chart strategy for ticks