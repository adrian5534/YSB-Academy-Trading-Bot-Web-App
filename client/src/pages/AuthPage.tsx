// client/src/pages/AuthPage.tsx
import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";

type Mode = "login" | "signup";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export default function AuthPage() {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const emailNorm = useMemo(() => normalizeEmail(email), [email]);

  const submit = async () => {
    setBusy(true);
    try {
      const origin = window.location.origin;

      if (mode === "login") {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: emailNorm,
          password,
        });

        // ✅ This will show you the *real* reason in browser console
        // (Netlify build bakes env vars; if URL is wrong you’ll catch it here.)
        // eslint-disable-next-line no-console
        console.log("SUPABASE_URL (baked):", import.meta.env.VITE_SUPABASE_URL);
        // eslint-disable-next-line no-console
        console.log("SIGNIN_RESULT:", { data, error });

        if (error) throw error;

        toast({ title: "Logged in", description: "Welcome back." });
        return;
      }

      const { data, error } = await supabase.auth.signUp({
        email: emailNorm,
        password,
        options: {
          emailRedirectTo: `${origin}/`,
        },
      });

      // eslint-disable-next-line no-console
      console.log("SIGNUP_RESULT:", { data, error });

      if (error) throw error;

      toast({
        title: "Account created",
        description: "If email confirmation is enabled, check your inbox and confirm, then log in.",
      });

      setMode("login");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      toast({ title: "Auth error", description: msg, variant: "destructive" });
      // eslint-disable-next-line no-console
      console.error("AUTH_ERROR:", e);
    } finally {
      setBusy(false);
    }
  };

  const forgotPassword = async () => {
    setBusy(true);
    try {
      if (!emailNorm) {
        toast({ title: "Enter your email first", variant: "destructive" });
        return;
      }
      const origin = window.location.origin;
      const { error } = await supabase.auth.resetPasswordForEmail(emailNorm, {
        redirectTo: `${origin}/`,
      });
      if (error) throw error;
      toast({ title: "Password reset sent", description: "Check your email for the reset link." });
    } catch (e: any) {
      toast({ title: "Reset error", description: String(e?.message ?? e), variant: "destructive" });
      // eslint-disable-next-line no-console
      console.error("RESET_ERROR:", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center p-6">
      <form
        className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="text-2xl font-semibold">YSB Academy</div>
        <div className="text-sm text-muted-foreground mb-6">Trading Bot Web App</div>

        <label className="block text-sm mb-1">Email</label>
        <input
          className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-3"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />

        <label className="block text-sm mb-1">Password</label>
        <input
          className="w-full rounded-lg border border-border bg-background px-3 py-2 mb-4"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />

        <button
          disabled={busy}
          type="submit"
          className="w-full rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "…" : mode === "login" ? "Log in" : "Create account"}
        </button>

        {mode === "login" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void forgotPassword()}
            className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Forgot password?
          </button>
        ) : null}

        <button
          type="button"
          className="mt-3 w-full rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setMode((m) => (m === "login" ? "signup" : "login"))}
        >
          {mode === "login" ? "Need an account? Sign up" : "Have an account? Log in"}
        </button>

        <div className="mt-5 text-xs text-muted-foreground">
          OAuth-ready: configure providers in Supabase Auth settings.
        </div>
      </form>
    </div>
  );
}
