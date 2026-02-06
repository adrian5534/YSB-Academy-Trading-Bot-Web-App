import { z } from "zod";
import type { Candle, StrategyModule, StrategyCatalogEntry } from "./types";

const rsiSchema = z.object({
  rsiPeriod: z.number().int().min(2).max(100).default(8),
  overbought: z.number().min(50).max(100).default(70),
  oversold: z.number().min(0).max(50).default(30),
});
const defaults = { rsiPeriod: 8, overbought: 70, oversold: 30 };

function computeRSI(candles: Candle[], period: number): number | null {
  const closes = candles.map((c) => c.c);
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export const rsi: StrategyModule = {
  id: "rsi",
  name: "RSI",
  description: "Buy when RSI is oversold, sell when overbought.",
  params: rsiSchema,
  defaultParams: defaults,
generateSignal(
    candles: Candle[],
    _ctx: unknown,
    params: Partial<z.infer<typeof rsiSchema>>
): {
    side: "buy" | "sell" | null;
    entry?: number;
    confidence: number;
    reason: string;
} {
    const p = rsiSchema.parse({ ...defaults, ...params });
    const val = computeRSI(candles, p.rsiPeriod);
    if (val == null) return { side: null, confidence: 0, reason: "not-enough-data" };
    if (val <= p.oversold) {
        const conf = Math.min(1, (p.oversold - val) / 50);
        return { side: "buy", entry: candles.at(-1)!.c, confidence: conf, reason: `RSI ${val.toFixed(1)} <= ${p.oversold}` };
    }
    if (val >= p.overbought) {
        const conf = Math.min(1, (val - p.overbought) / 50);
        return { side: "sell", entry: candles.at(-1)!.c, confidence: conf, reason: `RSI ${val.toFixed(1)} >= ${p.overbought}` };
    }
    return { side: null, confidence: 0, reason: `RSI ${val.toFixed(1)} neutral` };
},
};

export const RSI_STRATEGY: StrategyCatalogEntry = {
  id: "rsi",
  name: "RSI",
  description: "Relative Strength Index overbought/oversold entries.",
  params: [
    { key: "rsiPeriod", label: "RSI Period", type: "number", default: 8, min: 2, max: 100, step: 1 },
    { key: "overbought", label: "Overbought", type: "number", default: 70, min: 50, max: 100, step: 1 },
    { key: "oversold", label: "Oversold", type: "number", default: 30, min: 0, max: 50, step: 1 },
  ],
  schema: rsiSchema,
};