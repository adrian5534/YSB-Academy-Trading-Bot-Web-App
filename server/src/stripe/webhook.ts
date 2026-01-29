import type { Request, Response } from "express";
import { supabaseAdmin } from "../supabase";
import { requireStripe } from "./stripe";

async function setPlanByCustomer(customerId: string, status: string, subscriptionId?: string) {
  const plan = status === "active" || status === "trialing" ? "pro" : "free";
  await supabaseAdmin
    .from("subscriptions")
    .update({
      stripe_subscription_id: subscriptionId ?? null,
      status,
      plan,
    })
    .eq("stripe_customer_id", customerId);
}

export async function stripeWebhook(req: Request, res: Response) {
  const stripe = requireStripe();
  const sig = req.headers["stripe-signature"] as string;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!endpointSecret) return res.status(500).send("STRIPE_WEBHOOK_SECRET not set");

  let event;
  try {
    event = stripe.webhooks.constructEvent((req as any).body, sig, endpointSecret);
  } catch (err: any) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as any;
      const subscriptionId = session.subscription as string | undefined;
      const customerId = session.customer as string;
      if (subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        await setPlanByCustomer(customerId, sub.status, sub.id);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as any;
      await setPlanByCustomer(sub.customer as string, sub.status, sub.id);
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
}