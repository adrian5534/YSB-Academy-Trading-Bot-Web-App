import express from "express";
import { api } from "../../shared/routes";
import { supabaseAdmin } from "./supabase";
import { requireUser, type AuthedRequest } from "./middleware/auth";
import { requireProForPaperLive } from "./middleware/subscription";
import { DerivClient } from "./deriv/DerivClient";
import { encryptJson, decryptJson } from "./crypto/secrets";
import { strategies } from "./strategies";
import { BotManager } from "./bots/BotManager";
import type { WsHub } from "./ws/hub";
import { parseCsv, runBacktest } from "./backtests/runBacktest";
import { requireStripe } from "./stripe/stripe";
import { env } from "./env";
import { z } from "zod";
import { randomUUID } from "node:crypto";

/**
 * Risk rules (global). Kept for backwards compatibility:
 * - Accepts older "fixed"/"percent" values
 * - Normalizes to "fixed_stake" | "percent_balance"
 */
const zRiskType = z
  .enum(["fixed", "fixed_stake", "percent", "percent_balance"])
  .default("fixed_stake")
  .transform((v) => (v === "fixed" ? "fixed_stake" : v === "percent" ? "percent_balance" : v));

const zRiskRules = z.object({
  risk_type: zRiskType,
  fixed_stake: z.number().nonnegative().default(1),
  percent_risk: z.number().min(0).max(100).default(1),
  max_daily_loss: z.number().min(0).default(0),
  max_drawdown: z.number().min(0).default(0),
  max_open_trades: z.number().int().min(0).default(1),
  adaptive_enabled: z.boolean().default(false),
  adaptive_min_percent: z.number().min(0).default(0),
  adaptive_max_percent: z.number().min(0).default(0),
  adaptive_step: z.number().min(0).default(1),
  adaptive_lookback: z.number().int().min(0).default(20),
});

type AnyFn = (req: any, res: any, next: any) => any;

