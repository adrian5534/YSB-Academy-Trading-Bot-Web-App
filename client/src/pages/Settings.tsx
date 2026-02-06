import { useToast } from "@/hooks/use-toast";
import { useSubscription } from "@/hooks/use-subscription";
import { api } from "@shared/routes";
import { apiFetch } from "@/lib/api";

export default function Settings() {
  const { toast } = useToast();
  const { data: sub } = useSubscription();

  const manageBilling = async () => {
    try {
      const res = await apiFetch("/api/stripe/portal", {
        method: "POST",
        body: JSON.stringify({ return_url: window.location.href }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.url) window.open(j.url, "_blank");
      else throw new Error("No portal URL returned");
    } catch (e: any) {
      toast({ title: "Billing portal error", description: String(e?.message ?? e), variant: "destructive" });
    }
  };

  const upgrade = async () => {
    try {
      const res = await apiFetch(api.stripe.createCheckout.path, {
        method: "POST",
        body: JSON.stringify({ return_url: window.location.href }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.url) window.open(j.url, "_blank");
      else throw new Error("No checkout URL returned");
    } catch (e: any) {
      toast({ title: "Checkout error", description: String(e?.message ?? e), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="text-2xl font-semibold">Account Settings</div>
        <div className="text-sm text-muted-foreground">Manage your profile and subscription.</div>
      </div>

      <div className="grid gap-4 max-w-3xl">
        <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
          <div className="font-semibold">Subscription</div>
          <div className="text-sm text-muted-foreground">
            Current plan: <span className="text-foreground font-medium">{sub?.plan ?? "free"}</span>
          </div>
          <div className="flex items-center gap-2">
            {sub?.plan !== "pro" ? (
              <button onClick={upgrade} className="rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow hover:opacity-90">
                Upgrade to Pro
              </button>
            ) : (
              <button onClick={manageBilling} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted">
                Manage billing
              </button>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
          <div className="font-semibold">Profile</div>
          <div className="text-sm text-muted-foreground">
            Email/phone/password updates are handled via your sign‑in provider.
          </div>
          <div className="text-sm text-muted-foreground">Use “Manage billing” to update payment details.</div>
        </div>
      </div>
    </div>
  );
}