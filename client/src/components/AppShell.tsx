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
import { useEffect, useState } from "react";

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

  const [drawerOpen, setDrawerOpen] = useState(false);

  const isAdmin = profile?.role === "admin";
  const items = isAdmin ? nav : nav.filter((n) => n.href !== "/admin");

  // Close drawer on route change
  useEffect(() => {
    setDrawerOpen(false);
  }, [loc]);

  // Escape closes drawer
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  // ✅ Prevent background scroll + layout artifacts while drawer is open
  useEffect(() => {
    document.body.classList.toggle("drawer-open", drawerOpen);
    return () => document.body.classList.remove("drawer-open");
  }, [drawerOpen]);

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
      await signOutLocal();
    }
  };

  const NavContent = ({ onNavigate }: { onNavigate?: () => void }) => (
    <>
      <nav className="app-shell__nav">
        {items.map((n) => {
          const active = loc === n.href;
          const Icon = n.icon;
          return (
            <Link key={n.href} href={n.href}>
              <a
                onClick={onNavigate}
                className={cn(
                  "app-shell__navItem",
                  "rounded-lg px-3 py-2 text-sm hover:bg-muted/40",
                  active ? "bg-muted/60" : ""
                )}
              >
                <span className="inline-flex items-center gap-2">
                  <Icon size={16} className={active ? "text-ysbYellow" : "text-muted-foreground"} />
                  {active ? (
                    <motion.span layoutId="nav" className="text-foreground whitespace-nowrap">
                      {n.label}
                    </motion.span>
                  ) : (
                    <span className="text-muted-foreground whitespace-nowrap">{n.label}</span>
                  )}
                </span>
              </a>
            </Link>
          );
        })}
      </nav>

      <div className="app-shell__actions">
        <button
          onClick={() => void signOutLocal()}
          className="w-full rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Sign out
        </button>

        <button
          onClick={() => void signOutEverywhere()}
          className="w-full rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Sign out everywhere
        </button>
      </div>
    </>
  );

  return (
    <div className="app-shell">
      {/* Mobile topbar */}
      <header className="app-shell__topbar border-border bg-card">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-ysbPurple grid place-items-center text-ysbYellow font-bold">Y</div>
          <div className="leading-tight">
            <div className="font-semibold">YSB Academy</div>
            <div className="text-xs text-muted-foreground">Trading Bot</div>
          </div>
        </div>

        <button
          type="button"
          className="app-shell__hamburger"
          aria-label={drawerOpen ? "Close menu" : "Open menu"}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen((v) => !v)}
        >
          <span className="app-shell__hamburgerLines" aria-hidden="true" />
        </button>
      </header>

      {/* Desktop sidebar */}
      <aside className="app-shell__aside border-border bg-card">
        <div className="app-shell__header">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-ysbPurple grid place-items-center text-ysbYellow font-bold">Y</div>
            <div className="leading-tight">
              <div className="font-semibold">YSB Academy</div>
              <div className="text-xs text-muted-foreground">Trading Bot</div>
            </div>
          </div>
        </div>

        <NavContent />
      </aside>

      {/* Mobile drawer */}
      <div
        className={cn("app-shell__drawerOverlay", drawerOpen ? "is-open" : "")}
        onClick={() => setDrawerOpen(false)}
      />
      <div className={cn("app-shell__drawer", drawerOpen ? "is-open" : "")} role="dialog" aria-modal="true">
        <div className="app-shell__drawerHeader">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-ysbPurple grid place-items-center text-ysbYellow font-bold">Y</div>
            <div className="leading-tight">
              <div className="font-semibold">YSB Academy</div>
              <div className="text-xs text-muted-foreground">Trading Bot</div>
            </div>
          </div>

          <button
            type="button"
            className="app-shell__drawerClose"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="app-shell__drawerBody">
          <NavContent onNavigate={() => setDrawerOpen(false)} />
        </div>
      </div>

      <main className="app-shell__main">{children}</main>
    </div>
  );
}