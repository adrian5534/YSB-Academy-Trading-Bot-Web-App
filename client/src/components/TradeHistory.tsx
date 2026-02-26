import { useEffect, useMemo, useState, useRef } from "react";
import { useTrades } from "@/hooks/use-trades";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

export type HistoryMode = "all" | "paper" | "live" | "backtest";

function formatTime(iso?: string | null) {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function formatPrice(v: any) {
  const n = Number(v);
  if (!isFinite(n)) return "-";
  return n.toFixed(2);
}

function formatProfit(v: any) {
  const n = Number(v ?? 0);
  const p = Math.abs(n).toFixed(2);
  return `${n > 0 ? "+$" : n < 0 ? "-$" : "$"}${p}`;
}

type LiveSnap = {
  id: string;
  profit_now?: number;
  is_valid_to_sell?: boolean | number | null;
  is_sold?: boolean;
  updated_at?: string;
};

export function TradeHistory({
  mode = "all",
  accountId,
  trades: tradesProp,
}: {
  mode?: HistoryMode;
  accountId?: string;
  trades?: any[];
}) {
  const { toast } = useToast();
  const { data: fetchedTrades, isLoading: fetchedLoading } = useTrades();

  const trades = (tradesProp ?? fetchedTrades ?? []) as any[];
  const isLoading = tradesProp ? false : fetchedLoading;

  // live snapshots for open trades (profit updates)
  const [snapById, setSnapById] = useState<Record<string, LiveSnap>>({});
  const [sellingId, setSellingId] = useState<string | null>(null);

  const lastPollAtRef = useRef<number>(0);

  const filteredTrades = useMemo(() => {
    return (trades ?? [])
      .filter((t) => (mode === "all" ? true : String(t?.mode ?? "").toLowerCase() === mode))
      .filter((t) => (accountId ? String(t?.account_id ?? "") === String(accountId) : true));
  }, [trades, mode, accountId]);

  // Poll live profit for OPEN live trades (best-effort) - no overlapping requests
  useEffect(() => {
    const openLive = filteredTrades
      .filter((t) => String(t?.mode ?? "").toLowerCase() === "live")
      .filter((t) => !t?.closed_at)
      .slice(0, 25);

    if (openLive.length === 0) return;

    let alive = true;
    let controller: AbortController | null = null;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const loop = async () => {
      while (alive) {
        // Optional: reduce noise when tab is hidden
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          await sleep(2000);
          continue;
        }

        const started = Date.now();
        lastPollAtRef.current = started;

        try {
          // Abort any in-flight poll before starting a new one
          controller?.abort();
          controller = new AbortController();

          const qs = new URLSearchParams();
          qs.set("limit", "25");
          if (accountId) qs.set("account_id", String(accountId));

          // Cache-bust to avoid any intermediate caching layers
          qs.set("_t", String(Date.now()));

          const r = await apiFetch(`/api/trades/open/snap?${qs.toString()}`, {
            signal: controller.signal as any,
          } as any);

          if (r.ok) {
            const snaps = (await r.json()) as LiveSnap[];
            if (alive && Array.isArray(snaps)) {
              setSnapById((prev) => {
                const next = { ...(prev ?? {}) };
                for (const s of snaps) {
                  if (!s?.id) continue;
                  next[String(s.id)] = s;
                }
                return next;
              });
            }
          }
        } catch {
          // ignore
        }

        // Keep roughly a 2s cadence, but never overlap
        const elapsed = Date.now() - started;
        const wait = Math.max(600, 2000 - elapsed);
        await sleep(wait);
      }
    };

    void loop();

    return () => {
      alive = false;
      controller?.abort();
    };
  }, [filteredTrades, accountId]);

  const rows = useMemo(() => {
    return filteredTrades.slice(0, 50);
  }, [filteredTrades]);

  const canSellNow = (t: any) => {
    if (String(t?.mode ?? "").toLowerCase() !== "live") return false;
    if (t?.closed_at) return false;
    const cid = Number(t?.meta?.contract_id ?? 0);
    if (!Number.isFinite(cid) || cid <= 0) return false;

    const snap = snapById[String(t?.id ?? "")];
    const v = snap?.is_valid_to_sell;

    // if we don't know yet, allow button (Deriv will reject if not sellable)
    if (v === null || v === undefined) return true;

    return v === true || v === 1;
  };

  const sellEarly = async (tradeId: string) => {
    // ✅ no confirm dialog — just sell
    try {
      setSellingId(tradeId);
      const r = await apiFetch(`/api/trades/${tradeId}/sell-early`, { method: "POST" });

      if (!r.ok) {
        const msg = await r.json().catch(() => ({}));
        throw new Error(msg?.error || "Sell failed");
      }

      // Response is the updated trade row
      const updated = await r.json().catch(() => null);

      // clear snapshot so UI relies on closed trade values
      setSnapById((prev) => {
        const next = { ...(prev ?? {}) };
        delete next[String(tradeId)];
        return next;
      });

      toast({ title: "Trade sold early", description: `Trade ${tradeId} closed.` });

      // If this component is using fetchedTrades, it will update on the next useTrades refetch.
      // If not, at least the OPEN badge disappears when parent passes updated trades.
      void updated;
    } catch (e: any) {
      toast({ title: "Early sell failed", description: String(e?.message ?? e), variant: "destructive" });
    } finally {
      setSellingId(null);
    }
  };

  return (
    <div className="trade-history rounded-2xl border border-border bg-card flex flex-col">
      <div className="trade-history__header flex items-center gap-2 px-4 py-3 border-b border-border">
        <div className="h-2 w-2 rounded-full bg-yellow-300/80 shadow-[0_0_12px_rgba(250,204,21,0.6)]" />
        <h2 className="font-semibold text-lg">
          Recent Trades {mode !== "all" ? `• ${mode[0].toUpperCase()}${mode.slice(1)}` : ""}
        </h2>
      </div>

      {isLoading ? (
        <div className="trade-history__body p-4 text-muted-foreground">Loading…</div>
      ) : (
        <div className="trade-history__body">
          <table className="trade-history__table min-w-full text-sm">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/70">
                <th className="px-4 py-3 text-left font-medium">Time</th>
                <th className="px-4 py-3 text-left font-medium">Symbol</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Entry</th>
                <th className="px-4 py-3 text-left font-medium">Exit</th>
                <th className="px-4 py-3 text-left font-medium">Profit</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Action</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((t) => {
                const side = String(t.side ?? "").toUpperCase();
                const entry = t.entry_price ?? t.entry ?? t.open_price ?? t.open ?? null;
                const exit = t.exit_price ?? t.exit ?? t.close_price ?? t.close ?? null;

                const isClosed = Boolean(t.closed_at ?? t.exit ?? t.exit_price);
                const snap = snapById[String(t?.id ?? "")];

                // ✅ live profit for open live trades
                const profitNum = isClosed ? Number(t.profit ?? 0) : Number(snap?.profit_now ?? t.profit ?? 0);
                const won = profitNum > 0;

                return (
                  <tr key={t.id} className="border-b border-border/40">
                    <td className="px-4 py-3">{formatTime(t.opened_at ?? t.created_at)}</td>
                    <td className="px-4 py-3 font-medium">{t.symbol ?? "-"}</td>

                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                          side === "CALL"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                            : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${side === "CALL" ? "bg-emerald-400" : "bg-rose-400"}`}
                        />
                        {side || "-"}
                      </span>
                    </td>

                    <td className="px-4 py-3 tabular-nums">{formatPrice(entry)}</td>
                    <td className="px-4 py-3 tabular-nums">{formatPrice(exit)}</td>

                    <td
                      className={`px-4 py-3 tabular-nums font-semibold ${
                        profitNum > 0
                          ? "text-emerald-400"
                          : profitNum < 0
                            ? "text-rose-400"
                            : "text-muted-foreground"
                      }`}
                      title={!isClosed ? "Live (open trade) profit estimate" : "Realized profit"}
                    >
                      {formatProfit(profitNum)}
                    </td>

                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center justify-center rounded-md px-2 py-1 text-xs font-medium ${
                          isClosed
                            ? won
                              ? "bg-emerald-500/15 text-emerald-300"
                              : "bg-rose-500/15 text-rose-300"
                            : "bg-yellow-500/15 text-yellow-300"
                        }`}
                      >
                        {isClosed ? (won ? "WON" : "LOST") : "OPEN"}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      {canSellNow(t) ? (
                        <button
                          type="button"
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                          disabled={sellingId === String(t.id)}
                          onClick={() => sellEarly(String(t.id))}
                        >
                          {sellingId === String(t.id) ? "Selling…" : "Sell"}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}

              {rows.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-muted-foreground" colSpan={8}>
                    No trades yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}