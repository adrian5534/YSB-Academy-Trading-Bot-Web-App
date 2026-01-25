import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

export default function Admin() {
  const { toast } = useToast();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    apiFetch("/api/admin/overview")
      .then((r) => r.json())
      .then(setData)
      .catch((e) => toast({ title: "Admin error", description: String(e.message ?? e), variant: "destructive" }));
  }, [toast]);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-2xl font-semibold">Admin</div>
        <div className="text-sm text-muted-foreground">Visible only to admin role (server enforced).</div>
      </div>

      <pre className="overflow-auto rounded-2xl border border-border bg-card p-4 text-xs text-muted-foreground">
{JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
