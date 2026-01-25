import { z } from "zod";
import type { StrategyModule } from "./types";
import { rsi, atr } from "../indicators/basic";

export const scalpingHwr: StrategyModule = {
  id: "scalping_hwr",
  name: "High-Win-Rate Scalping",
  description: "Mean reversion using RSI extremes + ATR volatility gate.",
  params: z.object({
    rsiPeriod: z.number().min(7).max(21).default(14),
    overbought: z.number().min(55).max(90).default(70),
    oversold: z.number().min(10).max(45).default(30),
    atrPeriod: z.number().min(7).max(30).default(14),
    minAtr: z.number().min(0).max(100).default(0),
    rr: z.number().min(0.5).max(3).default(1),
  }),
  defaultParams: { rsiPeriod: 14, overbought: 70, oversold: 30, atrPeriod: 14, minAtr: 0, rr: 1 },
  generateSignal(candles, _ctx, params) {
    const p = this.params.parse(params);
    const closes = candles.map((c) => c.c);
    const highs = candles.map((c) => c.h);
    const lows = candles.map((c) => c.l);
    const r = rsi(closes, p.rsiPeriod);
    const a = atr(highs, lows, closes, p.atrPeriod);
    if (r == null || a == null) return { side: null, confidence: 0, reason: "indicators not ready" };
    if (a < p.minAtr) return { side: null, confidence: 0.1, reason: "low volatility" };

    const last = candles[candles.length - 1];
    const range = Math.max(1e-6, last.h - last.l);

    if (r <= p.oversold) {
      const entry = last.c;
      const sl = entry - range * 1.0;
      const tp = entry + (entry - sl) * p.rr;
      return { side: "buy", entry, sl, tp, confidence: 0.6, reason: "rsi oversold" };
    }
    if (r >= p.overbought) {
      const entry = last.c;
      const sl = entry + range * 1.0;
      const tp = entry - (sl - entry) * p.rr;
      return { side: "sell", entry, sl, tp, confidence: 0.6, reason: "rsi overbought" };
    }
    return { side: null, confidence: 0.2, reason: "neutral" };
  },
};
