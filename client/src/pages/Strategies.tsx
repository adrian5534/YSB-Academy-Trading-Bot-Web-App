import { useEffect, useState } from "react";
import { api } from "@shared/routes";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

type Strategy = ReturnType<typeof api.strategies.list.responses[200]["parse"]>[number];

export default function Strategies() {
  const { toast } = useToast();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch(api.strategies.list.path)
      .then((r) => r.json())
      .then((d) => setStrategies(api.strategies.list.responses[200].parse(d)))
      .catch((e) => toast({ title: "Error", description: String(e.message ?? e), variant: "destructive" }))
      .finally(() => setLoading(false));
  }, [toast]);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-2xl font-semibold">Strategies</div>
        <div className="text-sm text-muted-foreground">Executable server modules with Zod params.</div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        {loading ? <div className="text-muted-foreground">Loading…</div> : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {strategies.map((s) => (
            <div key={s.id} className="rounded-xl border border-border bg-background p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold">{s.name}</div>
                <div className="text-xs text-muted-foreground">{s.id}</div>
              </div>
              <div className="text-sm text-muted-foreground mt-2">{s.description}</div>
              <div className="mt-3 text-xs text-muted-foreground">Default params:</div>
              <pre className="mt-1 overflow-auto rounded-lg border border-border bg-card p-2 text-xs text-muted-foreground">
{JSON.stringify(s.default_params, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">
        Strategy enabling per instrument/timeframe is managed from <span className="text-foreground">Bot Control</span>.
      </div>
    </div>
  );
}
