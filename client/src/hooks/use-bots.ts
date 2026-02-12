import { api } from "@shared/routes";
import { apiFetch } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const BOT_STATUS_QUERY_KEY = [api.bots.status.path] as const;

export function useBotStatus() {
  return useQuery({
    queryKey: BOT_STATUS_QUERY_KEY,
    queryFn: async () => {
      const res = await apiFetch(api.bots.status.path);
      return api.bots.status.responses[200].parse(await res.json());
    },
    refetchInterval: 5000,
  });
}

export function useStartBot() {
  const qc = useQueryClient();
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: BOT_STATUS_QUERY_KEY });
    },
  });
}

export function useStopBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload?: { run_id?: string; name?: string }) => {
      await apiFetch(api.bots.stop.path, {
        method: "POST",
        body: JSON.stringify(payload ?? {}),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: BOT_STATUS_QUERY_KEY });
    },
  });
}