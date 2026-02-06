import WebSocket from "ws";
import { env } from "../env";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class DerivClient {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private reqId = 1;
  private isOpen = false;

  constructor(private token?: string) {}

  async connect(): Promise<void> {
    if (this.isOpen && this.ws) return;
    const url = "wss://ws.deriv.com/websockets/v3?app_id=1089"; // replace with your app_id if needed
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.isOpen = true;
        this.off();
        resolve();
      };
      const onErr = (e: any) => {
        this.off();
        reject(new Error(String(e?.message ?? e)));
      };
      const onMsg = (ev: any) => {
        const data = JSON.parse(ev.data);
        const id = data.req_id;
        if (id && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          clearTimeout(p.timer);
          this.pending.delete(id);
          if (data.error) p.reject(new Error(data.error.message || "Deriv error"));
          else p.resolve(data);
        }
      };
      this.ws!.addEventListener("open", onOpen);
      this.ws!.addEventListener("error", onErr);
      this.ws!.addEventListener("message", onMsg);
      (this.ws as any)._cleanup = () => {
        this.ws?.removeEventListener("open", onOpen as any);
        this.ws?.removeEventListener("error", onErr as any);
        this.ws?.removeEventListener("message", onMsg as any);
      };
    });

    if (this.token) {
      await this.send({ authorize: this.token });
    }
  }

  private off() {
    (this.ws as any)?._cleanup?.();
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

  async buyRiseFall(opts: {
    symbol: string;
    side: "CALL" | "PUT";
    stake: number;
    duration: number;
    duration_unit: "m" | "h" | "d" | "t";
    currency?: string;
  }) {
    const currency = opts.currency ?? "USD";
    const proposal = await this.send<any>({
      proposal: 1,
      amount: Number(opts.stake),
      basis: "stake",
      contract_type: opts.side,
      currency,
      duration: Number(opts.duration),
      duration_unit: opts.duration_unit,
      symbol: opts.symbol,
    });
    const proposal_id = proposal?.proposal?.id;
    if (!proposal_id) throw new Error("No proposal_id from Deriv");
    return this.send<any>({ buy: proposal_id, price: Number(opts.stake) });
  }
}
