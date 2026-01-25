import * as React from "react";

export type Toast = { id: string; title?: string; description?: string; variant?: "default" | "destructive" };

type State = { toasts: Toast[] };
type Action =
  | { type: "ADD"; toast: Toast }
  | { type: "DISMISS"; id: string };

const ToastContext = React.createContext<{
  state: State;
  addToast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: string) => void;
} | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<State>({ toasts: [] });

  const addToast = (t: Omit<Toast, "id">) => {
    const toast = { ...t, id: crypto.randomUUID() };
    setState((s) => ({ toasts: [toast, ...s.toasts].slice(0, 3) }));
    setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== toast.id) })), 3500);
  };

  const dismiss = (id: string) => setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));

  return <ToastContext.Provider value={{ state, addToast, dismiss }}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("ToastProvider missing");
  return {
    toast: (t: Omit<Toast, "id">) => ctx.addToast(t),
    dismiss: ctx.dismiss,
    toasts: ctx.state.toasts,
  };
}
