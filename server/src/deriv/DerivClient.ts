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
    if (this.ws && this.isOpen) return;
    const url = `${env.DERIV_WS_URL}?app_id=${env.DERIV_APP_ID}`;
    this.ws = new WebSocket(url);
    this.isOpen = false;

    this.ws.on("open", () => {
      this.isOpen = true;
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        const id = msg.req_id;
        if (id && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          clearTimeout(p.timer);
          this.pending.delete(id);
          if (msg.error) p.reject(new Error(msg.error.message ?? "Deriv error"));
          else p.resolve(msg);
        }
      } catch {
        // ignore
      }
    });

    this.ws.on("close", () => {
      this.isOpen = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Deriv socket closed"));
      }
      this.pending.clear();
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Deriv connect timeout")), 8000);
      this.ws!.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws!.once("error", reject);
    });

    if (this.token) {
      await this.request({ authorize: this.token });
    }
  }

  async request(payload: Record<string, any>, timeoutMs = 10_000) {
    await this.connect();
    const id = this.reqId++;
    const ws = this.ws!;
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Deriv request timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  async validateToken(token: string) {
    const c = new DerivClient(token);
    await c.connect();
    const res = await c.request({ authorize: token });
    const auth = res.authorize;
    return { account_id: auth?.loginid as string | undefined, currency: auth?.currency as string | undefined };
  }

  async activeSymbols() {
    const res = await this.request({ active_symbols: "brief", product_type: "basic" });
    return (res.active_symbols ?? []) as any[];
  }

  async candles(symbol: string, granularitySec: number, count = 200) {
    const res = await this.request({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: "latest",
      style: "candles",
      granularity: granularitySec,
    });
    return (res.candles ?? []) as any[];
  }

  async buyRiseFall(symbol: string, stake: number, duration: number, duration_unit: "t" | "m" | "h" | "d", contract_type: "CALL" | "PUT") {
    // Simplified live flow for binary (Deriv supports many types; extend as needed).
    const proposal = await this.request({
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type,
      currency: "USD",
      duration,
      duration_unit,
      symbol,
    });
    const proposalId = proposal.proposal?.id;
    if (!proposalId) throw new Error("No proposal id");
    const buy = await this.request({ buy: proposalId, price: stake });
    return buy;
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
