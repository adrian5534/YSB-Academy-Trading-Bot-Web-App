import { supabaseAdmin } from "../supabase";

export type RiskRules = {
  risk_type: "fixed_stake" | "percent_balance";
  fixed_stake: number;
  percent_risk: number;

  /**
   * Max realized loss since UTC day start.
   * Set to 0 (or less) to disable this rule.
   */
  max_daily_loss: number;

  max_drawdown: number;
  max_open_trades: number;

  adaptive_enabled: boolean;
  adaptive_min_percent: number;
  adaptive_max_percent: number;
  adaptive_step: number;
  adaptive_lookback: number;
};

const DEFAULT_RULES = {
  risk_type: "fixed_stake" as const,
  fixed_stake: 1,
  percent_risk: 1,
  max_daily_loss: 50,
  max_drawdown: 200,

  // ✅ was 3 (global cap). Set to 0 to disable by default.
  max_open_trades: 0,

  adaptive_enabled: false,
  adaptive_min_percent: 0.25,
  adaptive_max_percent: 2,
  adaptive_step: 0.25,
  adaptive_lookback: 25,
};

const toNum = (v: unknown, fallback: number) => {
  // ✅ treat null/undefined/empty as missing (use fallback)
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export async function getRiskRules(userId: string): Promise<RiskRules> {
  const { data, error } = await supabaseAdmin.from("risk_rules").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;

  const raw: any = data ?? { user_id: userId, ...DEFAULT_RULES };

  // normalize numeric fields to avoid NaN/strings coming from DB or migrations
  const normalized: RiskRules = {
    risk_type: raw.risk_type === "percent_balance" ? "percent_balance" : "fixed_stake",
    fixed_stake: toNum(raw.fixed_stake, DEFAULT_RULES.fixed_stake),
    percent_risk: toNum(raw.percent_risk, DEFAULT_RULES.percent_risk),
    max_daily_loss: toNum(raw.max_daily_loss, DEFAULT_RULES.max_daily_loss),
    max_drawdown: toNum(raw.max_drawdown, DEFAULT_RULES.max_drawdown),
    max_open_trades: Math.max(0, Math.floor(toNum(raw.max_open_trades, DEFAULT_RULES.max_open_trades))),
    adaptive_enabled: Boolean(raw.adaptive_enabled),
    adaptive_min_percent: toNum(raw.adaptive_min_percent, DEFAULT_RULES.adaptive_min_percent),
    adaptive_max_percent: toNum(raw.adaptive_max_percent, DEFAULT_RULES.adaptive_max_percent),
    adaptive_step: toNum(raw.adaptive_step, DEFAULT_RULES.adaptive_step),
    adaptive_lookback: Math.max(1, Math.floor(toNum(raw.adaptive_lookback, DEFAULT_RULES.adaptive_lookback))),
  };

  return normalized;
}

type CanOpenTradeOptions = {
  /**
   * Per-bot override (e.g. from cfg.params.max_open_trades).
   * If run_id is provided, this is enforced per run_id.
   */
  max_open_trades?: number;

  /**
   * Bot/run identifier. When provided, open trade count is filtered by trades.meta.run_id.
   * (Requires BotManager to store meta.run_id on trade inserts.)
   */
  run_id?: string;
};

const toFiniteNumberOrUndefined = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export async function canOpenTrade(args: {
  userId: string;
  opts: CanOpenTradeOptions;
}): Promise<{ ok: boolean; reason?: string }> {
  const { userId } = args;

  const rules = await getRiskRules(userId);

  // realized PnL since UTC day start
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const { data: trades, error: tradesError } = await supabaseAdmin
    .from("trades")
    .select("profit,opened_at,closed_at")
    .eq("user_id", userId)
    .gte("opened_at", today.toISOString());

  if (tradesError) throw tradesError;

  const realized = (trades ?? []).reduce((sum: number, t: any): number => sum + toNum(t?.profit, 0), 0);

  // ✅ If max_daily_loss <= 0, treat it as disabled
  if (toNum(rules.max_daily_loss, 0) > 0 && -realized >= rules.max_daily_loss) {
    return { ok: false, reason: "max daily loss reached" };
  }

  // Count total open trades (global safety cap)
  const { count: totalOpen, error: totalCountError } = await supabaseAdmin
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("closed_at", null);

  if (totalCountError) throw totalCountError;

  const globalLimit = toFiniteNumberOrUndefined((rules as any)?.max_open_trades);
  if (typeof globalLimit === "number" && globalLimit > 0) {
    if ((totalOpen ?? 0) >= globalLimit) return { ok: false, reason: "max open trades reached" };
  }

  // Per-bot (run) cap (lets other bots open trades)
  const override = toFiniteNumberOrUndefined(args.opts.max_open_trades);
  const runId = String(args.opts.run_id ?? "").trim();

  // If no per-bot override is provided, allow.
  if (!(typeof override === "number" && override > 0)) {
    return { ok: true };
  }

  // Enforce PER-BOT (run_id) cap only.
  // If run_id is missing, we do NOT apply any cap (so it stays per-bot only).
  if (!runId) {
    return { ok: true };
  }

  const { count: runOpen, error: runCountError } = await supabaseAdmin
    .from("trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("closed_at", null)
    .contains("meta", { run_id: runId });

  if (runCountError) throw runCountError;

  if ((runOpen ?? 0) >= override) return { ok: false, reason: "max open trades reached" };

  return { ok: true };
}

export function computeStake(rules: RiskRules, balance: number): number {
  if (rules.risk_type === "fixed_stake") return Math.max(0, toNum(rules.fixed_stake, 0));
  const pct = Math.max(0, toNum(rules.percent_risk, 0)) / 100;
  return Math.max(0, toNum(balance, 0) * pct);
}