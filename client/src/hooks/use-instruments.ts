import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { apiFetch } from "@/lib/api";

export function useInstruments() {
  return useQuery({
    queryKey: [api.instruments.list.path],
    queryFn: async () => {
      const res = await apiFetch(api.instruments.list.path);
      return api.instruments.list.responses[200].parse(await res.json());
    },
    staleTime: 60_000,
  });
}
