# Deploy notes

## Frontend (Netlify)
- Base directory: repo root
- Build command:
  `npm --prefix client install && npm --prefix client run build`
- Publish directory: `client/dist`
- Environment variables (Netlify -> Site settings -> Environment variables):
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
  - `VITE_BACKEND_URL` (your backend public URL)

The provided `netlify.toml` includes SPA redirects.

## Backend (Render/Railway/Fly/EC2)
Run the `server/` workspace.

### Required env vars
- `PORT`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SECRETS_KEY_B64` (AES-256-GCM key, 32 bytes base64)

Optional:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_PRO_MONTHLY`
- `MT5_WORKER_URL`
- `MT5_WORKER_API_KEY`

### Start commands
- Build: `npm --workspace server run build`
- Start: `npm --workspace server run start`

## Stripe
1) Create a recurring subscription price in Stripe (Pro plan).
2) Set `STRIPE_PRICE_PRO_MONTHLY` to that price id.
3) Configure webhook endpoint:
   - URL: `<BACKEND_URL>/api/stripe/webhook`
   - Events:
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
4) Copy webhook signing secret into `STRIPE_WEBHOOK_SECRET`.

## MT5 worker (optional)
Runs on Windows with a local MetaTrader 5 terminal installed.

Env vars:
- `MT5_WORKER_API_KEY`

Run:
```bash
cd worker
pip install -r requirements.txt
set MT5_WORKER_API_KEY=change-me
uvicorn main:app --host 0.0.0.0 --port 9000
```

Then in backend set:
- `MT5_WORKER_URL=http://<worker-host>:9000`
- `MT5_WORKER_API_KEY=change-me`
