-- ============================================================================
-- V6 P1 · 001 core tables
-- 增量：不改 V5 主键/外键/1537 条商品；只加新表、可空列、索引。
-- 执行顺序：001 → 002 → 003 → 004 → 005 → 006
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 收藏类型（全局只读；未来新增类型时再扩展明细表/视图）
-- ---------------------------------------------------------------------------
create table if not exists public.collection_types (
  key text primary key,
  label text not null,
  icon text,
  sort_order integer not null default 0,
  is_system boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_collection_types_active
  on public.collection_types(is_active, sort_order);

-- ---------------------------------------------------------------------------
-- 状态定义（每账号一套；默认六种由 006 seed）
-- ---------------------------------------------------------------------------
create table if not exists public.status_definitions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  scope text not null default 'all' check (scope in ('goods', 'books', 'all')),
  label text not null check (char_length(label) between 1 and 20),
  color text,
  icon text,
  icon_path text,
  sort_order integer not null default 0,
  is_builtin boolean not null default false,
  counts_as_owned boolean not null default false,
  is_terminal boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id)
);
create unique index if not exists uq_status_definitions_scope_label
  on public.status_definitions(owner_id, scope, label)
  where deleted_at is null;
create index if not exists idx_status_definitions_owner_scope
  on public.status_definitions(owner_id, scope, sort_order)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 20 个内置主分类的显示名/顺序覆盖（只覆盖，不删除内置行）
-- ---------------------------------------------------------------------------
create table if not exists public.main_category_prefs (
  owner_id uuid not null references auth.users(id) on delete cascade,
  category_key text not null references public.main_categories(key) on delete cascade,
  label text not null check (char_length(label) between 1 and 20),
  sort_order integer not null default 0,
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, category_key)
);
create index if not exists idx_main_category_prefs_order
  on public.main_category_prefs(owner_id, sort_order);

-- ---------------------------------------------------------------------------
-- 自定义主分类（按账号隔离；删除前必须把商品重归类）
-- ---------------------------------------------------------------------------
create table if not exists public.custom_main_categories (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  label text not null check (char_length(label) between 1 and 20),
  sort_order integer not null default 0,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id)
);
create unique index if not exists uq_custom_main_categories_label
  on public.custom_main_categories(owner_id, label)
  where deleted_at is null;
create index if not exists idx_custom_main_categories_order
  on public.custom_main_categories(owner_id, sort_order)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 系列（谷子/书籍共用；套书可以不挂系列）
-- ---------------------------------------------------------------------------
create table if not exists public.series (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  type text not null check (type in ('goods', 'books')),
  name text not null check (char_length(name) between 1 and 80),
  work_id text references public.works(id) on delete set null,
  character_id text,
  description text,
  cover_image_id uuid,
  total_expected integer check (total_expected is null or total_expected >= 0),
  sort_order integer not null default 0,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id)
);
create unique index if not exists uq_series_owner_type_name
  on public.series(owner_id, type, name)
  where deleted_at is null;
create index if not exists idx_series_owner_type_order
  on public.series(owner_id, type, sort_order)
  where deleted_at is null;
create index if not exists idx_series_owner_work_character
  on public.series(owner_id, work_id, character_id);

-- ---------------------------------------------------------------------------
-- 系列清单项（可关联已有商品/书籍，也可手工维护官方款）
-- ---------------------------------------------------------------------------
create table if not exists public.series_items (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  series_id uuid not null,
  entity_type text not null default 'manual'
    check (entity_type in ('product', 'book', 'manual')),
  product_id text,
  book_id uuid,
  display_name text,
  image_path text,
  official_no text,
  volume_label text,
  status_id text,
  sort_order integer not null default 0,
  note text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id),
  constraint series_items_series_fk
    foreign key (owner_id, series_id) references public.series(owner_id, id) on delete cascade,
  constraint series_items_product_fk
    foreign key (owner_id, product_id) references public.products(owner_id, id) on delete set null,
  constraint series_items_status_fk
    foreign key (owner_id, status_id) references public.status_definitions(owner_id, id) on delete set null,
  constraint series_items_target_check check (
    (entity_type = 'product' and product_id is not null) or
    (entity_type = 'book' and book_id is not null) or
    (entity_type = 'manual' and (display_name is not null or official_no is not null))
  )
);
create unique index if not exists uq_series_items_official_no
  on public.series_items(owner_id, series_id, official_no)
  where official_no is not null and deleted_at is null;
create index if not exists idx_series_items_owner_series
  on public.series_items(owner_id, series_id, sort_order)
  where deleted_at is null;
create index if not exists idx_series_items_product
  on public.series_items(owner_id, product_id);

-- ---------------------------------------------------------------------------
-- 收藏地点（房间/柜子/抽屉/展示柜/收纳盒，可层级）
-- ---------------------------------------------------------------------------
create table if not exists public.locations (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  kind text not null default 'other'
    check (kind in ('room', 'cabinet', 'drawer', 'display', 'box', 'other')),
  parent_id uuid,
  sort_order integer not null default 0,
  note text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id),
  constraint locations_parent_fk
    foreign key (owner_id, parent_id) references public.locations(owner_id, id) on delete set null
);
create unique index if not exists uq_locations_parent_name
  on public.locations(owner_id, parent_id, name)
  where deleted_at is null;
