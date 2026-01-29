import { useSubscription } from "@/hooks/use-subscription";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import { Link } from "wouter";

type PlanKey = "1m" | "2m" | "3m";

const plans: { key: PlanKey; label: string; price: string; subtitle: string }[] = [
  { key: "1m", label: "Pro Monthly", price: "$50", subtitle: "Billed every month" },
  { key: "2m", label: "Pro 2 Months", price: "$100", subtitle: "Billed every 2 months" },
  { key: "3m", label: "Pro 3 Months", price: "$150", subtitle: "Billed every 3 months" },
];

export default function Plans() {
  const { toast } = useToast();
  const { data: sub } = useSubscription();

  const checkout = async (plan: PlanKey) => {
    try {
      const res = await apiFetch("/api/stripe/create-checkout", {
        method: "POST",
        body: JSON.stringify({ plan, return_url: window.location.origin + "/bot" }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.url) window.location.href = j.url;
      else throw new Error("No checkout URL returned");
    } catch (e: any) {
      toast({ title: "Checkout error", description: String(e?.message ?? e), variant: "destructive" });
    }
  };

  return (
    <div className="mx-auto max-w-5xl py-10 px-4 space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">Choose your plan</h1>
        <p className="text-muted-foreground">
          Current plan: <span className="text-foreground">{sub?.plan ?? "free"}</span>
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((p) => (
          <div key={p.key} className="rounded-2xl border border-border bg-card p-6 space-y-4">
            <div className="space-y-1">
              <div className="text-lg font-semibold">{p.label}</div>
              <div className="text-3xl font-bold">{p.price}</div>
              <div className="text-sm text-muted-foreground">{p.subtitle}</div>
            </div>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>• Paper & Live trading</li>
              <li>• Full strategy library</li>
              <li>• Billing portal access</li>
            </ul>
            <button
              onClick={() => checkout(p.key)}
              className="w-full rounded-lg bg-ysbPurple px-3 py-2 font-semibold text-ysbYellow hover:opacity-90"
            >
              Choose {p.label}
            </button>
          </div>
        ))}
      </div>

      <div className="text-sm text-muted-foreground">
        Need to manage your subscription?{" "}
        <button
          className="underline underline-offset-4"
          onClick={async () => {
            try {
              const res = await apiFetch("/api/stripe/portal", {
                method: "POST",
                body: JSON.stringify({ return_url: window.location.href }),
              });
              const j = await res.json().catch(() => ({}));
              if (j?.url) window.location.href = j.url;
            } catch {
              /* noop */
            }
          }}
        >
          Open billing portal
        </button>{" "}
        or <Link href="/bot" className="underline underline-offset-4">go back</Link>.
      </div>
    </div>
  );
}