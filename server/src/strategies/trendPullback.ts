import { z } from "zod";
import type { StrategyModule } from "./types";
import { ema, rsi } from "../indicators/basic";

export const trendPullback: StrategyModule = {
  id: "trend_pullback",
  name: "Trend Pullback Continuation",
  description: "EMA trend; enter after RSI pullback then resume.",
  params: z.object({
    emaPeriod: z.number().min(20).max(200).default(100),
    rsiPeriod: z.number().min(7).max(21).default(14),
    pullbackBuy: z.number().min(30).max(55).default(45),
    pullbackSell: z.number().min(45).max(70).default(55),
    rr: z.number().min(0.5).max(5).default(1.4),
  }),
  defaultParams: { emaPeriod: 100, rsiPeriod: 14, pullbackBuy: 45, pullbackSell: 55, rr: 1.4 },
  generateSignal(candles, _ctx, params) {
    const p = this.params.parse(params);
    const closes = candles.map((c) => c.c);
    const e = ema(closes, p.emaPeriod);
    const r = rsi(closes, p.rsiPeriod);
    if (e == null || r == null) return { side: null, confidence: 0, reason: "indicators not ready" };

    const last = candles[candles.length - 1];
    const range = Math.max(1e-6, last.h - last.l);

    if (last.c > e && r <= p.pullbackBuy) {
      const entry = last.c;
      const sl = entry - range * 1.3;
      const tp = entry + (entry - sl) * p.rr;
      return { side: "buy", entry, sl, tp, confidence: 0.58, reason: "uptrend pullback" };
    }
    if (last.c < e && r >= p.pullbackSell) {
      const entry = last.c;
      const sl = entry + range * 1.3;
      const tp = entry - (sl - entry) * p.rr;
      return { side: "sell", entry, sl, tp, confidence: 0.58, reason: "downtrend pullback" };
    }
    return { side: null, confidence: 0.2, reason: "no pullback" };
  },
};
