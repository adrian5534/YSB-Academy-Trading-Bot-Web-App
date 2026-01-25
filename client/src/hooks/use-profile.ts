import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export type Profile = {
  id: string;
  role: string | null;
};

export function useProfile(userId: string | null | undefined): {
  profile: Profile | null;
  loading: boolean;
  error: string | null;
} {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState<boolean>(!!userId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) {
      setProfile(null);
      setLoading(false);
      setError(null);
      return;
    }

    let alive = true;
    setLoading(true);

    supabase
      .from("profiles")
      .select("id, role")
      .eq("id", userId)
      .single()
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) {
          setProfile(null);
          setError(error.message);
          setLoading(false);
        } else {
          setProfile(data as Profile);
          setError(null);
          setLoading(false);
        }
      }, (e) => {
        if (!alive) return;
        setProfile(null);
        setError(String(e?.message ?? e));
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [userId]);

  return { profile, loading, error };
}