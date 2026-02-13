import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export type AccountBalanceRow = {
  id: string;
  type: string; // "deriv" | "mt5" | ...
  label: string | null;
  balance: number | null;
  currency?: string;
};

export function useAccountBalances() {
  return useQuery({
    queryKey: ["/api/accounts/balances"],
    queryFn: async (): Promise<AccountBalanceRow[]> => {
      const res = await apiFetch("/api/accounts/balances");
      if (!res.ok) throw new Error(`balances fetch failed (${res.status})`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    refetchInterval: 15000,
  });
}