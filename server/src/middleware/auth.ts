import type { Request, Response, NextFunction } from "express";
import { supabaseAnon } from "../supabase";

export type AuthedRequest = Request & { user: { id: string; email: string | null } };

export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid token" });

  (req as AuthedRequest).user = { id: data.user.id, email: data.user.email ?? null };
  next();
}
