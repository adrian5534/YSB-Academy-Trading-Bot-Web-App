import { useState } from "react";
import { useAccounts, useUpsertDerivAccount, useUpsertMt5Account } from "@/hooks/use-accounts";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export default function Accounts() {
  const { data: accounts } = useAccounts();
  const { toast } = useToast();
  const upsertDeriv = useUpsertDerivAccount();
  const upsertMt5 = useUpsertMt5Account();
  const qc = useQueryClient();

  const [label, setLabel] = useState("Deriv Main");
  const [token, setToken] = useState("");
  const [mt5Label, setMt5Label] = useState("MT5 (Optional)");
  const [server, setServer] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");

  // Editing state per existing account
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [editingSecretsId, setEditingSecretsId] = useState<string | null>(null);
  const [editToken, setEditToken] = useState("");
  const [editServer, setEditServer] = useState("");
  const [editLogin, setEditLogin] = useState("");
  const [editPassword, setEditPassword] = useState("");

  async function apiWriteWith405Fallback(url: string, body: any) {
    try {
      await apiFetch(url, { method: "PUT", body: JSON.stringify(body) });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.startsWith("405")) {
        await apiFetch(url, { method: "POST", body: JSON.stringify(body) });
        return;
      }
      throw e;
    }
  }

  const saveDeriv = async () => {
    try {
      const t = token.trim();
      const l = label.trim();
      if (!l) throw new Error("Label required");
      if (!t) throw new Error("Token required");

      await upsertDeriv.mutateAsync({ label: l, token: t });
      toast({ title: "Deriv account saved", description: "Token stored encrypted on server." });
      setToken("");
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e: any) {
      toast({ title: "Error", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  const saveMt5 = async () => {
    try {
      const l = mt5Label.trim();
      if (!l) throw new Error("Label required");
      if (!server.trim() || !login.trim() || !password) throw new Error("Server, login and password required");

      await upsertMt5.mutateAsync({ label: l, server: server.trim(), login: login.trim(), password });
      toast({ title: "MT5 account saved", description: "Validation runs via optional worker." });
      setPassword("");
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e: any) {
      toast({ title: "Error", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  const startRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameLabel(current);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameLabel("");
  };

  const submitRename = async (id: string) => {
    try {
      const next = renameLabel.trim();
      if (!next) throw new Error("Label required");

      await apiWriteWith405Fallback(`/api/accounts/${id}/rename`, { label: next });

      toast({ title: "Renamed", description: "Account label updated." });
      setRenamingId(null);
      setRenameLabel("");
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e: any) {
      toast({ title: "Error", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  const startEditSecrets = (id: string, type: string) => {
    setEditingSecretsId(id);
    // clear fields; we don't show current secrets
    if (type === "deriv") {
      setEditToken("");
    } else {
      setEditServer("");
      setEditLogin("");
      setEditPassword("");
    }
  };

  const cancelEditSecrets = () => {
    setEditingSecretsId(null);
    setEditToken("");
    setEditServer("");
    setEditLogin("");
    setEditPassword("");
  };

  const submitEditSecrets = async (id: string, type: string) => {
    try {
      if (type === "deriv") {
        const t = editToken.trim();
        if (!t) throw new Error("Token required");
        await apiWriteWith405Fallback(`/api/accounts/${id}/deriv`, { token: t });
      } else {
        const s = editServer.trim();
        const l = editLogin.trim();
        if (!s || !l || !editPassword) throw new Error("Server, login and password required");
        await apiWriteWith405Fallback(`/api/accounts/${id}/mt5`, { server: s, login: l, password: editPassword });
      }

      toast({ title: "Updated", description: "Account credentials updated." });
      cancelEditSecrets();
      await qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch (e: any) {
      toast({ title: "Error", description: String(e.message ?? e), variant: "destructive" });
    }
  };

  const removeAccount = async (id: string) => {
    try {
      if (!confirm("Remove this account?")) return;

      try {
        await apiFetch(`/api/accounts/${id}`, { method: "DELETE" });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg.startsWith("405")) {
          await apiFetch(`/api/accounts/${id}/delete`, { method: "POST" });
        } else {
          throw e;
        }
      }

      toast({ title: "Removed", description: "Account deleted." });
      await qc.invalidateQueries({ queryKey: ["accounts"] });
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
          <input
            className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-3"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <label className="block text-sm mb-1">API Token</label>
          <input
            className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-3"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Deriv token"
          />
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
          <input
            className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-2"
            value={mt5Label}
            onChange={(e) => setMt5Label(e.target.value)}
          />
          <label className="block text-sm mb-1">Server</label>
          <input
            className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-2"
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
          <label className="block text-sm mb-1">Login</label>
          <input
            className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-2"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
          <label className="block text-sm mb-1">Password</label>
          <input
            className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-3"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
          />
          <button onClick={saveMt5} className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            Save & Validate MT5
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="font-semibold mb-2">Connected Accounts</div>
        <div className="text-sm text-muted-foreground mb-3">Accounts are stored in Supabase; secrets are encrypted server-side.</div>
        <div className="space-y-2">
          {(accounts ?? []).map((a) => {
            const isRenaming = renamingId === a.id;
            const isEditing = editingSecretsId === a.id;

            return (
              <div key={a.id} className="space-y-2 rounded-lg border border-border bg-background p-3">
                <div className="flex items-center justify-between">
                  <div>
                    {isRenaming ? (
                      <div className="flex items-center gap-2">
                        <input
                          className="w-64 rounded-lg border border-border bg-card px-3 py-2"
                          value={renameLabel}
                          onChange={(e) => setRenameLabel(e.target.value)}
                        />
                        <button
                          onClick={() => submitRename(a.id)}
                          className="rounded-lg bg-ysbPurple px-3 py-2 text-sm font-semibold text-ysbYellow"
                        >
                          Save
                        </button>
                        <button onClick={cancelRename} className="rounded-lg border border-border px-3 py-2 text-sm">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="font-medium">{a.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {a.type} • {a.status}
                        </div>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {!isRenaming && (
                      <button onClick={() => startRename(a.id, a.label)} className="rounded-lg border border-border px-3 py-1.5 text-xs">
                        Rename
                      </button>
                    )}
                    <button onClick={() => startEditSecrets(a.id, a.type)} className="rounded-lg border border-border px-3 py-1.5 text-xs">
                      Edit
                    </button>
                    <button onClick={() => removeAccount(a.id)} className="rounded-lg border border-border px-3 py-1.5 text-xs text-red-600">
                      Remove
                    </button>
                  </div>
                </div>

                {isEditing && (
                  <div className="rounded-lg border border-border bg-card p-3">
                    {a.type === "deriv" ? (
                      <>
                        <label className="block text-xs mb-1">New Deriv API Token</label>
                        <input
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-2"
                          value={editToken}
                          onChange={(e) => setEditToken(e.target.value)}
                          placeholder="Enter new token"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => submitEditSecrets(a.id, a.type)}
                            className="rounded-lg bg-ysbPurple px-3 py-2 text-sm font-semibold text-ysbYellow"
                          >
                            Save
                          </button>
                          <button onClick={cancelEditSecrets} className="rounded-lg border border-border px-3 py-2 text-sm">
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="grid gap-2 md:grid-cols-3">
                          <div>
                            <label className="block text-xs mb-1">Server</label>
                            <input
                              className="w-full rounded-lg border border-border bg-background px-3 py-2"
                              value={editServer}
                              onChange={(e) => setEditServer(e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="block text-xs mb-1">Login</label>
                            <input
                              className="w-full rounded-lg border border-border bg-background px-3 py-2"
                              value={editLogin}
                              onChange={(e) => setEditLogin(e.target.value)}
                            />
                          </div>
                          <div>
                            <label className="block text-xs mb-1">Password</label>
                            <input
                              className="w-full rounded-lg border border-border bg-background px-3 py-2"
                              value={editPassword}
                              onChange={(e) => setEditPassword(e.target.value)}
                              type="password"
                            />
                          </div>
                        </div>
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => submitEditSecrets(a.id, a.type)}
                            className="rounded-lg bg-ysbPurple px-3 py-2 text-sm font-semibold text-ysbYellow"
                          >
                            Save
                          </button>
                          <button onClick={cancelEditSecrets} className="rounded-lg border border-border px-3 py-2 text-sm">
                            Cancel
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="text-right text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString()}</div>
              </div>
            );
          })}

          {(accounts ?? []).length === 0 ? <div className="text-sm text-muted-foreground">No accounts yet.</div> : null}
        </div>
      </div>
    </div>
  );
}