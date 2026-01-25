import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { zRiskRules } from "@shared/routes";

export default function Settings() {
  const { toast } = useToast();
  const [rules, setRules] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch("/api/settings/risk")
      .then((r) => r.json())
      .then((d) => setRules(zRiskRules.parse(d)))
      .catch((e) => toast({ title: "Error", description: String(e.message ?? e), variant: "destructive" }))
      .finally(() => setLoading(false));
  }, [toast]);

  const save = async () => {
    try {
      const payload = zRiskRules.parse(rules);
      await apiFetch("/api/settings/risk", { method: "PUT", body: JSON.stringify(payload) });
      toast({ title: "Saved" });
    } catch (e: any) {
      toast({ title: "Save failed", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  if (loading) return <div className="text-muted-foreground">Loading…</div>;
  if (!rules) return null;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-2xl font-semibold">Settings</div>
        <div className="text-sm text-muted-foreground">Risk rules (server enforced).</div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 space-y-3 max-w-2xl">
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <label className="block text-sm">Risk Type</label>
            <select className="w-full rounded-lg border border-border bg-background px-3 py-2" value={rules.risk_type} onChange={(e) => setRules({ ...rules, risk_type: e.target.value })}>
              <option value="fixed_stake">Fixed stake</option>
              <option value="percent_balance">% balance</option>
            </select>
          </div>
          <div>
            <label className="block text-sm">Fixed Stake</label>
            <input className="w-full rounded-lg border border-border bg-background px-3 py-2" type="number" value={rules.fixed_stake} onChange={(e) => setRules({ ...rules, fixed_stake: Number(e.target.value) })} />
          </div>
          <div>
            <label className="block text-sm">% Risk</label>
            <input className="w-full rounded-lg border border-border bg-background px-3 py-2" type="number" value={rules.percent_risk} onChange={(e) => setRules({ ...rules, percent_risk: Number(e.target.value) })} />
          </div>
          <div>
            <label className="block text-sm">Max Open Trades</label>
            <input className="w-full rounded-lg border border-border bg-background px-3 py-2" type="number" value={rules.max_open_trades} onChange={(e) => setRules({ ...rules, max_open_trades: Number(e.target.value) })} />
          </div>
          <div>
            <label className="block text-sm">Max Daily Loss</label>
            <input className="w-full rounded-lg border border-border bg-background px-3 py-2" type="number" value={rules.max_daily_loss} onChange={(e) => setRules({ ...rules, max_daily_loss: Number(e.target.value) })} />
          </div>
          <div>
            <label className="block text-sm">Max Drawdown</label>
            <input className="w-full rounded-lg border border-border bg-background px-3 py-2" type="number" value={rules.max_drawdown} onChange={(e) => setRules({ ...rules, max_drawdown: Number(e.target.value) })} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input type="checkbox" checked={rules.adaptive_enabled} onChange={(e) => setRules({ ...rules, adaptive_enabled: e.target.checked })} />
          <span className="text-sm">Adaptive risk enabled</span>
        </div>

        <button onClick={save} className="rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow hover:opacity-90">
          Save
        </button>
      </div>
    </div>
  );
}
