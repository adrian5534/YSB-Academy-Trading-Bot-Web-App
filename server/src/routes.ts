import express from "express";
import { api, zRiskRules } from "../../shared/routes";
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

function asyncRoute(fn: any) {
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

export function registerRoutes(app: express.Express, hub: WsHub) {
  const router = express.Router();
  const botManager = new BotManager(hub);

  // ===== Auth =====
  router.get(api.auth.me.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    await ensureProfile(req.user.id, req.user.email);
    const { data } = await supabaseAdmin.from("profiles").select("*").eq("id", req.user.id).single();
    res.json(api.auth.me.responses[200].parse({
      id: data.id,
      email: data.email,
      role: data.role,
      created_at: data.created_at,
    }));
  }));

  router.get(api.auth.subscription.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    await ensureProfile(req.user.id, req.user.email);
    const { data } = await supabaseAdmin.from("subscriptions").select("*").eq("user_id", req.user.id).maybeSingle();
    res.json(api.auth.subscription.responses[200].parse({
      plan: (data?.plan ?? "free"),
      status: (data?.status ?? "inactive"),
      current_period_end: data?.current_period_end ? new Date(data.current_period_end).toISOString() : null,
    }));
  }));

  // ===== Accounts =====
  router.get(api.accounts.list.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const { data, error } = await supabaseAdmin.from("accounts").select("id,user_id,type,label,status,created_at").eq("user_id", req.user.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json(api.accounts.list.responses[200].parse(data));
  }));

  router.post(api.accounts.validateDeriv.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const body = api.accounts.validateDeriv.input.parse(req.body);
    try {
      const c = new DerivClient();
      const info = await c.validateToken(body.token);
      res.json({ ok: true, ...info });
    } catch (e: any) {
      res.json({ ok: false, message: String(e.message ?? e) });
    }
  }));

  router.post(api.accounts.upsertDeriv.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const body = api.accounts.upsertDeriv.input.parse(req.body);
    // validate token before saving
    const c = new DerivClient();
    const info = await c.validateToken(body.token);

    // encrypt secrets
    const enc = encryptJson({ token: body.token, validated_at: new Date().toISOString(), ...info });

    const { data, error } = await supabaseAdmin
      .from("accounts")
      .insert({
        user_id: req.user.id,
        type: "deriv",
        label: body.label,
        status: "active",
        secrets: { deriv_token_enc: enc },
      })
      .select("id,user_id,type,label,status,created_at")
      .single();

    if (error) throw error;

    res.json(api.accounts.upsertDeriv.responses[200].parse(data));
  }));

  router.post(api.accounts.validateMt5.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const body = api.accounts.validateMt5.input.parse(req.body);
    if (!env.MT5_WORKER_URL) return res.json({ ok: false, message: "MT5 worker not configured" });

    const r = await fetch(env.MT5_WORKER_URL.replace(/\/$/, "") + "/mt5/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.MT5_WORKER_API_KEY ?? "" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    res.json(api.accounts.validateMt5.responses[200].parse(j));
  }));

  router.post(api.accounts.upsertMt5.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const body = api.accounts.upsertMt5.input.parse(req.body);
    const enc = encryptJson({ server: body.server, login: body.login, password: body.password });

    const { data, error } = await supabaseAdmin
      .from("accounts")
      .insert({
        user_id: req.user.id,
        type: "mt5",
        label: body.label,
        status: "active",
        secrets: { mt5_enc: enc },
      })
      .select("id,user_id,type,label,status,created_at")
      .single();

    if (error) throw error;
    res.json(api.accounts.upsertMt5.responses[200].parse(data));
  }));

  // ===== Instruments =====
  router.get(api.instruments.list.path, requireUser, asyncRoute(async (_req: AuthedRequest, res) => {
    const c = new DerivClient();
    const symbols = await c.activeSymbols();
    const mapped = symbols.map((s: any) => ({
      symbol: s.symbol,
      display_name: s.display_name,
      market: s.market,
      market_display_name: s.market_display_name,
      subgroup: s.subgroup,
      subgroup_display_name: s.subgroup_display_name,
      exchange_is_open: s.exchange_is_open,
    }));
    res.json(api.instruments.list.responses[200].parse(mapped));
  }));
  router.get(api.instruments.enabledForAccount.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const accountId = String(req.params.accountId);
    const { data, error } = await supabaseAdmin
      .from("account_instruments")
      .select("symbol,enabled")
      .eq("user_id", req.user.id)
      .eq("account_id", accountId);
    if (error) throw error;
    res.json(api.instruments.enabledForAccount.responses[200].parse(data ?? []));
  }));

  router.post(api.instruments.setEnabled.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const body = api.instruments.setEnabled.input.parse(req.body);
    await supabaseAdmin
      .from("account_instruments")
      .upsert({
        user_id: req.user.id,
        account_id: body.account_id,
        symbol: body.symbol,
        enabled: body.enabled,
      }, { onConflict: "account_id,symbol" });
    res.json({ ok: true });
  }));


  // ===== Strategies =====
  router.get(api.strategies.list.path, requireUser, asyncRoute(async (_req: AuthedRequest, res) => {
    res.json(api.strategies.list.responses[200].parse(
      strategies.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        default_params: s.defaultParams,
      })),
    ));
  }));
  router.get(api.strategies.settingsForAccount.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const accountId = String(req.params.accountId);
    const { data, error } = await supabaseAdmin
      .from("strategy_settings")
      .select("*")
      .eq("user_id", req.user.id)
      .eq("account_id", accountId);
    if (error) throw error;
    res.json(api.strategies.settingsForAccount.responses[200].parse(data ?? []));
  }));

  router.post(api.strategies.setSettings.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const body = api.strategies.setSettings.input.parse(req.body);
    const { error } = await supabaseAdmin
      .from("strategy_settings")
      .upsert({
        user_id: req.user.id,
        account_id: body.account_id,
        symbol: body.symbol,
        timeframe: body.timeframe,
        strategy_id: body.strategy_id,
        params: body.params,
        enabled: body.enabled,
      }, { onConflict: "account_id,symbol,timeframe,strategy_id" });
    if (error) throw error;
    res.json({ ok: true });
  }));


  // ===== Bots =====
  router.get(api.bots.status.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    res.json(api.bots.status.responses[200].parse(botManager.getStatus(req.user.id)));
  }));

  router.post(api.bots.start.path, requireUser, requireProForPaperLive, asyncRoute(async (req: AuthedRequest, res) => {
    const body = api.bots.start.input.parse(req.body);
    await botManager.start(req.user.id, body.name, body.configs.map((c) => ({
      account_id: c.account_id,
      symbol: c.symbol,
      timeframe: c.timeframe,
      strategy_id: c.strategy_id,
      mode: c.mode,
      params: c.params,
      enabled: c.enabled,
    })));
    res.json({ ok: true });
  }));

  router.post(api.bots.stop.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    await botManager.stop(req.user.id);
    res.json({ ok: true });
  }));

  // ===== Trades =====
  router.get(api.trades.list.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const { data, error } = await supabaseAdmin.from("trades").select("*").eq("user_id", req.user.id).order("opened_at", { ascending: false }).limit(200);
    if (error) throw error;
    res.json(api.trades.list.responses[200].parse(data));
  }));

  router.get(api.trades.stats.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const { data, error } = await supabaseAdmin.from("trades").select("profit,opened_at").eq("user_id", req.user.id);
    if (error) throw error;
    const profits = (data ?? []).map((t: any) => Number(t.profit ?? 0));
    const totalProfit = profits.reduce((a, b) => a + b, 0);
    const wins = profits.filter((p) => p > 0);
    const losses = profits.filter((p) => p <= 0);
    const winRate = profits.length ? wins.length / profits.length : 0;
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss;

    // naive max drawdown on cumulative equity
    let eq = 0, peak = 0, dd = 0;
    for (const p of profits.slice().reverse()) {
      eq += p; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    }

    res.json(api.trades.stats.responses[200].parse({
      totalProfit,
      winRate,
      totalTrades: profits.length,
      profitFactor,
      maxDrawdown: dd,
    }));
  }));

  // ===== Journals =====
  router.get(api.journals.list.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const { data, error } = await supabaseAdmin.from("journals").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false }).limit(200);
    if (error) throw error;
    res.json(api.journals.list.responses[200].parse(data));
  }));

  router.post(api.journals.create.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const body = api.journals.create.input.parse(req.body);
    const { data, error } = await supabaseAdmin
      .from("journals")
      .insert({ user_id: req.user.id, trade_id: body.trade_id ?? null, title: body.title, note: body.note, tags: body.tags, screenshot_path: body.screenshot_path ?? null })
      .select("*")
      .single();
    if (error) throw error;
    res.json(api.journals.create.responses[200].parse(data));
  }));

  router.post(api.journals.signedUrl.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const body = api.journals.signedUrl.input.parse(req.body);
    const { data, error } = await supabaseAdmin.storage.from("journal-screenshots").createSignedUrl(body.path, 60 * 5);
    if (error) throw error;
    res.json(api.journals.signedUrl.responses[200].parse({ url: data.signedUrl }));
  }));

  // ===== Settings: risk rules =====
  router.get("/api/settings/risk", requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const { data, error } = await supabaseAdmin.from("risk_rules").select("*").eq("user_id", req.user.id).maybeSingle();
    if (error) throw error;
    const rule = data ? ({
      risk_type: data.risk_type,
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
    }) : zRiskRules.parse({});
    res.json(zRiskRules.parse(rule));
  }));

  router.put("/api/settings/risk", requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const body = zRiskRules.parse(req.body);
    const { error } = await supabaseAdmin.from("risk_rules").upsert({ user_id: req.user.id, ...body }, { onConflict: "user_id" });
    if (error) throw error;
    res.json({ ok: true });
  }));

  // ===== Backtests =====
  router.post(api.backtests.run.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const body = api.backtests.run.input.parse(req.body);
    const candles = parseCsv(body.csv);
    const out = runBacktest({
      userId: req.user.id,
      symbol: body.symbol,
      timeframe: body.timeframe,
      strategyId: body.strategy_id,
      params: body.params,
      candles,
    });

    await supabaseAdmin.from("backtests").insert({
      user_id: req.user.id,
      symbol: body.symbol,
      timeframe: body.timeframe,
      strategy_id: body.strategy_id,
      params: body.params,
      metrics: out.metrics,
    });

    res.json(api.backtests.run.responses[200].parse({
      ok: true,
      metrics: out.metrics,
      sample_trades: out.trades.slice(0, 10),
    }));
  }));

  // ===== Stripe =====
  router.post(api.stripe.createCheckout.path, requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const body = api.stripe.createCheckout.input.parse(req.body);
    const stripe = requireStripe();

    // Ensure customer exists
    const { data: sub } = await supabaseAdmin.from("subscriptions").select("stripe_customer_id").eq("user_id", req.user.id).maybeSingle();
    let customerId = sub?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: req.user.email ?? undefined, metadata: { user_id: req.user.id } });
      customerId = customer.id;
      await supabaseAdmin.from("subscriptions").update({ stripe_customer_id: customerId }).eq("user_id", req.user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: env.STRIPE_PRICE_PRO_MONTHLY, quantity: 1 }],
      success_url: body.return_url,
      cancel_url: body.return_url,
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  }));

  // Stripe webhook must be raw body; configured in index.ts
  router.post(api.stripe.webhook.path, asyncRoute(async (_req, res) => {
    res.json({ ok: true });
  }));

  // ===== Admin =====
  router.get("/api/admin/overview", requireUser, asyncRoute(async (req: AuthedRequest, res) => {
    const role = await getRole(req.user.id);
    if (role !== "admin") return res.status(403).json({ error: "forbidden" });

    const users = await supabaseAdmin.from("profiles").select("id,email,role,created_at").order("created_at", { ascending: false }).limit(50);
    const subs = await supabaseAdmin.from("subscriptions").select("*").order("updated_at", { ascending: false }).limit(50);
    const logs = await supabaseAdmin.from("logs").select("*").order("created_at", { ascending: false }).limit(50);

    res.json({ users: users.data, subscriptions: subs.data, logs: logs.data });
  }));

  app.use(router);
  return { botManager };
}
