import { Link, useLocation } from "wouter";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  KeyRound,
  Layers,
  ListChecks,
  Bot,
  FlaskConical,
  NotebookText,
  Settings,
  Shield,
  Crown,
} from "lucide-react";
import { motion } from "framer-motion";
import { useSession } from "@/hooks/use-auth";
import { useProfile } from "@/hooks/use-profile";
import { useToast } from "@/hooks/use-toast";

const nav = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/accounts", label: "Accounts", icon: KeyRound },
  { href: "/instruments", label: "Instruments", icon: Layers },
  { href: "/strategies", label: "Strategies", icon: ListChecks },
  { href: "/bot", label: "Bot Control", icon: Bot },
  { href: "/backtesting", label: "Backtesting", icon: FlaskConical },
  { href: "/trades", label: "Trades & Journal", icon: NotebookText },
  { href: "/plans", label: "Plans", icon: Crown },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/admin", label: "Admin", icon: Shield },
];

function apiBase(): string {
  return (import.meta as any).env?.VITE_API_BASE_URL ?? "";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [loc, setLocation] = useLocation();
  const { session } = useSession();
  const { profile } = useProfile(session?.user?.id);
  const { toast } = useToast();

  const isAdmin = profile?.role === "admin";
  const items = isAdmin ? nav : nav.filter((n) => n.href !== "/admin");

  const signOutLocal = async () => {
    await supabase.auth.signOut({ scope: "local" });

    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("sb-") && key.endsWith("-auth-token")) {
        localStorage.removeItem(key);
      }
    }

    setLocation("/auth");
  };

  const signOutEverywhere = async () => {
    const ok = window.confirm("Sign out everywhere? This revokes all sessions on all devices.");
    if (!ok) return;

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;

      if (!token) {
        await signOutLocal();
        return;
      }

      const res = await fetch(`${apiBase()}/api/auth/logout-all`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`logout-all failed (${res.status}): ${text || "unknown error"}`);
      }

      await signOutLocal();
    } catch (e: any) {
      toast({
        title: "Logout error",
        description: String(e?.message ?? e),
        variant: "destructive",
      });
      await signOutLocal(); // still get user out locally
    }
  };

  return (
    <div className="min-h-screen grid grid-cols-[260px_1fr]">
      <aside className="border-r border-border bg-card p-4">
        <div className="flex items-center gap-2 mb-6">
          <div className="h-9 w-9 rounded-lg bg-ysbPurple grid place-items-center text-ysbYellow font-bold">Y</div>
          <div>
            <div className="font-semibold">YSB Academy</div>
            <div className="text-xs text-muted-foreground">Trading Bot</div>
          </div>
        </div>

        <nav className="space-y-1">
          {items.map((n) => {
            const active = loc === n.href;
            const Icon = n.icon;
            return (
              <Link key={n.href} href={n.href}>
                <a className={cn("block rounded-lg px-3 py-2 text-sm hover:bg-muted/40", active ? "bg-muted/60" : "")}>
                  <span className="inline-flex items-center gap-2">
                    <Icon size={16} className={active ? "text-ysbYellow" : "text-muted-foreground"} />
                    {active ? (
                      <motion.span layoutId="nav" className="text-foreground">
                        {n.label}
                      </motion.span>
                    ) : (
                      <span className="text-muted-foreground">{n.label}</span>
                    )}
                  </span>
                </a>
              </Link>
            );
          })}
        </nav>

        <button
          onClick={() => void signOutLocal()}
          className="mt-6 w-full rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Sign out
        </button>

        <button
          onClick={() => void signOutEverywhere()}
          className="mt-2 w-full rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Sign out everywhere
        </button>

        <div className="mt-6 text-xs text-muted-foreground">
          Brand: <span className="text-ysbPurple">#6F2898</span> / <span className="text-ysbYellow">#f3ec4e</span>
        </div>
      </aside>

      <main className="p-6">{children}</main>
    </div>
  );
}