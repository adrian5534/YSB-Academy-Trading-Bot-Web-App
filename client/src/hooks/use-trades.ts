import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { apiFetch } from "@/lib/api";

export function useTrades() {
  return useQuery({
    queryKey: [api.trades.list.path],
    queryFn: async () => {
      const res = await apiFetch(api.trades.list.path);
      return api.trades.list.responses[200].parse(await res.json());
    },
    refetchInterval: 4000,
  });
}

export function useTradeStats() {
  return useQuery({
    queryKey: [api.trades.stats.path],
    queryFn: async () => {
      const res = await apiFetch(api.trades.stats.path);
      return api.trades.stats.responses[200].parse(await res.json());
    },
    refetchInterval: 8000,
  });
}
