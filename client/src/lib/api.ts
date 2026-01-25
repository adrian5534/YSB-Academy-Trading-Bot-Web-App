import { supabase } from "./supabase";

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token;
  const headers = new Headers(init?.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init?.body && !(init?.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(input, { ...init, headers });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${msg}`);
  }
  return res;
}
