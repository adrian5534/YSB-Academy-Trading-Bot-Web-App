import { sma, ema } from "./basic";


export function roc(values: number[], period = 5) {
  if (values.length < period + 1) return null;
  const prev = values[values.length - period - 1];
  const curr = values[values.length - 1];
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