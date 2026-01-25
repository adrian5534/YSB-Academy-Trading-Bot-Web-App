# Acceptance tests checklist

A) Supabase login works → profile auto-created.
- Create user via UI `/auth`.
- Confirm `profiles` row exists (trigger `handle_new_user`).

B) Stripe Pro unlocks paper/live trading (backend-enforced).
- Without Pro (plan free/inactive): POST `/api/bots/start` with `mode: paper` returns 402.
- With Pro (subscriptions table: plan=pro, status=active): request succeeds.

C) Deriv instruments page shows MANY instruments (not one).
- Visit `/instruments`: should list hundreds (depending on Deriv response).

D) Enable 3 instruments + 2 strategies each → start paper bot → trades/logs stream live.
- Current UI exposes single-config start (extend BotCenter to multi-config).
- WebSocket `/ws` should stream:
  - `bot.log`
  - `trade.event`

E) Trades saved to Supabase and visible in dashboard analytics.
- Run paper bot for ~1 minute.
- Confirm `trades` rows appear, dashboard stats update.

F) Journal screenshot upload works (Supabase Storage) and displays.
- In `/trades` create journal entry with screenshot.
- Confirm file exists in `journal-screenshots` bucket under `<user_id>/...`.

G) MT5 optional: add server/login/pass → backend calls worker → returns account_info.
- Start worker on Windows.
- Set backend env `MT5_WORKER_URL` + `MT5_WORKER_API_KEY`.
- Save MT5 account in `/accounts`.
