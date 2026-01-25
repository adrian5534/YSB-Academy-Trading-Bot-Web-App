import { Link, useLocation } from "wouter";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { LayoutDashboard, KeyRound, Layers, ListChecks, Bot, FlaskConical, NotebookText, Settings, Shield } from "lucide-react";
import { motion } from "framer-motion";

const nav = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/accounts", label: "Accounts", icon: KeyRound },
  { href: "/instruments", label: "Instruments", icon: Layers },
  { href: "/strategies", label: "Strategies", icon: ListChecks },
  { href: "/bot", label: "Bot Control", icon: Bot },
  { href: "/backtesting", label: "Backtesting", icon: FlaskConical },
  { href: "/trades", label: "Trades & Journal", icon: NotebookText },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/admin", label: "Admin", icon: Shield },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [loc] = useLocation();
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
          {nav.map((n) => {
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
          onClick={() => supabase.auth.signOut()}
          className="mt-6 w-full rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          Sign out
        </button>

        <div className="mt-6 text-xs text-muted-foreground">
          Brand: <span className="text-ysbPurple">#6F2898</span> / <span className="text-ysbYellow">#f3ec4e</span>
        </div>
      </aside>

      <main className="p-6">{children}</main>
    </div>
  );
}
