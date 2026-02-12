import { api } from "@shared/routes";
import { apiFetch } from "@/lib/api";
import { useMutation, useQuery } from "@tanstack/react-query";

export function useBotStatus() {
  return useQuery({
    queryKey: [api.bots.status.path],
    queryFn: async () => {
      const res = await apiFetch(api.bots.status.path);
      return api.bots.status.responses[200].parse(await res.json());
    },
    refetchInterval: 5000,
  });
}

export function useStartBot() {
  return useMutation({
    mutationFn: async (body: {
      name: string;
      run_id?: string;
      configs: Array<{
        account_id: string;
        symbol: string;
        timeframe: string;
        strategy_id: string;
        mode: "backtest" | "paper" | "live";
        params: Record<string, any>;
        enabled: boolean;
      }>;
    }) => {
      await apiFetch(api.bots.start.path, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
  });
}

export function useStopBot() {
  return useMutation({
    mutationFn: async (payload?: { run_id?: string; name?: string }) => {
      await apiFetch(api.bots.stop.path, {
        method: "POST",
        body: JSON.stringify(payload ?? {}),
      });
    },
  });
}
