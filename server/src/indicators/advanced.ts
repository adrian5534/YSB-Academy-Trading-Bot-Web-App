import { sma, ema } from "./basic";


export function roc(values: number[], period = 5) {
  if (values.length < period + 1) return null;

  const prev = values[values.length - period - 1];
  const curr = values[values.length - 1];

  // prevent divide-by-zero / exploding values
  if (!Number.isFinite(prev) || prev === 0) return null;

  return ((curr - prev) / prev) * 100;
}


export function bollinger(values: number[], period = 20, mult = 2) {
  if (values.length < period) return null;

  const slice = values.slice(-period);
  const mean = sma(values, period)!;

  const variance =
    slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;

  const std = Math.sqrt(variance);

  return {
    mid: mean,
    upper: mean + std * mult,
    lower: mean - std * mult,
  };
}

export function dpo(values: number[], period = 20) {
  if (values.length < period) return null;

  const k = Math.floor(period / 2) + 1;
  const smaVal = sma(values, period);
  if (smaVal == null) return null;

  const idx = values.length - k;
  if (idx < 0) return null;

  return values[idx] - smaVal;
}

export function maEnvelope(values: number[], period = 20, percent = 1) {
  const m = sma(values, period);
  if (m == null) return null;

  const p = percent / 100;

  return {
    mid: m,
    upper: m * (1 + p),
    lower: m * (1 - p),
  };
}

export function aroon(highs: number[], lows: number[], period = 25) {
  if (highs.length < period || lows.length < period) return null;

  const hSlice = highs.slice(-period);
  const lSlice = lows.slice(-period);

  const highestIndex = hSlice.lastIndexOf(Math.max(...hSlice));
  const lowestIndex = lSlice.lastIndexOf(Math.min(...lSlice));

  return {
    up: ((period - highestIndex) / period) * 100,
    down: ((period - lowestIndex) / period) * 100,
  };
}


export function stochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
) {
  if (closes.length < period) return null;

  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  const c = closes[closes.length - 1];

  if (h === l) return null;

  return ((c - l) / (h - l)) * 100;
}

