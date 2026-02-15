import WebSocket from "ws";
import { env } from "../env";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const DEFAULT_APP_ID = 1089;
const WS_ENDPOINTS = [
  process.env.DERIV_WS_URL ? String(process.env.DERIV_WS_URL).replace(/\/+$/, "") : "",
  "wss://ws.derivws.com/websockets/v3",
  "wss://ws.binaryws.com/websockets/v3",
].filter(Boolean);

export class DerivClient {
  private ws: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private reqId = 1;
  private isOpen = false;
  private onMessageCallback?: (msg: any) => void;
  private boundOnMessage?: (data: WebSocket.Data) => void;

  // NEW: track endpoint rotation + heartbeat
  private endpointIndex = 0;
  private heartbeat?: NodeJS.Timeout;
  private lastPong = 0;

  constructor(private token?: string, onMessage?: (msg: any) => void) {
    this.onMessageCallback = onMessage;
  }

  async connect(): Promise<void> {
    if (this.isOpen && this.ws) return;

    const appId = Number(process.env.DERIV_APP_ID ?? (env as any)?.DERIV_APP_ID ?? DEFAULT_APP_ID);
    const errors: string[] = [];

    // rotate starting endpoint to spread load after failures
    for (let i = 0; i < WS_ENDPOINTS.length; i++) {
      const idx = (this.endpointIndex + i) % WS_ENDPOINTS.length;
      const base = WS_ENDPOINTS[idx];
      const url = `${base}?app_id=${appId}`;
      try {
        await this.openAt(url);
        this.endpointIndex = idx; // remember working endpoint
        if (this.token) await this.send({ authorize: this.token });
        return;
      } catch (e: any) {
        errors.push(`${base}: ${e?.message || String(e)}`);
        try {
          await this.disconnect();
        } catch {}
      }
    }

    throw new Error(`All Deriv endpoints failed: ${errors.join(" | ")}`);
  }

