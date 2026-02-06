import { z } from "zod";
import type { StrategyCatalogEntry } from "./types";

export const RSI_STRATEGY: StrategyCatalogEntry = {
  id: "rsi",
  name: "RSI",
  description: "Relative Strength Index overbought/oversold entries.",
  params: [
    { key: "rsiPeriod", label: "RSI Period", type: "number", default: 8, min: 2, max: 100, step: 1 },
    { key: "overbought", label: "Overbought", type: "number", default: 70, min: 50, max: 100, step: 1 },
    { key: "oversold", label: "Oversold", type: "number", default: 30, min: 0, max: 50, step: 1 },
  ],
  schema: z.object({
    rsiPeriod: z.number().int().min(2).max(100).default(8),
    overbought: z.number().min(50).max(100).default(70),
    oversold: z.number().min(0).max(50).default(30),
  }),
};