create index if not exists idx_locations_owner_parent
  on public.locations(owner_id, parent_id, sort_order)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 自定义字段定义/值（商品与书籍共用；不反复改表结构）
-- ---------------------------------------------------------------------------
create table if not exists public.field_definitions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  scope text not null default 'all' check (scope in ('goods', 'books', 'all')),
  key text not null,
  label text not null check (char_length(label) between 1 and 40),
  field_type text not null
    check (field_type in ('text', 'textarea', 'number', 'date', 'select', 'multiselect', 'url', 'image')),
  options jsonb not null default '[]'::jsonb,
  required boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id)
);
create unique index if not exists uq_field_definitions_key
  on public.field_definitions(owner_id, scope, key)
  where deleted_at is null;
create index if not exists idx_field_definitions_owner_scope
  on public.field_definitions(owner_id, scope, sort_order)
  where deleted_at is null;

create table if not exists public.field_values (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  field_id uuid not null,
  entity_type text not null check (entity_type in ('product', 'book')),
  entity_id text not null,
  value_text text,
  value_number numeric,
  value_date date,
  value_json jsonb,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  constraint field_values_field_fk
    foreign key (owner_id, field_id) references public.field_definitions(owner_id, id) on delete cascade,
  constraint field_values_one_value_check check (
    value_text is not null or value_number is not null or value_date is not null or value_json is not null
  )
);
create unique index if not exists uq_field_values_entity
  on public.field_values(owner_id, field_id, entity_type, entity_id);
create index if not exists idx_field_values_entity
  on public.field_values(owner_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- 状态变更历史（只追加；报告/获得时间用）
-- ---------------------------------------------------------------------------
create table if not exists public.status_history (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  entity_type text not null check (entity_type in ('product', 'book')),
  entity_id text not null,
  from_status_id text,
  to_status_id text not null,
  changed_at timestamptz not null default now(),
  note text,
  primary key (owner_id, id),
  constraint status_history_to_status_fk
    foreign key (owner_id, to_status_id) references public.status_definitions(owner_id, id) on delete restrict
);
create index if not exists idx_status_history_entity
  on public.status_history(owner_id, entity_type, entity_id, changed_at);
create index if not exists idx_status_history_to_status
  on public.status_history(owner_id, to_status_id, changed_at);

-- ---------------------------------------------------------------------------
-- 现有表增量列（全部可空/带默认，不动原行）
-- ---------------------------------------------------------------------------
alter table public.products
  add column if not exists series_id uuid,
  add column if not exists market_price_date date,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_reason text,
  add column if not exists updated_by uuid;

alter table public.collections
  add column if not exists status_id text,
  add column if not exists target_price numeric(12,2),
  add column if not exists purchase_url text,
  add column if not exists store_name text,
  add column if not exists expected_arrival_date date,
  add column if not exists wishlist_note text,
  add column if not exists location_id uuid,
  add column if not exists received_at date,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_reason text;

alter table public.works
  add column if not exists owner_id uuid references auth.users(id) on delete cascade,
  add column if not exists is_builtin boolean not null default false,
  add column if not exists revision integer not null default 1,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists deleted_at timestamptz;

alter table public.characters
  add column if not exists owner_id uuid references auth.users(id) on delete cascade,
  add column if not exists is_builtin boolean not null default false,
  add column if not exists revision integer not null default 1,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists deleted_at timestamptz;

alter table public.main_categories
  add column if not exists is_builtin boolean not null default true,
  add column if not exists revision integer not null default 1,
  add column if not exists updated_at timestamptz not null default now();

-- 现有表的 FK（用 DO 保证幂等）
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_series_fk') then
    alter table public.products
      add constraint products_series_fk
      foreign key (owner_id, series_id) references public.series(owner_id, id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'collections_status_fk') then
    alter table public.collections
      add constraint collections_status_fk
      foreign key (owner_id, status_id) references public.status_definitions(owner_id, id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'collections_location_fk') then
    alter table public.collections
      add constraint collections_location_fk
      foreign key (owner_id, location_id) references public.locations(owner_id, id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 索引
-- ---------------------------------------------------------------------------
create index if not exists idx_products_owner_work_char
  on public.products(owner_id, work_id, character_id);
create index if not exists idx_products_owner_series
  on public.products(owner_id, series_id);
create index if not exists idx_products_owner_market_date
  on public.products(owner_id, market_price_date);
create index if not exists idx_products_owner_active
  on public.products(owner_id) where deleted_at is null;
create index if not exists idx_collections_owner_status
  on public.collections(owner_id, status_id);
create index if not exists idx_collections_owner_location
  on public.collections(owner_id, location_id);
create index if not exists idx_collections_owner_active
  on public.collections(owner_id) where deleted_at is null;
create index if not exists idx_works_owner on public.works(owner_id);
create index if not exists idx_characters_owner on public.characters(owner_id);
create index if not exists idx_characters_work_order on public.characters(work_id, sort_order);
create index if not exists idx_main_categories_order on public.main_categories(sort_order);
