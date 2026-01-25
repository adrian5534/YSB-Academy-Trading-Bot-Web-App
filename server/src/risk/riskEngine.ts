import { supabaseAdmin } from "../supabase";

export type RiskRules = {
  risk_type: "fixed_stake" | "percent_balance";
  fixed_stake: number;
  percent_risk: number;
  max_daily_loss: number;
  max_drawdown: number;
  max_open_trades: number;
  adaptive_enabled: boolean;
  adaptive_min_percent: number;
  adaptive_max_percent: number;
  adaptive_step: number;
  adaptive_lookback: number;
};

export async function getRiskRules(userId: string): Promise<RiskRules> {
  const { data, error } = await supabaseAdmin.from("risk_rules").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return (data ?? {
    user_id: userId,
    risk_type: "fixed_stake",
    fixed_stake: 1,
    percent_risk: 1,
    max_daily_loss: 50,
    max_drawdown: 200,
    max_open_trades: 3,
    adaptive_enabled: false,
    adaptive_min_percent: 0.25,
    adaptive_max_percent: 2,
    adaptive_step: 0.25,
    adaptive_lookback: 25,
  }) as any;
}

export async function canOpenTrade(userId: string): Promise<{ ok: boolean; reason?: string }> {
  const rules = await getRiskRules(userId);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const { data: trades, error } = await supabaseAdmin
    .from("trades")
    .select("profit,opened_at,closed_at")
    .eq("user_id", userId)
    .gte("opened_at", today.toISOString());

  if (error) throw error;

  const realized = (trades ?? []).reduce((sum, t: any) => sum + (t.profit ?? 0), 0);
  if (-realized >= rules.max_daily_loss) return { ok: false, reason: "max daily loss reached" };

  const { count, error: e2 } = await supabaseAdmin
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("closed_at", null);

  if (e2) throw e2;
  if ((count ?? 0) >= rules.max_open_trades) return { ok: false, reason: "max open trades reached" };

  return { ok: true };
}

export function computeStake(rules: RiskRules, balance: number): number {
  if (rules.risk_type === "fixed_stake") return Math.max(0, rules.fixed_stake);
  const pct = Math.max(0, rules.percent_risk) / 100;
  return Math.max(0, balance * pct);
}
