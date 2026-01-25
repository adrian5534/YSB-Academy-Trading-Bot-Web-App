import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";

export default function AuthPage() {
  const { toast } = useToast();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        toast({ title: "Check your email", description: "Confirm your account then log in." });
      }
    } catch (e: any) {
      toast({ title: "Auth error", description: String(e.message ?? e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow">
        <div className="text-2xl font-semibold">YSB Academy</div>
        <div className="text-sm text-muted-foreground mb-6">Trading Bot Web App</div>

        <label className="block text-sm mb-1">Email</label>
        <input
          className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-3"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <label className="block text-sm mb-1">Password</label>
        <input
          className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-4"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />

        <button
          disabled={busy}
          onClick={submit}
          className="w-full rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
        </button>

        <button
          className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setMode((m) => (m === "login" ? "signup" : "login"))}
        >
          {mode === "login" ? "Need an account? Sign up" : "Have an account? Log in"}
        </button>

        <div className="mt-5 text-xs text-muted-foreground">
          OAuth-ready: configure providers in Supabase Auth settings.
        </div>
      </div>
    </div>
  );
}
