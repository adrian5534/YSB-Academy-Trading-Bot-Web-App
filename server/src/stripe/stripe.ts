import Stripe from "stripe";
import { env } from "../env";

export const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" }) : null;

export function requireStripe() {
  if (!stripe) throw new Error("Stripe not configured");
  return stripe;
}
