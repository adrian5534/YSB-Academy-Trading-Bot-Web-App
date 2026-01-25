import { z } from "zod";
import type { StrategyModule } from "./types";

function recentHigh(candles: any[], lookback: number) {
  return Math.max(...candles.slice(-lookback).map((c) => c.h));
}
function recentLow(candles: any[], lookback: number) {
  return Math.min(...candles.slice(-lookback).map((c) => c.l));
}

export const supplyDemandSweep: StrategyModule = {
  id: "supply_demand_sweep",
  name: "Supply & Demand + Liquidity Sweep",
  description: "Detects sweep beyond recent high/low then reversal entry.",
  params: z.object({
    lookback: z.number().min(20).max(500).default(80),
    sweepPct: z.number().min(0.0001).max(0.05).default(0.002),
    rr: z.number().min(0.5).max(5).default(1.2),
  }),
  defaultParams: { lookback: 80, sweepPct: 0.002, rr: 1.2 },
  generateSignal(candles, _ctx, params) {
    const p = this.params.parse(params);
    if (candles.length < p.lookback + 2) return { side: null, confidence: 0, reason: "not enough candles" };
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const hi = recentHigh(candles.slice(0, -1), p.lookback);
    const lo = recentLow(candles.slice(0, -1), p.lookback);

    // sweep above high then close lower
    if (last.h > hi * (1 + p.sweepPct) && last.c < prev.c) {
      const entry = last.c;
      const sl = last.h;
      const tp = entry - (sl - entry) * p.rr;
      return { side: "sell", entry, sl, tp, confidence: 0.6, reason: "sweep high reversal" };
    }

    // sweep below low then close higher
    if (last.l < lo * (1 - p.sweepPct) && last.c > prev.c) {
      const entry = last.c;
      const sl = last.l;
      const tp = entry + (entry - sl) * p.rr;
      return { side: "buy", entry, sl, tp, confidence: 0.6, reason: "sweep low reversal" };
    }

    return { side: null, confidence: 0.2, reason: "no sweep" };
  },
};
