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

    // attach a persistent message handler once
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
            // Non-request messages (ticks/updates)
            try {
              this.onMessageCallback?.(msg);
            } catch (cbErr) {
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
      const onOpen = async () => {
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

    // authorize if token provided
    if (this.token) {
      await this.send({ authorize: this.token });
    }
  }

  // optional disconnect
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

  // allow caller to register/replace non-request message handler
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

  // Retrieve OHLC candles
  async candles(symbol: string, granularitySec: number, count: number) {
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

  // Buy rise/fall. Supports both object and positional call styles.
  // Positional: buyRiseFall(symbol, stake, duration, duration_unit, contractType)
  async buyRiseFall(
    optsOrSymbol:
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
    contractType?: "CALL" | "PUT",
  ) {
    const isObjectCall = typeof optsOrSymbol === "object";
    const symbol = isObjectCall ? (optsOrSymbol as any).symbol : String(optsOrSymbol);
    const side = isObjectCall ? (optsOrSymbol as any).side : contractType!;
    const amt = isObjectCall ? Number((optsOrSymbol as any).stake) : Number(stake);
    const dur = isObjectCall ? Number((optsOrSymbol as any).duration) : Number(duration);
    const unit = (isObjectCall ? (optsOrSymbol as any).duration_unit : duration_unit)!;
    const currency = (isObjectCall ? (optsOrSymbol as any).currency : undefined) ?? "USD";

    if (!symbol) throw new Error("buyRiseFall: symbol required");
    if (!side) throw new Error("buyRiseFall: side required");
    if (!Number.isFinite(amt) || amt <= 0) throw new Error("buyRiseFall: stake invalid");
    if (!Number.isFinite(dur) || dur <= 0) throw new Error("buyRiseFall: duration invalid");
    if (!unit) throw new Error("buyRiseFall: duration_unit required");

    const proposal = await this.send<any>({
      proposal: 1,
      amount: amt,
      basis: "stake",
      contract_type: side,
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