import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export function Toaster() {
  const { toasts, dismiss } = useToast();

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2">
      {toasts
        .filter((t) => t.open !== false)
        .map((t) => (
          <div
            key={t.id}
            className={cn(
              "w-80 rounded-lg border border-border bg-card p-3 shadow",
              t.variant === "destructive" ? "border-red-500" : "",
            )}
            role="status"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                {t.title ? <div className="font-semibold">{t.title}</div> : null}
                {t.description ? <div className="text-sm text-muted-foreground">{t.description}</div> : null}
              </div>

              <button
                type="button"
                aria-label="Close toast"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => dismiss(t.id)}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}