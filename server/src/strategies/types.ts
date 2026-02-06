import { z } from "zod";
import type { StrategyId, Timeframe } from "@ysb/shared/types";

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

export type ParamDef =
  | {
      key: string;
      label: string;
      type: "number";
      default: number;
      min?: number;
      max?: number;
      step?: number;
      help?: string;
    }
  | {
      key: string;
      label: string;
      type: "select";
      default: string;
      options: { value: string; label: string }[];
      help?: string;
    }
  | {
      key: string;
      label: string;
      type: "boolean";
      default: boolean;
      help?: string;
    };

export type StrategyCatalogEntry = {
  id: string;
  name: string;
  description?: string;
  // Parameters this strategy exposes for configuration in the UI
  params: ParamDef[];
  // optional schema to validate params on the server (used when starting the bot)
  schema?: z.ZodTypeAny;
};
