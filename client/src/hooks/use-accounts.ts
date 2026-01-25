import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { apiFetch } from "@/lib/api";

export function useAccounts() {
  return useQuery({
    queryKey: [api.accounts.list.path],
    queryFn: async () => {
      const res = await apiFetch(api.accounts.list.path);
      return api.accounts.list.responses[200].parse(await res.json());
    },
  });
}

export function useUpsertDerivAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: unknown) => {
      const payload = api.accounts.upsertDeriv.input.parse(data);
      const res = await apiFetch(api.accounts.upsertDeriv.path, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return api.accounts.upsertDeriv.responses[200].parse(await res.json());
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [api.accounts.list.path] });
    },
  });
}

export function useUpsertMt5Account() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: unknown) => {
      const payload = api.accounts.upsertMt5.input.parse(data);
      const res = await apiFetch(api.accounts.upsertMt5.path, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      return api.accounts.upsertMt5.responses[200].parse(await res.json());
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [api.accounts.list.path] });
    },
  });
}
