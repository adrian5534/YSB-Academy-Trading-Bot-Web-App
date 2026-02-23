import express from "express";
import cors from "cors";
import { createServer, type IncomingMessage } from "http";
import { WebSocketServer } from "ws";
import { env } from "./env";
import { registerRoutes } from "./routes";
import { WsHub } from "./ws/hub";
import { requireStripe } from "./stripe/stripe";
import Stripe from "stripe";
import { supabaseAdmin } from "./supabase";

const app = express();

// For correct x-forwarded-proto on Render/Proxies
app.set("trust proxy", 1);

// Stripe webhook needs raw body; mount first
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const stripe = requireStripe();
    const sig = req.headers["stripe-signature"] as string | undefined;
    if (!sig || !env.STRIPE_WEBHOOK_SECRET) return res.status(400).send("Missing signature");
    const event = stripe.webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);

    // Handle subscription updates
    void handleStripeEvent(event)
      .then(() => res.json({ received: true }))
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error("Webhook handler error:", e);
        res.status(400).send("Webhook error");
      });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Webhook constructEvent error:", e);
    return res.status(400).send("Webhook error");
  }
});

// Standard middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

// Basic request logger to debug 404s
app.use((req, _res, next) => {
  // eslint-disable-next-line no-console
  console.log("[REQ]", req.method, req.originalUrl);
  next();
});

// keep a simple health path for diagnostics
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const hub = new WsHub(wss);

/**
 * WebSocket auth + user scoping:
 * Clients must connect with ?access_token=<supabase access token> (or Authorization: Bearer <token> in non-browser clients).
 */
function getWsToken(req: IncomingMessage): string | null {
  // 1) Authorization header (works for non-browser clients)
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }

  // 2) Query params (works for browsers)
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    return url.searchParams.get("access_token") || url.searchParams.get("token");
  } catch {
    return null;
  }
}

wss.on("connection", async (ws, req) => {
  try {
    const token = getWsToken(req);
    if (!token) return ws.close(1008, "unauthorized");

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user?.id) return ws.close(1008, "unauthorized");

    hub.attachClient(ws, data.user.id);
  } catch {
    try {
      ws.close(1011, "server_error");
    } catch {
      // ignore
    }
  }
});

// register all routes (routes include /api/health and stripe endpoints)
registerRoutes(app, hub);

// Error handler - must be after routes
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("API_ERROR:", err);

  // Zod validation errors
  if (err?.name === "ZodError") {
    return res.status(400).json({ error: "Invalid request", details: err.errors });
  }

  return res.status(500).json({ error: "Internal Server Error", message: err?.message ?? String(err) });
});

server.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${env.PORT}`);
});

async function handleStripeEvent(event: Stripe.Event) {
  const stripe = requireStripe();

  // checkout.session.completed: update DB immediately from the subscription
  if (event.type === "checkout.session.completed") {
    try {
      const session = event.data.object as Stripe.Checkout.Session;
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : (session.subscription as any)?.id;
      const customerId = typeof session.customer === "string" ? session.customer : (session.customer as any)?.id;

      // If subscription id present, fetch subscription to get canonical status and period end
      if (subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const status = sub.status;
        const current_period_end = sub.current_period_end
          ? new Date(Number(sub.current_period_end) * 1000).toISOString()
          : null;
        const plan = status === "active" || status === "trialing" ? "pro" : "free";

        // Try to find the user by customer id first
        if (customerId) {
          const { data: row } = await supabaseAdmin
            .from("subscriptions")
            .select("user_id")
            .eq("stripe_customer_id", customerId)
            .maybeSingle();

          if (row?.user_id) {
            await supabaseAdmin
              .from("subscriptions")
              .update({
                plan,
                status: status === "active" || status === "trialing" ? "active" : "inactive",
                stripe_subscription_id: subscriptionId,
                current_period_end,
                updated_at: new Date().toISOString(),
              })
              .eq("user_id", row.user_id);
            // eslint-disable-next-line no-console
            console.log(`[stripe] updated subscription for user ${row.user_id} via checkout.session.completed`);
            return;
          }
        }

        // Fallback note: extend if you store user_id in Stripe metadata
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("handleStripeEvent (checkout.session.completed) error:", e);
    }
    return;
  }

  // subscription lifecycle events
  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    try {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = String(sub.customer);
      const status = sub.status;
      const current_period_end = sub.current_period_end
        ? new Date(Number(sub.current_period_end) * 1000).toISOString()
        : null;
      const plan = status === "active" || status === "trialing" ? "pro" : "free";

      const { data: row } = await supabaseAdmin
        .from("subscriptions")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .maybeSingle();

      if (!row?.user_id) return;

      await supabaseAdmin
        .from("subscriptions")
        .update({
          plan,
          status: status === "active" || status === "trialing" ? "active" : "inactive",
          stripe_subscription_id: sub.id,
          current_period_end,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", row.user_id);

      // eslint-disable-next-line no-console
      console.log(`[stripe] subscription event ${event.type} handled for user ${row.user_id}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("handleStripeEvent (subscription event) error:", e);
    }
  }
}