-- ============================================================================
-- V6 P1 · 004 achievements, images, unified views
-- ============================================================================

create table if not exists public.achievements (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  description text,
  category text not null default '收藏',
  icon_path text,
  badge_type text not null default 'custom' check (badge_type in ('system', 'custom')),
  rule_type text not null default 'manual'
    check (rule_type in ('count', 'series_complete', 'character_complete', 'book_set_complete', 'monthly', 'yearly', 'manual')),
  rule_config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id)
);
create unique index if not exists uq_achievements_name
  on public.achievements(owner_id, name)
  where deleted_at is null;
create index if not exists idx_achievements_owner_type
  on public.achievements(owner_id, badge_type, sort_order)
  where deleted_at is null;

create table if not exists public.user_achievements (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  achievement_id uuid not null,
  status text not null default 'locked' check (status in ('locked', 'unlocked')),
  progress numeric not null default 0,
  unlocked_at timestamptz,
  award_source text not null default 'auto' check (award_source in ('auto', 'manual')),
  note text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  constraint user_achievements_achievement_fk
    foreign key (owner_id, achievement_id) references public.achievements(owner_id, id) on delete cascade,
  unique (owner_id, achievement_id)
);
create index if not exists idx_user_achievements_owner_status
  on public.user_achievements(owner_id, status, unlocked_at desc);

create table if not exists public.item_images (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  entity_type text not null
    check (entity_type in ('product', 'book', 'book_set', 'series_item', 'achievement', 'status')),
  entity_id text not null,
  kind text not null default 'photo'
    check (kind in ('cover', 'photo', 'detail', 'package', 'other')),
  storage_path text not null,
  thumb_path text,
  is_primary boolean not null default false,
  sort_order integer not null default 0,
  caption text,
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id),
  unique (owner_id, entity_type, entity_id, storage_path)
);
create unique index if not exists uq_item_images_primary
  on public.item_images(owner_id, entity_type, entity_id)
  where is_primary and deleted_at is null;
create index if not exists idx_item_images_entity
  on public.item_images(owner_id, entity_type, entity_id, sort_order)
  where deleted_at is null;

-- 20 内置 + 覆盖 + 自定义；owner_id 为 null 的 20 行是全局默认
create or replace view public.v_effective_main_categories
with (security_invoker = true)
as
select
  p.owner_id,
  mc.key,
  coalesce(p.label, mc.label) as label,
  coalesce(p.sort_order, mc.sort_order) as sort_order,
  true as is_builtin
from public.main_categories mc
left join public.main_category_prefs p on p.category_key = mc.key
union all
select owner_id, id, label, sort_order, false
from public.custom_main_categories
where deleted_at is null;

-- 订单待补视图
create or replace view public.v_pending_balances
with (security_invoker = true)
as
select
  t.*,
  (t.balance_due_date - current_date) as days_left,
  (t.balance_due_date is not null and t.balance_due_date < current_date) as overdue
from public.v_order_totals t
where t.status = 'open' and t.balance_due > 0;

-- 按类型统计真正已拥有
create or replace view public.v_owned_counts
with (security_invoker = true)
as
select c.owner_id, 'goods'::text as collection_type,
       count(*)::int as owned_kinds,
       coalesce(sum(c.quantity), 0)::int as owned_pieces
from public.collections c
join public.status_definitions s
  on s.owner_id = c.owner_id and s.id = c.status_id
where c.deleted_at is null and s.counts_as_owned
group by c.owner_id
union all
select b.owner_id, 'books'::text,
       count(*)::int,
       coalesce(sum(b.quantity), 0)::int
from public.books b
join public.status_definitions s
  on s.owner_id = b.owner_id and s.id = b.status_id
where b.deleted_at is null and s.counts_as_owned
group by b.owner_id;

-- 统一搜索视图
create or replace view public.v_collection_items
with (security_invoker = true)
as
select
  p.owner_id,
  'goods'::text as collection_type,
  p.id as entity_id,
  p.name as title,
  null::text as subtitle,
  p.work_id,
  p.character_id,
  p.series_id,
  p.main_category_key as category_key,
  coalesce(mc.label, cc.label, p.main_category) as category_label,
  p.product_code as code,
  null::text as isbn,
  null::text as author,
  null::text as publisher,
  c.status_id,
  s.label as status_label,
  s.counts_as_owned,
  p.market_price,
  p.market_price_date,
  c.purchase_price,
  c.location_id,
  coalesce(img.storage_path, p.image->>'thumb', p.image->>'src') as cover_path,
  p.deleted_at
from public.products p
left join public.collections c
  on c.owner_id = p.owner_id and c.product_id = p.id and c.deleted_at is null
left join public.status_definitions s
  on s.owner_id = c.owner_id and s.id = c.status_id
left join public.main_categories mc on mc.key = p.main_category_key
left join public.custom_main_categories cc
  on cc.owner_id = p.owner_id and cc.id = p.main_category_key and cc.deleted_at is null
left join lateral (
  select storage_path from public.item_images
  where owner_id = p.owner_id and entity_type = 'product' and entity_id = p.id
    and deleted_at is null
  order by is_primary desc, sort_order, created_at
  limit 1
) img on true
where p.deleted_at is null
union all
select
  b.owner_id,
  'books'::text,
  b.id::text,
  b.title,
  b.subtitle,
  null::text,
  null::text,
  bs.series_id,
  b.book_type_id,
  bt.label,
  b.isbn,
  b.isbn,
  b.author,
  b.publisher,
  b.status_id,
  s.label,
  s.counts_as_owned,
  b.market_price,
  b.market_price_date,
  b.purchase_price,
  b.location_id,
  img.storage_path as cover_path,
  b.deleted_at
from public.books b
left join public.book_sets bs
  on bs.owner_id = b.owner_id and bs.id = b.set_id and bs.deleted_at is null
left join public.book_types bt
  on bt.owner_id = b.owner_id and bt.id = b.book_type_id and bt.deleted_at is null
left join public.status_definitions s
  on s.owner_id = b.owner_id and s.id = b.status_id
left join lateral (
  select storage_path from public.item_images
  where owner_id = b.owner_id and entity_type = 'book' and entity_id = b.id::text
    and deleted_at is null
  order by is_primary desc, sort_order, created_at
  limit 1
) img on true
where b.deleted_at is null;
