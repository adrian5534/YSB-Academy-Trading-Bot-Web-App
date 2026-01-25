import { z } from "zod";
import type { StrategyModule } from "./types";
import { rsi } from "../indicators/basic";

function inSession(now: Date, session: "asia" | "london" | "ny") {
  const h = now.getUTCHours();
  if (session === "asia") return h >= 0 && h < 8;
  if (session === "london") return h >= 7 && h < 16;
  return h >= 13 && h < 21;
}

export const rangeMeanReversion: StrategyModule = {
  id: "range_mean_reversion",
  name: "Range Mean Reversion (Session-Based)",
  description: "Find range highs/lows and fade with RSI filter.",
  params: z.object({
    session: z.enum(["asia", "london", "ny"]).default("london"),
    lookback: z.number().min(30).max(400).default(120),
    rsiPeriod: z.number().min(7).max(21).default(14),
    rr: z.number().min(0.5).max(3).default(1),
  }),
  defaultParams: { session: "london", lookback: 120, rsiPeriod: 14, rr: 1 },
  generateSignal(candles, ctx, params) {
    const p = this.params.parse(params);
    if (!inSession(ctx.now, p.session)) return { side: null, confidence: 0, reason: "outside session" };
    if (candles.length < p.lookback) return { side: null, confidence: 0, reason: "not enough candles" };
    const window = candles.slice(-p.lookback);
    const hi = Math.max(...window.map((c) => c.h));
    const lo = Math.min(...window.map((c) => c.l));
    const last = candles[candles.length - 1];
    const closes = candles.map((c) => c.c);
    const r = rsi(closes, p.rsiPeriod);
    if (r == null) return { side: null, confidence: 0, reason: "rsi not ready" };

    const range = Math.max(1e-6, hi - lo);
    const nearHigh = (hi - last.c) / range < 0.15;
    const nearLow = (last.c - lo) / range < 0.15;

    if (nearHigh && r > 55) {
      const entry = last.c;
      const sl = hi + range * 0.05;
      const tp = entry - (sl - entry) * p.rr;
      return { side: "sell", entry, sl, tp, confidence: 0.55, reason: "fade range high" };
    }
    if (nearLow && r < 45) {
      const entry = last.c;
      const sl = lo - range * 0.05;
      const tp = entry + (entry - sl) * p.rr;
      return { side: "buy", entry, sl, tp, confidence: 0.55, reason: "fade range low" };
    }
    return { side: null, confidence: 0.2, reason: "no edge" };
  },
};
