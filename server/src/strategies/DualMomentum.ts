import { z } from "zod";
import type { StrategyModule } from "./types";
import { roc } from "../indicators/advanced";
import { rsi } from "../indicators/basic";

interface DualMomentumCandle {
    c: number;
}

interface DualMomentumContext {}

type DualMomentumSide = "buy" | "sell";

interface DualMomentumNoSignal {
    side: null;
    confidence: number;
    reason: string;
}

interface DualMomentumTradeSignal {
    side: DualMomentumSide;
    entry: number;
    confidence: number;
    reason: string;
}

type DualMomentumSignal = DualMomentumNoSignal | DualMomentumTradeSignal;

export const dualMomentum: StrategyModule = {
  id: "dual_momentum",
  name: "Dual Momentum",
  description: "Trades when RSI and ROC align.",
  params: z.object({}),
  defaultParams: {},

  generateSignal(candles: DualMomentumCandle[], _ctx: DualMomentumContext): DualMomentumSignal {
    const closes = candles.map((c: DualMomentumCandle) => c.c);

    const r = rsi(closes);
    const m = roc(closes);

    if (r == null || m == null)
        return { side: null, confidence: 0, reason: "not ready" };

    const last = candles[candles.length - 1];

    if (r > 55 && m > 0)
        return { side: "buy", entry: last.c, confidence: 0.84, reason: "bullish alignment" };

    if (r < 45 && m < 0)
        return { side: "sell", entry: last.c, confidence: 0.84, reason: "bearish alignment" };

    return { side: null, confidence: 0.2, reason: "no alignment" };
  },
};

//ticks strategy