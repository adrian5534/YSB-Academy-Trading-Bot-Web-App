import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { apiFetch } from "@/lib/api";

export function useSubscription() {
  return useQuery({
    queryKey: [api.auth.subscription.path],
    queryFn: async () => {
      const res = await apiFetch(api.auth.subscription.path);
      return api.auth.subscription.responses[200].parse(await res.json());
    },
    staleTime: 10_000,
  });
}
