import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { apiFetch } from "@/lib/api";

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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: unknown) => {
      const payload = api.bots.start.input.parse(data);
      const res = await apiFetch(api.bots.start.path, { method: "POST", body: JSON.stringify(payload) });
      return api.bots.start.responses[200].parse(await res.json());
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [api.bots.status.path] });
    },
  });
}

export function useStopBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch(api.bots.stop.path, { method: "POST" });
      return api.bots.stop.responses[200].parse(await res.json());
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [api.bots.status.path] });
    },
  });
}
