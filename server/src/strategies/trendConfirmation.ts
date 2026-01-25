import { z } from "zod";
import type { StrategyModule } from "./types";
import { ema, rsi, macd } from "../indicators/basic";

export const trendConfirmation: StrategyModule = {
  id: "trend_confirmation",
  name: "Trend + Confirmation",
  description: "EMA 50/200 trend + RSI + MACD confirmation.",
  params: z.object({
    emaFast: z.number().min(10).max(100).default(50),
    emaSlow: z.number().min(50).max(400).default(200),
    rsiPeriod: z.number().min(7).max(21).default(14),
    rsiBuy: z.number().min(45).max(70).default(52),
    rsiSell: z.number().min(30).max(55).default(48),
    rr: z.number().min(0.5).max(5).default(1.3),
  }),
  defaultParams: { emaFast: 50, emaSlow: 200, rsiPeriod: 14, rsiBuy: 52, rsiSell: 48, rr: 1.3 },
  generateSignal(candles, _ctx, params) {
    const p = this.params.parse(params);
    const closes = candles.map((c) => c.c);
    const eFast = ema(closes, p.emaFast);
    const eSlow = ema(closes, p.emaSlow);
    const r = rsi(closes, p.rsiPeriod);
    const m = macd(closes);
    if (eFast == null || eSlow == null || r == null || m == null) return { side: null, confidence: 0, reason: "indicators not ready" };

    const trendUp = eFast > eSlow;
    const trendDown = eFast < eSlow;

    const last = candles[candles.length - 1];
    const range = Math.max(1e-6, last.h - last.l);

    if (trendUp && r >= p.rsiBuy && m.hist > 0) {
      const entry = last.c;
      const sl = entry - range * 1.2;
      const tp = entry + (entry - sl) * p.rr;
      return { side: "buy", entry, sl, tp, confidence: 0.68, reason: "trend up + rsi + macd" };
    }

    if (trendDown && r <= p.rsiSell && m.hist < 0) {
      const entry = last.c;
      const sl = entry + range * 1.2;
      const tp = entry - (sl - entry) * p.rr;
      return { side: "sell", entry, sl, tp, confidence: 0.68, reason: "trend down + rsi + macd" };
    }

    return { side: null, confidence: 0.2, reason: "no confirmation" };
  },
};