  private async openAt(url: string): Promise<void> {
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
            try {
              this.onMessageCallback?.(msg);
            } catch (cbErr) {
              const e = cbErr as any;
              console.error("[DerivClient] onMessage callback error:", e && (e.stack ?? e.message ?? e));
              try {
                console.error("[DerivClient] callback message (raw):", JSON.stringify(msg));
              } catch {}
            }
          }
        } catch (err) {
          console.error(
            "[DerivClient] message parse error",
            String(err),
            "raw:",
            typeof data === "string" ? data : data.toString(),
          );
        }
      };
    }

    this.ws.on("message", this.boundOnMessage);

    // NEW: lifecycle + heartbeat
    this.ws.on("close", () => {
      this.isOpen = false;
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
    });
    this.ws.on("pong", () => {
      this.lastPong = Date.now();
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.isOpen = true;
        this.ws?.off("error", onErrorOnce);
        // start heartbeat (ws server should reply with pong)
        this.lastPong = Date.now();
        if (!this.heartbeat) {
          this.heartbeat = setInterval(() => {
            try {
              if (!this.ws || !this.isOpen) return;
              const now = Date.now();
              if (now - this.lastPong > 60_000) {
                // missed pong -> reconnect
                this.reconnect("missed pong").catch(() => void 0);
                return;
              }
              // send ping
              (this.ws as any).ping?.();
            } catch {
              /* ignore */
            }
          }, 25_000);
        }
        resolve();
      };
      const onErrorOnce = (e: any) => {
        this.ws?.off("open", onOpen);
        reject(new Error(String(e?.message ?? e)));
      };
      this.ws!.once("open", onOpen);
      this.ws!.once("error", onErrorOnce);
    });
  }

  async disconnect(): Promise<void> {
    try {
      if (this.ws) {
        if (this.boundOnMessage) this.ws.off("message", this.boundOnMessage);
        this.ws.close();
      }
    } finally {
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
      this.ws = null;
      this.isOpen = false;
    }
  }

  // NEW: reconnect helper (rotate endpoint and re-authorize)
  private async reconnect(reason?: string) {
    try {
      await this.disconnect();
    } catch {}
    // move to next endpoint for the next connect attempt
    this.endpointIndex = (this.endpointIndex + 1) % WS_ENDPOINTS.length;
    await this.connect();
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

  // NEW: send with retry (safeToRetry guards order placement)
  private async sendWithRetry<T = any>(
    payload: Record<string, any>,
    opts?: { timeoutMs?: number; retries?: number; retryDelayMs?: number; safeToRetry?: boolean },
  ): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? 15000;
    const retries = Math.max(0, opts?.retries ?? 2);
    const retryDelayMs = opts?.retryDelayMs ?? 600;
    const safe = !!opts?.safeToRetry;

    let lastErr: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (!this.isOpen || !this.ws) await this.connect();
        return await this.send<T>(payload, timeoutMs);
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || e);
        const isTimeout = msg.includes("timeout");
        const isConn = msg.includes("not connected");
        if (!safe && (isTimeout || isConn)) {
          // do not risk duplicate orders
          break;
        }
        if (attempt < retries && (isTimeout || isConn)) {
          await this.reconnect(msg).catch(() => void 0);
          await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
          continue;
        }
        break;
      }
    }
    throw lastErr;
  }

  /**
   * Validate a Deriv API token.
   * This method exists because server routes call `c.validateToken(...)`.
   */
  async validateToken(token: string): Promise<{
    ok: true;
    loginid: string | null;
    balance: number | null;
    currency: string | null;
    raw: any;
  }> {
    const t = String(token ?? "").trim();
    if (!t) throw new Error("Token required");

    // Use a separate client so we don't disturb any existing authorized session on `this`.
    const tmp = new DerivClient();

    try {
      await tmp.connect();

      const res = await tmp.sendWithRetry<any>(
        { authorize: t },
        { timeoutMs: 20_000, retries: 2, retryDelayMs: 600, safeToRetry: true },
      );

      if (res?.error) throw new Error(res.error.message || "Deriv authorize error");

      const a = res?.authorize ?? null;
      const balNum = Number(a?.balance ?? NaN);

      return {
        ok: true,
        loginid: a?.loginid ?? null,
        balance: Number.isFinite(balNum) ? balNum : null,
        currency: (a?.currency ?? null) as string | null,
        raw: res,
      };
    } finally {
      await tmp.disconnect().catch(() => void 0);
    }
  }

  // Raw ticks helper
  private async getTicks(symbol: string, count: number) {
    // Increased timeout + retries (safe to retry)
    const res = await this.sendWithRetry<any>(
      {
        ticks_history: symbol,
        end: "latest",
        count: Number(count),
        style: "ticks",
      },
      { timeoutMs: 30_000, retries: 2, retryDelayMs: 700, safeToRetry: true },
    );
    if (res?.error) throw new Error(res.error.message || "Deriv ticks error");
    const prices: number[] = res?.history?.prices ?? [];
    const times: number[] = res?.history?.times ?? [];
    if (!Array.isArray(prices) || !Array.isArray(times) || prices.length !== times.length) {
      throw new Error("Invalid ticks response");
    }
    return times.map((t, i) => ({ epoch: Number(t), price: Number(prices[i]) }));
  }

  // Retrieve OHLC. For 1s, aggregate ticks into 1s candles.
  async candles(symbol: string, granularitySec: number, count: number) {
    if (granularitySec >= 60) {
      // Increased timeout + retries (safe)
      const res = await this.sendWithRetry<any>(
        {
          ticks_history: symbol,
          end: "latest",
          count: Number(count),
          start: 1,
          style: "candles",
          granularity: Number(granularitySec),
          adjust_start_time: 1,
        },
        { timeoutMs: 30_000, retries: 2, retryDelayMs: 700, safeToRetry: true },
      );
      if (res?.error) throw new Error(res.error.message || "Deriv candles error");
      const candles = res?.candles;
      if (!Array.isArray(candles)) throw new Error("No candles in response");
      return candles;
    }

    if (granularitySec !== 1) throw new Error("Only 1-second granularity supported below 60s");
    const ticks = await this.getTicks(symbol, Math.max(200, count * 20));
    if (!ticks.length) return [];

    const bySecond = new Map<number, number[]>();
    for (const t of ticks) {
      const sec = Math.floor(t.epoch);
      const arr = bySecond.get(sec) ?? [];
      arr.push(t.price);
      bySecond.set(sec, arr);
    }

    const sortedSeconds = Array.from(bySecond.keys()).sort((a, b) => a - b);
    const lastSec = sortedSeconds.length ? sortedSeconds[sortedSeconds.length - 1] : Math.floor(ticks[ticks.length - 1].epoch);
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
        const price = prevClose ?? (ticks.length ? ticks[0].price : 0);
        result.push({ epoch: s, open: price, high: price, low: price, close: price, volume: 0 });
      }
    }

    return result;
  }

  // Buy rise/fall (object or positional signature)
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
    const isObj = typeof optsOrSymbol === "object";
    const symbol = isObj ? (optsOrSymbol as any).symbol : String(optsOrSymbol);
    const side = isObj ? (optsOrSymbol as any).side : contractType!;
    const amt = isObj ? Number((optsOrSymbol as any).stake) : Number(stake);
    const dur = isObj ? Number((optsOrSymbol as any).duration) : Number(duration);
    const unit = (isObj ? (optsOrSymbol as any).duration_unit : duration_unit)!;
    const currency = (isObj ? (optsOrSymbol as any).currency : undefined) ?? "USD";

    if (!symbol) throw new Error("buyRiseFall: symbol required");
    if (!side) throw new Error("buyRiseFall: side required");
    if (!Number.isFinite(amt) || amt <= 0) throw new Error("buyRiseFall: stake invalid");
    if (!Number.isFinite(dur) || dur <= 0) throw new Error("buyRiseFall: duration invalid");
    if (!unit) throw new Error("buyRiseFall: duration_unit required");

    // Proposal: safe to retry
    const proposal = await this.sendWithRetry<any>(
      {
        proposal: 1,
        amount: amt,
        basis: "stake",
        contract_type: side,
        currency,
        duration: dur,
        duration_unit: unit,
        symbol,
      },
      { timeoutMs: 20_000, retries: 2, retryDelayMs: 600, safeToRetry: true },
    );

    const proposal_id = proposal?.proposal?.id;
    if (!proposal_id) throw new Error("No proposal_id from Deriv");

    // Buy: NOT safe to retry automatically to avoid duplicate orders
    return this.sendWithRetry<any>({ buy: proposal_id, price: amt }, { timeoutMs: 20_000, retries: 0, safeToRetry: false });
  }

  // Snapshot current state for a contract (returns is_sold, buy_price, sell_price, profit, etc.)
  async openContract(contractId: number | string) {
    const res = await this.sendWithRetry<any>(
      { proposal_open_contract: 1, contract_id: contractId },
      {
        timeoutMs: 20_000,
        retries: 2,
        retryDelayMs: 600,
        safeToRetry: true,
      },
    );
    if (res?.error) throw new Error(res.error.message || "Deriv open_contract error");
    return res?.proposal_open_contract;
  }

  // Get current account balance (for authorized token)
  async getBalance(): Promise<{ balance: number; currency?: string }> {
    const res = await this.sendWithRetry<any>({ balance: 1 }, { timeoutMs: 20_000, retries: 1, retryDelayMs: 600, safeToRetry: true });
    if (res?.error) throw new Error(res.error.message || "Deriv balance error");
    const bal = Number(res?.balance?.balance ?? res?.balance?.amount ?? NaN);
    return { balance: Number.isFinite(bal) ? bal : 0, currency: res?.balance?.currency };
  }

  // List active symbols
  async activeSymbols(kind: "brief" | "full" = "brief") {
    const res = await this.sendWithRetry<any>(
      { active_symbols: kind, product_type: "basic" },
      { timeoutMs: 20_000, retries: 2, retryDelayMs: 600, safeToRetry: true },
    );
    if (res?.error) throw new Error(res.error.message || "Deriv active_symbols error");
    const arr = res?.active_symbols;
    return Array.isArray(arr) ? arr : [];
  }
}