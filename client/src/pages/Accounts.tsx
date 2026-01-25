import { useState } from "react";
import { useAccounts, useUpsertDerivAccount, useUpsertMt5Account } from "@/hooks/use-accounts";
import { useToast } from "@/hooks/use-toast";

export default function Accounts() {
  const { data: accounts } = useAccounts();
  const { toast } = useToast();
  const upsertDeriv = useUpsertDerivAccount();
  const upsertMt5 = useUpsertMt5Account();

  const [label, setLabel] = useState("Deriv Main");
  const [token, setToken] = useState("");
  const [mt5Label, setMt5Label] = useState("MT5 (Optional)");
  const [server, setServer] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");

  const saveDeriv = async () => {
    try {
      await upsertDeriv.mutateAsync({ label, token });
      toast({ title: "Deriv account saved", description: "Token stored encrypted on server." });
      setToken("");
    } catch (e: any) {
      toast({ title: "Error", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  const saveMt5 = async () => {
    try {
      await upsertMt5.mutateAsync({ label: mt5Label, server, login, password });
      toast({ title: "MT5 account saved", description: "Validation runs via optional worker." });
      setPassword("");
    } catch (e: any) {
      toast({ title: "Error", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-2xl font-semibold">Accounts</div>
        <div className="text-sm text-muted-foreground">Connect Deriv via API token, and optionally validate MT5.</div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="font-semibold mb-2">Deriv</div>
          <label className="block text-sm mb-1">Label</label>
          <input className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-3" value={label} onChange={(e) => setLabel(e.target.value)} />
          <label className="block text-sm mb-1">API Token</label>
          <input className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-3" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Deriv token" />
          <button onClick={saveDeriv} className="rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow hover:opacity-90">
            Save Deriv Token
          </button>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="font-semibold mb-2">MT5 (Optional)</div>
          <div className="text-xs text-muted-foreground mb-3">
            Requires a Windows host running the Python worker with MetaTrader5 terminal installed.
          </div>
          <label className="block text-sm mb-1">Label</label>
          <input className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-2" value={mt5Label} onChange={(e) => setMt5Label(e.target.value)} />
          <label className="block text-sm mb-1">Server</label>
          <input className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-2" value={server} onChange={(e) => setServer(e.target.value)} />
          <label className="block text-sm mb-1">Login</label>
          <input className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-2" value={login} onChange={(e) => setLogin(e.target.value)} />
          <label className="block text-sm mb-1">Password</label>
          <input className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-3" value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
          <button onClick={saveMt5} className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            Save & Validate MT5
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="font-semibold mb-2">Connected Accounts</div>
        <div className="text-sm text-muted-foreground mb-3">Accounts are stored in Supabase; secrets are encrypted server-side.</div>
        <div className="space-y-2">
          {(accounts ?? []).map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
              <div>
                <div className="font-medium">{a.label}</div>
                <div className="text-xs text-muted-foreground">{a.type} • {a.status}</div>
              </div>
              <div className="text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString()}</div>
            </div>
          ))}
          {(accounts ?? []).length === 0 ? <div className="text-sm text-muted-foreground">No accounts yet.</div> : null}
        </div>
      </div>
    </div>
  );
}
