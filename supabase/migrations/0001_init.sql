-- 0001_init.sql
-- Core schema + triggers + RLS policies

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'user',
  created_at timestamptz not null default now()
);

create table if not exists subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free',
  status text not null default 'inactive',
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists risk_rules (
  user_id uuid primary key references auth.users(id) on delete cascade,
  risk_type text not null default 'fixed_stake',
  fixed_stake numeric not null default 1,
  percent_risk numeric not null default 1,
  max_daily_loss numeric not null default 50,
  max_drawdown numeric not null default 200,
  max_open_trades int not null default 3,
  adaptive_enabled boolean not null default false,
  adaptive_min_percent numeric not null default 0.25,
  adaptive_max_percent numeric not null default 2,
  adaptive_step numeric not null default 0.25,
  adaptive_lookback int not null default 25,
  updated_at timestamptz not null default now()
);

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  label text not null,
  status text not null default 'active',
  secrets jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists account_instruments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  symbol text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique(account_id, symbol)
);

create table if not exists strategies (
  id text primary key,
  name text not null,
  description text not null,
  created_at timestamptz not null default now()
);

create table if not exists strategy_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  symbol text not null,
  timeframe text not null,
  strategy_id text not null references strategies(id) on delete cascade,
  params jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique(account_id, symbol, timeframe, strategy_id)
);

create table if not exists bots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  state text not null default 'stopped',
  started_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  mode text not null,
  symbol text not null,
  strategy_id text not null,
  timeframe text not null,
  side text not null,
  entry numeric not null,
  sl numeric,
  tp numeric,
  exit numeric,
  profit numeric,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  meta jsonb not null default '{}'::jsonb
);

create table if not exists journals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trade_id uuid references trades(id) on delete set null,
  title text not null,
  note text not null default '',
  tags text[] not null default '{}'::text[],
  screenshot_path text,
  created_at timestamptz not null default now()
);

create table if not exists logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  level text not null default 'info',
  message text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists backtests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  timeframe text not null,
  strategy_id text not null,
  params jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ===== Profile / subscription auto-create =====
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;

  insert into public.subscriptions (user_id, plan, status) values (new.id, 'free', 'inactive')
  on conflict (user_id) do nothing;

  insert into public.risk_rules (user_id) values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- ===== Enable RLS =====
alter table profiles enable row level security;
alter table subscriptions enable row level security;
alter table risk_rules enable row level security;
alter table accounts enable row level security;
alter table account_instruments enable row level security;
alter table strategy_settings enable row level security;
alter table bots enable row level security;
alter table trades enable row level security;
alter table journals enable row level security;
alter table logs enable row level security;
alter table backtests enable row level security;

-- ===== RLS Policies (owner-only) =====
create policy "profiles owner" on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "subscriptions owner" on subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "risk_rules owner" on risk_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "accounts owner" on accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "account_instruments owner" on account_instruments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "strategy_settings owner" on strategy_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "bots owner" on bots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "trades owner" on trades
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "journals owner" on journals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "logs owner" on logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "backtests owner" on backtests
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===== Seed strategies metadata (server has executable modules) =====
insert into strategies (id, name, description) values
  ('candle_pattern', 'Simple Candle Pattern', 'Basic engulfing / reversal patterns'),
  ('one_hour_trend', 'One-Hour Trend', 'Time-window based trend filter and breakout'),
  ('trend_confirmation', 'Trend + Confirmation', 'EMA 50/200 + RSI + MACD confirmation'),
  ('scalping_hwr', 'High-Win-Rate Scalping', 'Short-term mean reversion + ATR filter'),
  ('trend_pullback', 'Trend Pullback Continuation', 'Trend continuation after pullback'),
  ('supply_demand_sweep', 'Supply & Demand + Sweep', 'Liquidity sweep around zones'),
  ('fvg_retracement', 'FVG Retracement', 'Fair Value Gap retracement entries'),
  ('range_mean_reversion', 'Range Mean Reversion', 'Session-based range mean reversion')
on conflict (id) do nothing;
