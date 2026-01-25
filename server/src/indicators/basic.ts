export function sma(values: number[], period: number) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}

export function rsi(values: number[], period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function atr(high: number[], low: number[], close: number[], period = 14) {
  if (close.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < close.length; i++) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1]),
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  if (values.length < slow + signal) return null;
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  if (emaFast == null || emaSlow == null) return null;
  const line = emaFast - emaSlow;
  // crude signal line estimation on tail
  const tail = values.slice(-(slow + signal));
  const diffs: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    const ef = ema(tail.slice(0, i + 1), fast);
    const es = ema(tail.slice(0, i + 1), slow);
    if (ef != null && es != null) diffs.push(ef - es);
  }
  const sig = ema(diffs, signal);
  if (sig == null) return null;
  return { macd: line, signal: sig, hist: line - sig };
}
