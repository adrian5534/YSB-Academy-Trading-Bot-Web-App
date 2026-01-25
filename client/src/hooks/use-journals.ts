import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { apiFetch } from "@/lib/api";

export function useJournals() {
  return useQuery({
    queryKey: [api.journals.list.path],
    queryFn: async () => {
      const res = await apiFetch(api.journals.list.path);
      return api.journals.list.responses[200].parse(await res.json());
    },
  });
}

export function useCreateJournal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: unknown) => {
      const payload = api.journals.create.input.parse(data);
      const res = await apiFetch(api.journals.create.path, { method: "POST", body: JSON.stringify(payload) });
      return api.journals.create.responses[200].parse(await res.json());
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [api.journals.list.path] });
    },
  });
}

export async function getSignedUrl(path: string) {
  const payload = api.journals.signedUrl.input.parse({ path });
  const res = await apiFetch(api.journals.signedUrl.path, { method: "POST", body: JSON.stringify(payload) });
  return api.journals.signedUrl.responses[200].parse(await res.json()).url;
}
