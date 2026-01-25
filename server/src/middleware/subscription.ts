import type { Response, NextFunction } from "express";
import type { AuthedRequest } from "./auth";
import { supabaseAdmin } from "../supabase";

export async function requireProForPaperLive(req: AuthedRequest, res: Response, next: NextFunction) {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("plan,status")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: "Subscription lookup failed" });
  const plan = (data?.plan ?? "free") as string;
  const status = (data?.status ?? "inactive") as string;

  const mode = String((req.body?.mode ?? "") || (req.body?.configs?.[0]?.mode ?? ""));

  const isPaperLive = mode === "paper" || mode === "live";
  const ok = plan === "pro" && status === "active";

  if (isPaperLive && !ok) return res.status(402).json({ error: "Pro plan required for paper/live trading" });
  next();
}
