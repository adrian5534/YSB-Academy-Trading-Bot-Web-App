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
        cleanup();
        resolve();
      };
      const onErr = (e: any) => {
        cleanup();
        reject(new Error(String(e?.message ?? e)));
      };
      const onMsg = (data: WebSocket.Data) => {
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
            // non-request message (ticks/updates). keep quiet or debug if needed
            // console.debug("[DerivClient] message", msg);
          }
        } catch (err) {
          console.error("[DerivClient] message parse error", String(err));
        }
      };

      const cleanup = () => {
        this.ws?.off("open", onOpen as any);
        this.ws?.off("error", onErr as any);
        this.ws?.off("message", onMsg as any);
      };

      this.ws.on("open", onOpen);
      this.ws.on("error", onErr);
      this.ws.on("message", onMsg);
      (this.ws as any)._cleanup = cleanup;
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
