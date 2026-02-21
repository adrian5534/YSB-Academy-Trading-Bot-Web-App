import { z } from "zod";
import type { StrategyModule } from "./types";
import { aroon } from "../indicators/advanced";

interface AroonTrendCandle {
  h: number;
  l: number;
  c: number;
}

interface AroonTrendParams {
  period: number;
}

interface AroonValue {
  up: number;
  down: number;
}

interface AroonTrendSignal {
  side: "buy" | "sell" | null;
  entry?: number;
  confidence: number;
  reason: string;
}

const aroonTrendParamsSchema = z.object({
  period: z.number().min(10).max(50).default(25),
});

export const aroonTrend: StrategyModule = {
  id: "aroon_trend",
  name: "Aroon Trend Continuation",
  description: "Trades strong directional moves.",
  params: aroonTrendParamsSchema,
  defaultParams: { period: 25 },

  generateSignal(
    candles: AroonTrendCandle[],
    _ctx: unknown,
    params: unknown
  ): AroonTrendSignal {
    const p: AroonTrendParams = aroonTrendParamsSchema.parse(params);

    const highs: number[] = candles.map((c: AroonTrendCandle) => c.h);
    const lows: number[] = candles.map((c: AroonTrendCandle) => c.l);

    const a: AroonValue | null = aroon(highs, lows, p.period) as AroonValue | null;
    if (!a) return { side: null, confidence: 0, reason: "not ready" };

    const last: AroonTrendCandle | undefined = candles[candles.length - 1];
    if (!last) return { side: null, confidence: 0, reason: "not ready" };

    if (a.up > 80 && a.down < 20) {
      return {
        side: "buy",
        entry: last.c,
        confidence: 0.82,
        reason: "strong uptrend",
      };
    }

    if (a.down > 80 && a.up < 20) {
      return {
        side: "sell",
        entry: last.c,
        confidence: 0.82,
        reason: "strong downtrend",
      };
    }

    return { side: null, confidence: 0.2, reason: "no trend" };
  },
};

//ticks chart strategy for ticks 