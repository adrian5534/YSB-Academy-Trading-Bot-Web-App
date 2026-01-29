import Papa from "papaparse";
import { v4 as uuidv4 } from "uuid";
import { getStrategy } from "../strategies";
import type { Candle } from "../strategies/types";

type Row = { timestamp: string; open: string; high: string; low: string; close: string; volume?: string };

export function parseCsv(csv: string): Candle[] {
  const parsed = Papa.parse<Row>(csv.trim(), { header: true, skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(parsed.errors[0].message);
  return (parsed.data ?? []).map((r) => ({
    t: Number(r.timestamp),
    o: Number(r.open),
    h: Number(r.high),
    l: Number(r.low),
    c: Number(r.close),
    v: r.volume ? Number(r.volume) : undefined,
  }));
}

export async function runBacktest(
  args: {
    userId: string;
    symbol: string;
    timeframe: string;
    strategyId: string;
    params: any;
    candles: Candle[];
  },
  onLog?: (msg: { message: string; ts?: string; meta?: any }) => void | Promise<void>,
) {
  const strat = getStrategy(args.strategyId);
  const trades: any[] = [];
  let equity = 0;
  let peak = 0;
  let maxDd = 0;

  const emit = (message: string, meta: any = {}) => {
    try {
      onLog?.({ message, ts: new Date().toISOString(), meta });
    } catch {
      /* swallow logging errors */
    }
  };

  emit(`backtest started for ${args.symbol} ${args.timeframe} — ${args.candles.length} candles`);

  // main backtest loop
  for (let i = 30; i < args.candles.length; i++) {
    // periodic progress
    if (i % 100 === 0) emit(`processed ${i}/${args.candles.length} candles`, { processed: i });

    const slice = args.candles.slice(0, i + 1);
    const sig = strat.generateSignal(
      slice,
      { symbol: args.symbol, timeframe: args.timeframe as any, now: new Date(slice[i].t * 1000) },
      args.params,
    );

    if (!sig.side || sig.confidence < 0.5) continue;

    const entry = sig.entry ?? slice[i].c;
    const sl = sig.sl ?? (sig.side === "buy" ? entry * 0.99 : entry * 1.01);
    const tp = sig.tp ?? (sig.side === "buy" ? entry * 1.01 : entry * 0.99);

    // simulate next few candles hit
    let exit = slice[i].c;
    for (let j = i + 1; j < Math.min(args.candles.length, i + 10); j++) {
      const c = args.candles[j];
      if (sig.side === "buy") {
        if (c.l <= sl) {
          exit = sl;
          break;
        }
        if (c.h >= tp) {
          exit = tp;
          break;
        }
      } else {
        if (c.h >= sl) {
          exit = sl;
          break;
        }
        if (c.l <= tp) {
          exit = tp;
          break;
        }
      }
      exit = c.c;
    }

    const profit = sig.side === "buy" ? exit - entry : entry - exit;
    equity += profit;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);

    const trade = {
      id: uuidv4(),
      user_id: args.userId,
      account_id: uuidv4(),
      mode: "backtest",
      symbol: args.symbol,
      strategy_id: args.strategyId,
      timeframe: args.timeframe,
      side: sig.side,
      entry,
      sl,
      tp,
      exit,
      profit,
      opened_at: new Date(slice[i].t * 1000).toISOString(),
      closed_at: new Date(slice[Math.min(args.candles.length - 1, i + 1)].t * 1000).toISOString(),
      meta: { confidence: sig.confidence, reason: sig.reason },
    };

    trades.push(trade);
    emit(`trade ${trades.length} -> ${sig.side} ${profit.toFixed(6)}`, { trade });
  }

  const wins = trades.filter((t) => (t.profit ?? 0) > 0);
  const losses = trades.filter((t) => (t.profit ?? 0) <= 0);
  const grossWin = wins.reduce((s, t) => s + (t.profit ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.profit ?? 0), 0));
  const profitFactor = grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss;
  const expectancy = trades.length ? equity / trades.length : 0;
  const winRate = trades.length ? wins.length / trades.length : 0;

  const result = {
    trades,
    metrics: {
      trades: trades.length,
      win_rate: winRate,
      profit_factor: profitFactor,
      expectancy,
      max_drawdown: maxDd,
      pnl: equity,
    },
  };

  emit(`backtest complete — ${trades.length} trades, pnl=${equity.toFixed(6)}`, { metrics: result.metrics });
  return result;
}