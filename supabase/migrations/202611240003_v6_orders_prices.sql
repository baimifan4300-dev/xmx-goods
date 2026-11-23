-- ============================================================================
-- V6 P1 · 003 orders, payments, prices, sales, duplicate candidates
-- 金额只存流水；balance_due 由视图计算，不存冗余总额。
-- ============================================================================

create table if not exists public.orders (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  order_no text,
  shop_name text,
  order_url text,
  currency text not null default 'CNY',
  total_amount numeric(12,2) not null default 0 check (total_amount >= 0),
  shipping_fee numeric(12,2) not null default 0 check (shipping_fee >= 0),
  discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0),
  deposit_planned numeric(12,2) check (deposit_planned is null or deposit_planned >= 0),
  ordered_at date,
  expected_arrival_date date,
  balance_due_date date,
  status text not null default 'open'
    check (status in ('open', 'completed', 'cancelled', 'refunded')),
  note text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id)
);
create index if not exists idx_orders_owner_status_due
  on public.orders(owner_id, status, balance_due_date)
  where deleted_at is null;
create index if not exists idx_orders_owner_no
  on public.orders(owner_id, order_no);

create table if not exists public.order_items (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  entity_type text not null check (entity_type in ('product', 'book')),
  entity_id text not null,
  quantity integer not null default 1 check (quantity >= 1),
  unit_price numeric(12,2) not null default 0 check (unit_price >= 0),
  line_discount numeric(12,2) not null default 0 check (line_discount >= 0),
  allocated_amount numeric(12,2) check (allocated_amount is null or allocated_amount >= 0),
  note text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  constraint order_items_order_fk
    foreign key (owner_id, order_id) references public.orders(owner_id, id) on delete cascade
);
create index if not exists idx_order_items_owner_order
  on public.order_items(owner_id, order_id);
create index if not exists idx_order_items_owner_entity
  on public.order_items(owner_id, entity_type, entity_id);

create table if not exists public.payment_records (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  kind text not null
    check (kind in ('deposit', 'balance', 'full', 'shipping', 'refund', 'adjustment')),
  amount numeric(12,2) not null,
  paid_at date not null,
  method text,
  reference text,
  note text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id),
  constraint payment_records_order_fk
    foreign key (owner_id, order_id) references public.orders(owner_id, id) on delete cascade,
  constraint payment_records_amount_check check (
    (kind = 'adjustment' and amount <> 0) or
    (kind in ('deposit', 'balance', 'full', 'shipping', 'refund') and amount > 0)
  )
);
create index if not exists idx_payment_records_owner_order
  on public.payment_records(owner_id, order_id, paid_at)
  where deleted_at is null;

create table if not exists public.price_history (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  entity_type text not null check (entity_type in ('product', 'book')),
  entity_id text not null,
  price_type text not null check (price_type in ('market', 'purchase')),
  amount numeric(12,2) not null check (amount >= 0),
  recorded_on date,
  source text,
  note text,
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);
create index if not exists idx_price_history_entity
  on public.price_history(owner_id, entity_type, entity_id, recorded_on desc nulls last);
create index if not exists idx_price_history_type
  on public.price_history(owner_id, price_type);

create table if not exists public.sales (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  entity_type text not null check (entity_type in ('product', 'book')),
  entity_id text not null,
  sale_status text not null default 'idle'
    check (sale_status in ('idle', 'listed', 'sold')),
  sale_price numeric(12,2) check (sale_price is null or sale_price >= 0),
  sold_at date,
  buyer_note text,
  transaction_note text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id)
);
create index if not exists idx_sales_owner_entity
  on public.sales(owner_id, entity_type, entity_id);
create index if not exists idx_sales_owner_status
  on public.sales(owner_id, sale_status)
  where deleted_at is null;

create table if not exists public.duplicate_candidates (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  entity_type text not null check (entity_type in ('product', 'book')),
  left_id text not null,
  right_id text not null,
  reason text not null,
  score numeric(4,3) not null default 0 check (score >= 0 and score <= 1),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'ignored')),
  confirmed_at timestamptz,
  note text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  constraint duplicate_candidates_order_check check (left_id < right_id),
  unique (owner_id, entity_type, left_id, right_id)
);
create index if not exists idx_duplicate_candidates_status
  on public.duplicate_candidates(owner_id, status, score desc);

-- 订单汇总视图：应付/已付/退款/待补
create or replace view public.v_order_totals
with (security_invoker = true)
as
select
  o.owner_id,
  o.id as order_id,
  o.order_no,
  o.shop_name,
  o.status,
  o.balance_due_date,
  o.total_amount,
  o.shipping_fee,
  o.discount_amount,
  (o.total_amount + o.shipping_fee - o.discount_amount) as payable,
  coalesce(sum(case when p.kind = 'refund' then -p.amount else p.amount end), 0)::numeric(12,2) as paid,
  coalesce(sum(case when p.kind = 'refund' then p.amount else 0 end), 0)::numeric(12,2) as refunded,
  greatest(
    (o.total_amount + o.shipping_fee - o.discount_amount) -
    coalesce(sum(case when p.kind = 'refund' then -p.amount else p.amount end), 0),
    0
  )::numeric(12,2) as balance_due,
  count(p.id)::int as payment_count,
  max(p.paid_at) as last_paid_at
from public.orders o
left join public.payment_records p
  on p.owner_id = o.owner_id and p.order_id = o.id and p.deleted_at is null
where o.deleted_at is null
group by o.owner_id, o.id;
