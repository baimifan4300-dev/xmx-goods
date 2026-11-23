-- ============================================================================
-- 星愿收藏室 v5 · Supabase PostgreSQL schema
-- 目标：所有用户数据按 owner_id 隔离；20 个主分类为全局只读配置。
-- 迁移顺序：001_schema.sql → 002_rls.sql → 003_seed.sql
-- ============================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.works (
  id text primary key,
  title text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.characters (
  work_id text not null references public.works(id) on delete cascade,
  id text not null,
  name text not null,
  theme jsonb not null default '{}'::jsonb,
  catalog text,
  total integer not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (work_id, id)
);

create table if not exists public.main_categories (
  key text primary key,
  label text not null,
  sort_order integer not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  name text not null,
  category text,
  category_label text,
  series text,
  work_id text not null default 'gyly',
  character_id text not null default 'xmx',
  version text,
  price numeric(12,2),
  price_text text,
  release_date text,
  product_code text,
  image jsonb not null default '{}'::jsonb,
  folder text,
  verification_status text,
  duplicate_group text,
  notes text,
  main_category text,
  main_category_key text,
  board text,
  board_key text,
  classification_status text,
  classification_basis text,
  classification_confidence text,
  classification_section_title text,
  classification_row integer,
  variety text,
  market_price numeric(12,2),
  payload jsonb not null default '{}'::jsonb,
  is_user_created boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  constraint products_board_key_check check (board_key is null or board_key in ('collab', 'gift')),
  constraint products_market_price_check check (market_price is null or market_price >= 0),
  constraint products_price_check check (price is null or price >= 0),
  constraint products_work_character_fk foreign key (work_id, character_id)
    references public.characters(work_id, id) on update cascade on delete restrict
);

create table if not exists public.collections (
  owner_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  quantity integer not null default 1 check (quantity >= 1),
  purchase_price numeric(12,2),
  purchase_date date,
  note text,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, product_id),
  constraint collections_purchase_price_check check (purchase_price is null or purchase_price >= 0),
  constraint collections_product_fk foreign key (owner_id, product_id)
    references public.products(owner_id, id) on delete cascade
);

create table if not exists public.wishlist (
  owner_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, product_id),
  constraint wishlist_product_fk foreign key (owner_id, product_id)
    references public.products(owner_id, id) on delete cascade
);

create table if not exists public.board_categories (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  work_id text not null default 'gyly',
  character_id text not null default 'xmx',
  board_key text not null,
  name text not null,
  sort_order integer not null default 0,
  is_default boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  constraint board_categories_board_key_check check (board_key in ('collab', 'gift')),
  constraint board_categories_name_check check (char_length(name) between 1 and 20),
  constraint board_categories_name_unique unique (owner_id, work_id, character_id, board_key, name),
  constraint board_categories_work_character_fk foreign key (work_id, character_id)
    references public.characters(work_id, id) on update cascade on delete restrict
);

create table if not exists public.board_assignments (
  owner_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  board_key text not null,
  category_id text not null,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, product_id, board_key),
  constraint board_assignments_board_key_check check (board_key in ('collab', 'gift')),
  constraint board_assignments_product_fk foreign key (owner_id, product_id)
    references public.products(owner_id, id) on delete cascade,
  constraint board_assignments_category_fk foreign key (owner_id, category_id)
    references public.board_categories(owner_id, id) on delete cascade
);

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  kind text not null,
  storage_path text not null,
  thumb_path text,
  file_name text,
  mime_type text,
  size_bytes bigint,
  width integer,
  height integer,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_images_kind_check check (kind in ('cover', 'highres')),
  constraint product_images_unique unique (owner_id, product_id, kind),
  constraint product_images_product_fk foreign key (owner_id, product_id)
    references public.products(owner_id, id) on delete cascade,
  constraint product_images_size_check check (size_bytes is null or size_bytes >= 0),
  constraint product_images_dimensions_check check (
    (width is null or width > 0) and (height is null or height > 0)
  )
);

create table if not exists public.user_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.backup_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'export',
  format_version integer not null default 2,
  counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_products_owner_board on public.products(owner_id, board_key);
create index if not exists idx_products_owner_main on public.products(owner_id, main_category_key);
create index if not exists idx_products_owner_updated on public.products(owner_id, updated_at desc);
create index if not exists idx_collections_owner on public.collections(owner_id);
create index if not exists idx_wishlist_owner on public.wishlist(owner_id);
create index if not exists idx_board_categories_owner_board on public.board_categories(owner_id, board_key, sort_order);
create index if not exists idx_board_assignments_owner_category on public.board_assignments(owner_id, category_id);
create index if not exists idx_product_images_owner_product on public.product_images(owner_id, product_id);
create index if not exists idx_backup_logs_owner_created on public.backup_logs(owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at / revision triggers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.bump_revision()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.revision = coalesce(old.revision, 0) + 1;
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
for each row execute function public.set_updated_at();

do $$
declare
  t text;
begin
  foreach t in array array['products', 'collections', 'wishlist', 'board_categories', 'board_assignments', 'product_images', 'user_settings']
  loop
    execute format('drop trigger if exists trg_%I_revision on public.%I', t, t);
    execute format('create trigger trg_%I_revision before update on public.%I for each row execute function public.bump_revision()', t, t);
  end loop;
end;
$$;

-- 归属校验：商品必须属于同一板块，分类必须存在且属于同一板块
create or replace function public.validate_board_assignment()
returns trigger
language plpgsql
as $$
declare
  product_board text;
  category_board text;
begin
  select board_key into product_board
  from public.products
  where owner_id = new.owner_id and id = new.product_id;

  select board_key into category_board
  from public.board_categories
  where owner_id = new.owner_id and id = new.category_id;

  if product_board is null or product_board <> new.board_key then
    raise exception '商品不属于指定板块';
  end if;
  if category_board is null or category_board <> new.board_key then
    raise exception '分类不存在或不属于指定板块';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_board_assignments_validate on public.board_assignments;
create trigger trg_board_assignments_validate
before insert or update on public.board_assignments
for each row execute function public.validate_board_assignment();

-- ---------------------------------------------------------------------------
-- 新用户自动建立 profile 与 settings
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  insert into public.user_settings (owner_id, settings)
  values (new.id, '{}'::jsonb)
  on conflict (owner_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- 为迁移前已存在的账号补 profile/settings
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

insert into public.user_settings (owner_id, settings)
select id, '{}'::jsonb from auth.users
on conflict (owner_id) do nothing;

-- ---------------------------------------------------------------------------
-- 注释
-- ---------------------------------------------------------------------------
comment on table public.products is '用户商品；payload 保存完整原始字段（含 1537 条图鉴的全部字段）';
comment on column public.products.payload is '完整商品 JSON，含原始字段与未知扩展字段，确保迁移不丢字段';
comment on column public.products.market_price is '市场价格，独立于收藏表的实际购买价';
comment on table public.collections is '收藏记录；quantity 支持大于 1，purchase_price 为实际购买价';
comment on table public.product_images is '用户上传图片元数据；文件在 Supabase Storage product-images 私有桶';
comment on table public.board_categories is '用户自定义联动/满赠分类，ID 保留 V4 本地分类 ID';
comment on table public.board_assignments is '商品与联动/满赠分类关联；没有记录即未分类';
