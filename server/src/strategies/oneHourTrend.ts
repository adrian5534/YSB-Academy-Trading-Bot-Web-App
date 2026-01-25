import { z } from "zod";
import type { StrategyModule } from "./types";
import { ema } from "../indicators/basic";

export const oneHourTrend: StrategyModule = {
  id: "one_hour_trend",
  name: "One-Hour Trend Strategy",
  description: "Trades only within a specified hourly window; uses EMA slope.",
  params: z.object({
    startHourUtc: z.number().int().min(0).max(23).default(8),
    endHourUtc: z.number().int().min(0).max(23).default(17),
    emaPeriod: z.number().min(10).max(200).default(50),
    minSlope: z.number().min(0).max(2).default(0.02),
  }),
  defaultParams: { startHourUtc: 8, endHourUtc: 17, emaPeriod: 50, minSlope: 0.02 },
  generateSignal(candles, ctx, params) {
    const p = this.params.parse(params);
    const h = ctx.now.getUTCHours();
    if (!(h >= p.startHourUtc && h <= p.endHourUtc)) return { side: null, confidence: 0, reason: "outside session" };
    const closes = candles.map((c) => c.c);
    const e = ema(closes, p.emaPeriod);
    if (e == null) return { side: null, confidence: 0, reason: "ema not ready" };
    const prev = ema(closes.slice(0, -1), p.emaPeriod);
    if (prev == null) return { side: null, confidence: 0, reason: "ema not ready" };
    const slope = e - prev;
    if (Math.abs(slope) < p.minSlope) return { side: null, confidence: 0.2, reason: "flat trend" };
    const last = candles[candles.length - 1].c;
    const side = slope > 0 ? "buy" : "sell";
    const sl = side === "buy" ? last * 0.995 : last * 1.005;
    const tp = side === "buy" ? last * 1.01 : last * 0.99;
    return { side, entry: last, sl, tp, confidence: 0.55, reason: "ema slope trend" };
  },
};
