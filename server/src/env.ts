import "dotenv/config";
import { z } from "zod";

const zEnv = z.object({
  PORT: z.coerce.number().default(8787),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(10),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),
  DERIV_WS_URL: z.string().default("wss://ws.derivws.com/websockets/v3"),
  DERIV_APP_ID: z.coerce.number().default(1089),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),
  MT5_WORKER_URL: z.string().optional(),
  MT5_WORKER_API_KEY: z.string().optional(),
  SECRETS_KEY_B64: z.string().optional(),
});

export const env = zEnv.parse(process.env);
