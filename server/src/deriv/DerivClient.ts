import WebSocket from "ws";
import { env } from "../env";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class DerivClient {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private reqId = 1;
  private isOpen = false;
  private onMessageCallback?: (msg: any) => void;
  private boundOnMessage?: (data: WebSocket.Data) => void;

  constructor(private token?: string, onMessage?: (msg: any) => void) {
    this.onMessageCallback = onMessage;
  }

  async connect(): Promise<void> {
    if (this.isOpen && this.ws) return;

    const appId = String((env as any)?.DERIV_APP_ID ?? 1089);
    const url = `wss://ws.deriv.com/websockets/v3?app_id=${appId}`;
    this.ws = new WebSocket(url);

    if (!this.boundOnMessage) {
      this.boundOnMessage = (data: WebSocket.Data) => {
        try {
          const text = typeof data === "string" ? data : data.toString();
          const msg = JSON.parse(text);
          const id = msg.req_id;
          if (id && this.pending.has(id)) {
            const p = this.pending.get(id)!;
            clearTimeout(p.timer);
            this.pending.delete(id);
            if (msg.error) p.reject(new Error(msg.error.message || "Deriv error"));
            else p.resolve(msg);
          } else {
            try { this.onMessageCallback?.(msg); } catch (cbErr) {
              const e = cbErr as any;
              console.error("[DerivClient] onMessage callback error:", e && (e.stack ?? e.message ?? e));
              try { console.error("[DerivClient] callback message (raw):", JSON.stringify(msg)); } catch {}
            }
          }
        } catch (err) {
          console.error("[DerivClient] message parse error", String(err), "raw:", typeof data === "string" ? data : data.toString());
        }
      };
    }
    this.ws.on("message", this.boundOnMessage);

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.isOpen = true;
        this.ws?.off("error", onErrorOnce);
        resolve();
      };
      const onErrorOnce = (e: any) => {
        this.ws?.off("open", onOpen);
        reject(new Error(String(e?.message ?? e)));
      };
      this.ws!.once("open", onOpen);
      this.ws!.once("error", onErrorOnce);
    });

    if (this.token) await this.send({ authorize: this.token });
  }

  async disconnect(): Promise<void> {
    try {
      if (this.ws) {
        if (this.boundOnMessage) this.ws.off("message", this.boundOnMessage);
        this.ws.close();
      }
    } finally {
      this.ws = null;
      this.isOpen = false;
    }
  }

  setOnMessage(fn?: (msg: any) => void) {
    this.onMessageCallback = fn;
  }

  private send<T = any>(payload: Record<string, any>, timeoutMs = 15000): Promise<T> {
    if (!this.ws || !this.isOpen) throw new Error("WebSocket not connected");
    const req_id = this.reqId++;
    this.ws.send(JSON.stringify({ ...payload, req_id }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error("Request timeout"));
      }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
    });
  }

  // Raw ticks helper
  private async getTicks(symbol: string, count: number) {
    const res = await this.send<any>({
      ticks_history: symbol,
      end: "latest",
      count: Number(count),
      style: "ticks",
    });
    if (res?.error) throw new Error(res.error.message || "Deriv ticks error");
    const prices: number[] = res?.history?.prices ?? [];
    const times: number[] = res?.history?.times ?? [];
    if (!Array.isArray(prices) || !Array.isArray(times) || prices.length !== times.length) {
      throw new Error("Invalid ticks response");
    }
    return times.map((t, i) => ({ epoch: Number(t), price: Number(prices[i]) }));
  }

  // Retrieve OHLC. For granularity < 60s, aggregate ticks into 1-second candles.
  async candles(symbol: string, granularitySec: number, count: number) {
    if (granularitySec >= 60) {
      const res = await this.send<any>({
        ticks_history: symbol,
        end: "latest",
        count: Number(count),
        start: 1,
        style: "candles",
        granularity: Number(granularitySec),
        adjust_start_time: 1,
      });
      if (res?.error) throw new Error(res.error.message || "Deriv candles error");
      const candles = res?.candles;
      if (!Array.isArray(candles)) throw new Error("No candles in response");
      return candles;
    }

    // Aggregate to 1-second candles from ticks
    if (granularitySec !== 1) throw new Error("Only 1-second granularity supported below 60s");
    // Over-fetch ticks to ensure enough per-second buckets
    const ticks = await this.getTicks(symbol, Math.max(200, count * 20));
    if (!ticks.length) return [];

    // Build per-second buckets
    const bySecond = new Map<number, number[]>();
    for (const t of ticks) {
      const sec = Math.floor(t.epoch);
      const arr = bySecond.get(sec) ?? [];
      arr.push(t.price);
      bySecond.set(sec, arr);
    }

    // Determine continuous last N seconds
    const lastSec = Math.max(...Array.from(bySecond.keys()));
    const firstNeeded = lastSec - (count - 1);

    const result: Array<{ epoch: number; open: number; high: number; low: number; close: number; volume: number }> = [];
    let prevClose: number | null = null;

    for (let s = firstNeeded; s <= lastSec; s++) {
      const arr = bySecond.get(s);
      if (arr && arr.length) {
        const open = arr[0];
        const close = arr[arr.length - 1];
        const high = Math.max(...arr);
        const low = Math.min(...arr);
        prevClose = close;
        result.push({ epoch: s, open, high, low, close, volume: arr.length });
      } else {
        // No ticks in this second: synthesize flat candle using prevClose
        const price = prevClose ?? (ticks.length ? ticks[0].price : 0);
        result.push({ epoch: s, open: price, high: price, low: price, close: price, volume: 0 });
      }
    }

    return result;
  }

  // Buy rise/fall
  async buyRiseFall(
    symbolOrOpts:
      | {
          symbol: string;
          side: "CALL" | "PUT";
          stake: number;
          duration: number;
          duration_unit: "m" | "h" | "d" | "t";
          currency?: string;
        }
      | string,
    stake?: number,
    duration?: number,
    duration_unit?: "m" | "h" | "d" | "t",
    side?: "CALL" | "PUT",
  ) {
    const isObj = typeof symbolOrOpts === "object";
    const symbol = isObj ? (symbolOrOpts as any).symbol : String(symbolOrOpts);
    const amt = isObj ? Number((symbolOrOpts as any).stake) : Number(stake);
    const dur = isObj ? Number((symbolOrOpts as any).duration) : Number(duration);
    const unit = (isObj ? (symbolOrOpts as any).duration_unit : duration_unit)!;
    const contractType = (isObj ? (symbolOrOpts as any).side : side)!;
    const currency = (isObj ? (symbolOrOpts as any).currency : undefined) ?? "USD";

    if (!symbol) throw new Error("buyRiseFall: symbol required");
    if (!contractType) throw new Error("buyRiseFall: side required");
    if (!Number.isFinite(amt) || amt <= 0) throw new Error("buyRiseFall: stake invalid");
    if (!Number.isFinite(dur) || dur <= 0) throw new Error("buyRiseFall: duration invalid");
    if (!unit) throw new Error("buyRiseFall: duration_unit required");

    const proposal = await this.send<any>({
      proposal: 1,
      amount: amt,
      basis: "stake",
      contract_type: contractType,
      currency,
      duration: dur,
      duration_unit: unit,
      symbol,
    });
    const proposal_id = proposal?.proposal?.id;
    if (!proposal_id) throw new Error("No proposal_id from Deriv");
    return this.send<any>({ buy: proposal_id, price: amt });
  }
}