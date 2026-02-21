import { z } from "zod";
import type { StrategyModule } from "./types";
import { dpo } from "../indicators/advanced";

interface DpoCycleCandle {
  c: number;
}

type DpoCycleSignal =
  | { side: "buy"; entry: number; confidence: number; reason: string }
  | { side: "sell"; entry: number; confidence: number; reason: string }
  | { side: null; confidence: number; reason: string };

const paramsSchema = z.object({
  period: z.number().int().positive().default(20),
});

const DPOCycleReversal: StrategyModule = {
  id: "dpo_cycle_reversal",
  name: "DPO Cycle Reversal",
  params: paramsSchema,
  defaultParams: { period: 20 },

  generateSignal(candles: DpoCycleCandle[], _ctx: unknown, params: unknown): DpoCycleSignal {
    const p = paramsSchema.parse(params);
    const closes: number[] = candles.map((c) => c.c);

    const d: number | null = dpo(closes, p.period);
    if (d == null) return { side: null, confidence: 0, reason: "not ready" };

    const last: DpoCycleCandle = candles[candles.length - 1];

    if (d < 0) {
      return {
        side: "buy",
        entry: last.c,
        confidence: 0.8,
        reason: "cycle low",
      };
    }

    if (d > 0) {
      return {
        side: "sell",
        entry: last.c,
        confidence: 0.8,
        reason: "cycle high",
      };
    }

    return { side: null, confidence: 0.2, reason: "neutral" };
  },
};

export default DPOCycleReversal;