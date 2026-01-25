import { z } from "zod";
import type { StrategyId, Timeframe } from "../../../shared/types";

export type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number };

export type StrategyContext = {
  symbol: string;
  timeframe: Timeframe;
  now: Date;
};

export type StrategySignal = {
  side: "buy" | "sell" | null;
  entry?: number;
  sl?: number;
  tp?: number;
  confidence: number;
  reason: string;
};

export type StrategyModule = {
  id: StrategyId;
  name: string;
  description: string;
  params: z.ZodTypeAny;
  defaultParams: Record<string, any>;
  generateSignal: (candles: Candle[], ctx: StrategyContext, params: any) => StrategySignal;
};
