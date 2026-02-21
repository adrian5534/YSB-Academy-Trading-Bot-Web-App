import { z } from "zod";
import type { StrategyModule } from "./types";
import { rsi } from "../indicators/basic";
import { bollinger } from "../indicators/advanced";

interface Candle {
    c: number;
}

interface BollingerBands {
    lower: number;
    upper: number;
}

type StrategySide = "buy" | "sell" | null;

interface SignalBase {
    side: StrategySide;
    confidence: number;
    reason: string;
}

interface SignalWithEntry extends SignalBase {
    side: Exclude<StrategySide, null>;
    entry: number;
}

interface SignalNoEntry extends SignalBase {
    side: null;
    entry?: never;
}

type StrategySignal = SignalWithEntry | SignalNoEntry;

export const confluenceReversal: StrategyModule = {
  id: "confluence_reversal",
  name: "Confluence Reversal",
  description: "Trades only when multiple extremes align.",
  params: z.object({
    rsiPeriod: z.number().min(7).max(21).default(14),
    bbPeriod: z.number().min(10).max(50).default(20),
  }),
  defaultParams: { rsiPeriod: 14, bbPeriod: 20 },

generateSignal(candles: Candle[], _ctx: unknown, params: unknown): StrategySignal {
    const p: { rsiPeriod: number; bbPeriod: number } = this.params.parse(params);

    const closes: number[] = candles.map(c => c.c);

    const r: number | null = rsi(closes, p.rsiPeriod);
    const b: BollingerBands | null | undefined = bollinger(closes, p.bbPeriod);

    if (r == null || !b)
        return { side: null, confidence: 0, reason: "not ready" };

    const last: Candle = candles[candles.length - 1];

    // BUY
    if (r < 30 && last.c <= b.lower) {
        return {
            side: "buy",
            entry: last.c,
            confidence: 0.9,
            reason: "dual oversold",
        };
    }

    // SELL
    if (r > 70 && last.c >= b.upper) {
        return {
            side: "sell",
            entry: last.c,
            confidence: 0.9,
            reason: "dual overbought",
        };
    }

    return { side: null, confidence: 0.2, reason: "no confluence" };
},
};

//ticks chart strategy for ticks