function asyncRoute(fn: AnyFn) {
  return (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function ensureProfile(userId: string, email: string | null) {
  await supabaseAdmin.from("profiles").upsert({ id: userId, email }, { onConflict: "id" });
  await supabaseAdmin.from("subscriptions").upsert({ user_id: userId }, { onConflict: "user_id" });
  await supabaseAdmin.from("risk_rules").upsert({ user_id: userId }, { onConflict: "user_id" });
}

async function getRole(userId: string): Promise<"user" | "admin"> {
  const { data } = await supabaseAdmin.from("profiles").select("role").eq("id", userId).maybeSingle();
  return (data?.role ?? "user") as any;
}

function getOrigin(req: any) {
  const proto = (req.headers["x-forwarded-proto"] as string) || "http";
  const host = req.headers.host as string;
  return `${proto}://${host}`;
}

// Safely decrypt secrets to avoid crashes if key rotated or data corrupt
function safeDecrypt<T = any>(enc: unknown): T | null {
  try {
    return decryptJson(enc as string) as T;
  } catch {
    return null;
  }
}

// DerivClient compatibility: some versions expose `authorize()` not `validateToken()`
async function derivValidateToken(token: string): Promise<any> {
  const c = new DerivClient();

  const validateFn: undefined | ((t: string) => Promise<any>) =
    (c as any).validateToken?.bind(c) ??
    (c as any).authorizeToken?.bind(c) ??
    (c as any).authorize?.bind(c) ??
    (c as any).validate?.bind(c);

  if (!validateFn) {
    throw new Error("DerivClient missing validateToken/authorize/validate method");
  }

  try {
    if (typeof (c as any).connect === "function") {
      await (c as any).connect().catch(() => void 0);
    }
    const info = await validateFn(token);

    // Normalize authorize payloads if needed
    const a = (info as any)?.authorize ?? info;
    return {
      loginid: a?.loginid ?? a?.user_id ?? null,
      balance: a?.balance ?? null,
      currency: a?.currency ?? null,
      raw: info,
    };
  } finally {
    if (typeof (c as any).disconnect === "function") {
      await (c as any).disconnect().catch(() => void 0);
    }
  }
}

export function registerRoutes(app: express.Express, hub: WsHub) {
  const router = express.Router();
  const botManager = new BotManager(hub);

  // Health check (Render can ping this)
  router.get("/api/health", (_req, res) => res.json({ ok: true }));

  // Stripe debug ping
  router.get("/api/stripe/_ping", (_req, res) => res.json({ ok: true }));

  // ===== Auth =====
  router.get(
    api.auth.me.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      await ensureProfile(r.user.id, r.user.email);

      const { data } = await supabaseAdmin.from("profiles").select("*").eq("id", r.user.id).single();
      res.json(
        api.auth.me.responses[200].parse({
          id: data.id,
          email: data.email,
          role: data.role,
          created_at: data.created_at,
        }),
      );
    }),
  );

  router.get(
    api.auth.subscription.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      await ensureProfile(r.user.id, r.user.email);

      const { data } = await supabaseAdmin.from("subscriptions").select("*").eq("user_id", r.user.id).maybeSingle();
      res.json(
        api.auth.subscription.responses[200].parse({
          plan: data?.plan ?? "free",
          status: data?.status ?? "inactive",
          current_period_end: data?.current_period_end ? new Date(data.current_period_end).toISOString() : null,
        }),
      );
    }),
  );

  // Revoke ALL sessions (global logout)
  router.post(
    "/api/auth/logout-all",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const { error } = await supabaseAdmin.auth.admin.signOut(r.user.id);
      if (error) throw error;
      res.json({ ok: true });
    }),
  );

  // ===== Accounts =====
  const listAccounts = asyncRoute(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const r = req as AuthedRequest;
    const { data, error } = await supabaseAdmin
      .from("accounts")
      .select("id,user_id,type,label,status,created_at")
      .eq("user_id", r.user.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(api.accounts.list.responses[200].parse(data));
  });
  router.get(api.accounts.list.path, requireUser, listAccounts);
  router.get("/api/accounts/list", requireUser, listAccounts); // alias

  // ===== Balances =====
  const listBalances = asyncRoute(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const r = req as AuthedRequest;

    const { data: accounts, error } = await supabaseAdmin
      .from("accounts")
      .select("id,type,secrets,label,status")
      .eq("user_id", r.user.id)
      .eq("status", "active");
    if (error) throw error;

    const out: Array<{ account_id: string; type: string; balance: number | null; currency: string | null }> = [];

    async function fetchDerivBalance(token: string) {
      try {
        const info = await derivValidateToken(token);
        const bal = typeof info?.balance === "number" ? info.balance : Number(info?.balance ?? NaN);
        const cur = info?.currency ?? null;
        return { balance: Number.isFinite(bal) ? bal : null, currency: cur as string | null };
      } catch {
        return { balance: null, currency: null };
      }
    }

    async function fetchMt5Balance(creds: { server: string; login: string; password: string }) {
      if (!env.MT5_WORKER_URL) return { balance: null, currency: null };
      try {
        const r = await fetch(env.MT5_WORKER_URL.replace(/\/$/, "") + "/mt5/balance", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": env.MT5_WORKER_API_KEY ?? "" },
          body: JSON.stringify(creds),
        });
        const j = (await r.json().catch(() => ({}))) as any;
        const bal = typeof j?.balance === "number" ? j.balance : Number(j?.balance ?? NaN);
        const cur = j?.currency ?? null;
        return { balance: Number.isFinite(bal) ? bal : null, currency: cur as string | null };
      } catch {
        return { balance: null, currency: null };
      }
    }

    for (const acc of accounts ?? []) {
      if (acc.type === "deriv") {
        const derivEnc = (acc as any)?.secrets?.deriv_token_enc;
        const dec = derivEnc ? safeDecrypt<any>(derivEnc) : null;
        const token = dec?.token as string | undefined;
        const { balance, currency } = token ? await fetchDerivBalance(token) : { balance: null, currency: null };
        out.push({ account_id: acc.id, type: acc.type, balance, currency });
      } else if (acc.type === "mt5") {
        const mt5Enc = (acc as any)?.secrets?.mt5_enc;
        const dec = mt5Enc ? safeDecrypt<any>(mt5Enc) : null;
        const creds =
          dec && dec.server && dec.login && dec.password
            ? { server: String(dec.server), login: String(dec.login), password: String(dec.password) }
            : null;
        const { balance, currency } = creds ? await fetchMt5Balance(creds) : { balance: null, currency: null };
        out.push({ account_id: acc.id, type: acc.type, balance, currency });
      } else {
        out.push({ account_id: acc.id, type: acc.type, balance: null, currency: null });
      }
    }

    res.json(out);
  });

  router.get("/api/accounts/balances", requireUser, listBalances);
  router.get("/api/account/balances", requireUser, listBalances); // legacy alias

  // Accounts: rename/edit/delete
  const zRename = z.object({ label: z.string().min(1).max(100) });
  router.put(
    "/api/accounts/:id/rename",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const id = String(req.params.id);
      const body = zRename.parse(req.body);

      const { data, error } = await supabaseAdmin
        .from("accounts")
        .update({ label: body.label })
        .eq("id", id)
        .eq("user_id", r.user.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "not_found" });
      res.json({ ok: true });
    }),
  );

  // POST alias for hosts that block PUT
  router.post(
    "/api/accounts/:id/rename",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const id = String(req.params.id);
      const body = zRename.parse(req.body);

      const { data, error } = await supabaseAdmin
        .from("accounts")
        .update({ label: body.label })
        .eq("id", id)
        .eq("user_id", r.user.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "not_found" });
      res.json({ ok: true });
    }),
  );

  const zDerivUpdate = z.object({ token: z.string().min(1) });
  router.put(
    "/api/accounts/:id/deriv",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const id = String(req.params.id);
      const body = zDerivUpdate.parse(req.body);

      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("id,type,user_id")
        .eq("id", id)
        .eq("user_id", r.user.id)
        .maybeSingle();
      if (!acc || acc.type !== "deriv") return res.status(400).json({ error: "invalid_account_type" });

      const info = await derivValidateToken(body.token).catch((e: any) => {
        throw new Error(String(e?.Message ?? e));
      });

      const enc = encryptJson({
        token: body.token,
        validated_at: new Date().toISOString(),
        loginid: info?.loginid ?? null,
        balance: info?.balance ?? null,
        currency: info?.currency ?? null,
      });

      const { error } = await supabaseAdmin
        .from("accounts")
        .update({ secrets: { deriv_token_enc: enc } })
        .eq("id", id)
        .eq("user_id", r.user.id);
      if (error) throw error;
      res.json({ ok: true });
    }),
  );

  // POST alias for hosts that block PUT
  router.post(
    "/api/accounts/:id/deriv",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const id = String(req.params.id);
      const body = zDerivUpdate.parse(req.body);

      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("id,type,user_id")
        .eq("id", id)
        .eq("user_id", r.user.id)
        .maybeSingle();
      if (!acc || acc.type !== "deriv") return res.status(400).json({ error: "invalid_account_type" });

      const info = await derivValidateToken(body.token).catch((e: any) => {
        throw new Error(String(e?.Message ?? e));
      });

      const enc = encryptJson({
        token: body.token,
        validated_at: new Date().toISOString(),
        loginid: info?.loginid ?? null,
        balance: info?.balance ?? null,
        currency: info?.currency ?? null,
      });

      const { error } = await supabaseAdmin
        .from("accounts")
        .update({ secrets: { deriv_token_enc: enc } })
        .eq("id", id)
        .eq("user_id", r.user.id);
      if (error) throw error;
      res.json({ ok: true });
    }),
  );

  const zMt5Update = z.object({
    server: z.string().min(1),
    login: z.string().min(1),
    password: z.string().min(1),
  });
  router.put(
    "/api/accounts/:id/mt5",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const id = String(req.params.id);
      const body = zMt5Update.parse(req.body);

      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("id,type,user_id")
        .eq("id", id)
        .eq("user_id", r.user.id)
        .maybeSingle();
      if (!acc || acc.type !== "mt5") return res.status(400).json({ error: "invalid_account_type" });

      const enc = encryptJson({ server: body.server, login: body.login, password: body.password });
      const { error } = await supabaseAdmin
        .from("accounts")
        .update({ secrets: { mt5_enc: enc } })
        .eq("id", id)
        .eq("user_id", r.user.id);
      if (error) throw error;
      res.json({ ok: true });
    }),
  );

  // POST alias for hosts that block PUT
  router.post(
    "/api/accounts/:id/mt5",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const id = String(req.params.id);
      const body = zMt5Update.parse(req.body);

      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("id,type,user_id")
        .eq("id", id)
        .eq("user_id", r.user.id)
        .maybeSingle();
      if (!acc || acc.type !== "mt5") return res.status(400).json({ error: "invalid_account_type" });

      const enc = encryptJson({ server: body.server, login: body.login, password: body.password });
      const { error } = await supabaseAdmin
        .from("accounts")
        .update({ secrets: { mt5_enc: enc } })
        .eq("id", id)
        .eq("user_id", r.user.id);
      if (error) throw error;
      res.json({ ok: true });
    }),
  );

  router.delete(
    "/api/accounts/:id",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const id = String(req.params.id);

      const { error } = await supabaseAdmin.from("accounts").delete().eq("id", id).eq("user_id", r.user.id);
      if (error) throw error;
      res.json({ ok: true });
    }),
  );

  // POST alias for hosts that block DELETE
  router.post(
    "/api/accounts/:id/delete",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const id = String(req.params.id);
      const { error } = await supabaseAdmin.from("accounts").delete().eq("id", id).eq("user_id", r.user.id);
      if (error) throw error;
      res.json({ ok: true });
    }),
  );

  // ===== Accounts: validation/upsert =====
  router.post(
    api.accounts.validateDeriv.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const body = api.accounts.validateDeriv.input.parse(req.body);
      try {
        const info = await derivValidateToken(body.token);
        res.json({ ok: true, ...info });
      } catch (e: any) {
        res.json({ ok: false, message: String(e?.Message ?? e) });
      }
    }),
  );

  router.post(
    api.accounts.upsertDeriv.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const body = api.accounts.upsertDeriv.input.parse(req.body);

      const info = await derivValidateToken(body.token);

      const enc = encryptJson({
        token: body.token,
        validated_at: new Date().toISOString(),
        loginid: info?.loginid ?? null,
        balance: info?.balance ?? null,
        currency: info?.currency ?? null,
      });

      const { data, error } = await supabaseAdmin
        .from("accounts")
        .insert({
          user_id: r.user.id,
          type: "deriv",
          label: body.label,
          status: "active",
          secrets: { deriv_token_enc: enc },
        })
        .select("id,user_id,type,label,status,created_at")
        .single();

      if (error) throw error;
      res.json(api.accounts.upsertDeriv.responses[200].parse(data));
    }),
  );

  router.post(
    api.accounts.validateMt5.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const body = api.accounts.validateMt5.input.parse(req.body);
      if (!env.MT5_WORKER_URL) return res.json({ ok: false, message: "MT5 worker not configured" });

      const r = await fetch(env.MT5_WORKER_URL.replace(/\/$/, "") + "/mt5/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": env.MT5_WORKER_API_KEY ?? "" },
        body: JSON.stringify(body),
      });

      const j = await r.json().catch(() => ({}));
      res.json(api.accounts.validateMt5.responses[200].parse(j));
    }),
  );

  router.post(
    api.accounts.upsertMt5.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const body = api.accounts.upsertMt5.input.parse(req.body);

      const enc = encryptJson({ server: body.server, login: body.login, password: body.password });

      const { data, error } = await supabaseAdmin
        .from("accounts")
        .insert({
          user_id: r.user.id,
          type: "mt5",
          label: body.label,
          status: "active",
          secrets: { mt5_enc: enc },
        })
        .select("id,user_id,type,label,status,created_at")
        .single();

      if (error) throw error;
      res.json(api.accounts.upsertMt5.responses[200].parse(data));
    }),
  );

  // ===== Instruments =====
  const listInstruments = asyncRoute(async (_req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    const c = new DerivClient();
    await (c as any).connect?.().catch(() => void 0);
    const symbols = await (c as any).activeSymbols?.("brief").catch(() => []);
    await (c as any).disconnect?.().catch(() => void 0);

    const mapped = (symbols as any[]).map((s: any) => ({
      symbol: s.symbol,
      display_name: s.display_name,
      market: s.market,
      market_display_name: s.market_display_name,
      subgroup: s.subgroup,
      subgroup_display_name: s.subgroup_display_name,
      exchange_is_open: Boolean(s.exchange_is_open),
    }));
    res.json(api.instruments.list.responses[200].parse(mapped));
  });

  router.get(api.instruments.list.path, requireUser, listInstruments);
  router.get("/api/instruments/list", requireUser, listInstruments); // alias

  router.get(
    api.instruments.enabledForAccount.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const accountId = String(req.params.accountId);

      const { data, error } = await supabaseAdmin
        .from("account_instruments")
        .select("symbol,enabled")
        .eq("user_id", r.user.id)
        .eq("account_id", accountId);
      if (error) throw error;

      res.json(api.instruments.enabledForAccount.responses[200].parse(data ?? []));
    }),
  );

  router.post(
    api.instruments.setEnabled.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const body = api.instruments.setEnabled.input.parse(req.body);

      await supabaseAdmin.from("account_instruments").upsert(
        { user_id: r.user.id, account_id: body.account_id, symbol: body.symbol, enabled: body.enabled },
        { onConflict: "account_id,symbol" },
      );

      res.json({ ok: true });
    }),
  );

  // ===== Strategies =====
  router.get(
    api.strategies.list.path,
    requireUser,
    asyncRoute(async (_req, res) => {
      interface StrategyLike {
        id: string;
        name: string;
        description: string;
        defaultParams: Record<string, unknown>;
      }

      interface StrategyListItem {
        id: string;
        name: string;
        description: string;
        default_params: Record<string, unknown>;
      }

      res.json(
        api.strategies.list.responses[200].parse(
          strategies.map((s: StrategyLike): StrategyListItem => ({
            id: s.id,
            name: s.name,
            description: s.description,
            default_params: s.defaultParams,
          })),
        ),
      );
    }),
  );

  router.get(
    api.strategies.settingsForAccount.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const accountId = String(req.params.accountId);

      const { data, error } = await supabaseAdmin
        .from("strategy_settings")
        .select("*")
        .eq("user_id", r.user.id)
        .eq("account_id", accountId);
      if (error) throw error;

      res.json(api.strategies.settingsForAccount.responses[200].parse(data ?? []));
    }),
  );

  router.post(
    api.strategies.setSettings.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const body = api.strategies.setSettings.input.parse(req.body);

      const { error } = await supabaseAdmin.from("strategy_settings").upsert(
        {
          user_id: r.user.id,
          account_id: body.account_id,
          symbol: body.symbol,
          timeframe: body.timeframe,
          strategy_id: body.strategy_id,
          params: body.params,
          enabled: body.enabled,
        },
        { onConflict: "account_id,symbol,timeframe,strategy_id" },
      );
      if (error) throw error;

      res.json({ ok: true });
    }),
  );

  // ===== Bots =====
  router.get(
    api.bots.status.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      res.json(api.bots.status.responses[200].parse(botManager.getStatus(r.user.id)));
    }),
  );

  router.post(
    api.bots.start.path,
    requireUser,
    requireProForPaperLive,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const body = api.bots.start.input.parse(req.body);
      const runId = (req.body?.run_id as string | undefined) || randomUUID();
      await botManager.startById(
        r.user.id,
        runId,
        body.name,
        body.configs.map((c: any) => ({
          account_id: c.account_id,
          symbol: c.symbol,
          timeframe: c.timeframe,
          strategy_id: c.strategy_id,
          mode: c.mode,
          params: c.params,
          enabled: c.enabled,
        })),
      );
      res.json({ ok: true });
    }),
  );

  router.post(
    api.bots.stop.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const body = api.bots.stop.input.parse(req.body ?? {});
      if (!body.run_id) return res.status(400).json({ error: "run_id required" });
      await botManager.stopById(r.user.id, body.run_id);
      res.json({ ok: true });
    }),
  );

  // ===== Trades =====
  router.get(
    api.trades.list.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const { data, error } = await supabaseAdmin
        .from("trades")
        .select("*")
        .eq("user_id", r.user.id)
        .order("opened_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      res.json(api.trades.list.responses[200].parse(data));
    }),
  );

  router.get(
    api.trades.stats.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const { data, error } = await supabaseAdmin.from("trades").select("profit,opened_at").eq("user_id", r.user.id);
      if (error) throw error;

      const profits = (data ?? []).map((t: any) => Number(t.profit ?? 0));
      const totalProfit = profits.reduce((a: number, b: number) => a + b, 0);

      const wins = profits.filter((p: number) => p > 0);
      const losses = profits.filter((p: number) => p <= 0);

      const winRate = profits.length ? wins.length / profits.length : 0;
      const grossWin = wins.reduce((a: number, b: number) => a + b, 0);
      const grossLoss = Math.abs(losses.reduce((a: number, b: number) => a + b, 0));
      const profitFactor = grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss;

      let eq = 0;
      let peak = 0;
      let dd = 0;
      for (const p of profits.slice().reverse()) {
        eq += p;
        peak = Math.max(peak, eq);
        dd = Math.max(dd, peak - eq);
      }

      res.json(
        api.trades.stats.responses[200].parse({
          totalProfit,
          winRate,
          totalTrades: profits.length,
          profitFactor,
          maxDrawdown: dd,
        }),
      );
    }),
  );

  // ===== Journals =====
  router.get(
    api.journals.list.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const { data, error } = await supabaseAdmin
        .from("journals")
        .select("*")
        .eq("user_id", r.user.id)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      res.json(api.journals.list.responses[200].parse(data));
    }),
  );

  router.post(
    api.journals.create.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const body = api.journals.create.input.parse(req.body);

      const { data, error } = await supabaseAdmin
        .from("journals")
        .insert({
          user_id: r.user.id,
          trade_id: body.trade_id ?? null,
          title: body.title,
          note: body.note,
          tags: body.tags,
          screenshot_path: body.screenshot_path ?? null,
        })
        .select("*")
        .single();
      if (error) throw error;

      res.json(api.journals.create.responses[200].parse(data));
    }),
  );

  router.post(
    api.journals.signedUrl.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const body = api.journals.signedUrl.input.parse(req.body);
      const { data, error } = await supabaseAdmin.storage.from("journal-screenshots").createSignedUrl(body.path, 60 * 5);
      if (error) throw error;
      res.json(api.journals.signedUrl.responses[200].parse({ url: data.signedUrl }));
    }),
  );

  // ===== Settings: risk rules =====
  router.get(
    "/api/settings/risk",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const { data, error } = await supabaseAdmin.from("risk_rules").select("*").eq("user_id", r.user.id).maybeSingle();
      if (error) throw error;

      const rule = data
        ? {
            risk_type: data.risk_type ?? undefined,
            fixed_stake: Number(data.fixed_stake),
            percent_risk: Number(data.percent_risk),
            max_daily_loss: Number(data.max_daily_loss),
            max_drawdown: Number(data.max_drawdown),
            max_open_trades: Number(data.max_open_trades),
            adaptive_enabled: Boolean(data.adaptive_enabled),
            adaptive_min_percent: Number(data.adaptive_min_percent),
            adaptive_max_percent: Number(data.adaptive_max_percent),
            adaptive_step: Number(data.adaptive_step),
            adaptive_lookback: Number(data.adaptive_lookback),
          }
        : {};

      // returns canonical risk_type: "fixed_stake" | "percent_balance"
      res.json(zRiskRules.parse(rule));
    }),
  );

  router.put(
    "/api/settings/risk",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const body = zRiskRules.parse(req.body);

      const { error } = await supabaseAdmin
        .from("risk_rules")
        .upsert({ user_id: r.user.id, ...body }, { onConflict: "user_id" });
      if (error) throw error;

      res.json({ ok: true });
    }),
  );

  // ===== Backtests =====
  router.post(
    api.backtests.run.path,
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const body = api.backtests.run.input.parse(req.body);

      const candles = parseCsv(body.csv);
      const out = await runBacktest({
        userId: r.user.id,
        symbol: body.symbol,
        timeframe: body.timeframe,
        strategyId: body.strategy_id,
        params: body.params,
        candles,
      });

      await supabaseAdmin.from("backtests").insert({
        user_id: r.user.id,
        symbol: body.symbol,
        timeframe: body.timeframe,
        strategy_id: body.strategy_id,
        params: body.params,
        metrics: out.metrics,
      });

      res.json(
        api.backtests.run.responses[200].parse({
          ok: true,
          metrics: out.metrics,
          sample_trades: out.trades.slice(0, 10),
        }),
      );
    }),
  );

  // ===== Stripe: Checkout (hardcoded path) =====
  router.post(
    "/api/stripe/create-checkout",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const body = api.stripe.createCheckout.input.parse({ return_url: req.body?.return_url });
      const stripe = requireStripe();

      const { data: sub } = await supabaseAdmin
        .from("subscriptions")
        .select("stripe_customer_id")
        .eq("user_id", r.user.id)
        .maybeSingle();

      let customerId = sub?.stripe_customer_id ?? null;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: r.user.email ?? undefined,
          metadata: { user_id: r.user.id },
        });
        customerId = customer.id;
        await supabaseAdmin.from("subscriptions").upsert({ user_id: r.user.id, stripe_customer_id: customerId }, { onConflict: "user_id" });
      }

      const plan = (req.body?.plan as "1m" | "2m" | "3m" | undefined) ?? "1m";
      const priceByPlan: Record<"1m" | "2m" | "3m", string | undefined> = {
        "1m": env.STRIPE_PRICE_PRO_1M,
        "2m": env.STRIPE_PRICE_PRO_2M,
        "3m": env.STRIPE_PRICE_PRO_3M,
      };
      const priceId = priceByPlan[plan] || env.STRIPE_PRICE_PRO_MONTHLY;

      if (!priceId) {
        return res.status(400).json({
          error: "Stripe price for selected plan not configured",
          details: { plan, required_env: [`STRIPE_PRICE_PRO_${plan.toUpperCase()}`, "or STRIPE_PRICE_PRO_MONTHLY"] },
        });
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: body.return_url,
        cancel_url: body.return_url,
        allow_promotion_codes: true,
      });

      res.json({ url: session.url });
    }),
  );

  // Billing Portal
  router.post(
    "/api/stripe/portal",
    requireUser,
    asyncRoute(async (req, res) => {
      const stripe = requireStripe();
      const r = req as AuthedRequest;
      const returnUrl = (req.body?.return_url as string) || getOrigin(req);

      const { data: subRow, error } = await supabaseAdmin
        .from("subscriptions")
        .select("stripe_customer_id")
        .eq("user_id", r.user.id)
        .maybeSingle();
      if (error || !subRow?.stripe_customer_id) throw new Error("Stripe customer missing");

      const portal = await stripe.billingPortal.sessions.create({
        customer: subRow.stripe_customer_id,
        return_url: returnUrl,
      });

      res.json({ url: portal.url });
    }),
  );

  // ===== Admin =====
  router.get(
    "/api/admin/overview",
    requireUser,
    asyncRoute(async (req, res) => {
      const r = req as AuthedRequest;
      const role = await getRole(r.user.id);
      if (role !== "admin") return res.status(403).json({ error: "forbidden" });

      const users = await supabaseAdmin.from("profiles").select("id,email,role,created_at").order("created_at", { ascending: false }).limit(50);
      const subs = await supabaseAdmin.from("subscriptions").select("*").order("updated_at", { ascending: false }).limit(50);
      const logs = await supabaseAdmin.from("logs").select("*").order("created_at", { ascending: false }).limit(50);

      res.json({ users: users.data, subscriptions: subs.data, logs: logs.data });
    }),
  );

  app.use(router);
  return { botManager };
}