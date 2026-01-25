# YSB Academy Trading Bot Web App

Production-oriented algo-trading web app with:
- Supabase Auth + DB + Storage (RLS)
- Deriv WebSocket trading connector (dynamic instruments)
- Multi-instrument / multi-strategy bot engine (Backtest / Paper / Live)
- Stripe subscription gating (Free vs Pro)
- Optional MT5 account validator via Python worker (FastAPI + MetaTrader5)

## Monorepo structure
- `client/` Vite + React frontend (deploy to Netlify)
- `server/` Express + WebSockets backend
- `shared/` Shared Zod schemas/types
- `worker/` Optional MT5 validator service (Windows host)
- `supabase/migrations/` SQL migrations + RLS + storage bucket policies
- `samples/` Sample CSV for backtesting

## Quick start (local)
1) Create Supabase project, set env vars (see `.env.example`).
2) Run migrations in Supabase SQL editor (in order):
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_storage.sql`
3) Install + run:
```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend:  http://localhost:8787

## Netlify deploy
- Build command: `npm --prefix client install && npm --prefix client run build`
- Publish directory: `client/dist`
- Configure env vars from `.env.example` (client vars must be `VITE_*`)

## MT5 worker (optional)
Run on Windows host with MetaTrader5 terminal installed:
```bash
cd worker
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 9000
```
