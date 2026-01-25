import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { supabase } from "@/lib/supabase";
import { useToast } from "../hooks/use-toast";

type Mode = "login" | "signup";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export default function AuthPage() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const emailNorm = useMemo(() => normalizeEmail(email), [email]);

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email: emailNorm, password });
        if (error) throw error;

        setLocation("/"); // ✅ important
        return;
      }

      const origin = window.location.origin;
      const { error } = await supabase.auth.signUp({
        email: emailNorm,
        password,
        options: { emailRedirectTo: `${origin}/` },
      });
      if (error) throw error;

      toast({ title: "Account created", description: "You can now log in." });
      setMode("login");
    } catch (e: any) {
      toast({ title: "Auth error", description: String(e?.message ?? e), variant: "destructive" });
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
          type="email"
          autoComplete="email"
        />

        <label className="block text-sm mb-1">Password</label>
        <input
          className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-4"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
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
          type="button"
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