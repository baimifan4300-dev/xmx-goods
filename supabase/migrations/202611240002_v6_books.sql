-- ============================================================================
-- V6 P1 · 002 books
-- 套书是可选分组；独立单本 set_id = null；一行 = 一卷/一本。
-- ============================================================================

create table if not exists public.book_types (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  label text not null check (char_length(label) between 1 and 20),
  sort_order integer not null default 0,
  is_builtin boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id)
);
create unique index if not exists uq_book_types_label
  on public.book_types(owner_id, label)
  where deleted_at is null;
create index if not exists idx_book_types_owner_order
  on public.book_types(owner_id, sort_order)
  where deleted_at is null;

create table if not exists public.book_sets (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  series_id uuid,
  title text not null check (char_length(title) between 1 and 120),
  book_type_id text,
  language text,
  publisher text,
  edition text,
  binding text,
  total_volumes integer check (total_volumes is null or total_volumes > 0),
  description text,
  cover_image_id uuid,
  sort_order integer not null default 0,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id),
  constraint book_sets_series_fk
    foreign key (owner_id, series_id) references public.series(owner_id, id) on delete set null,
  constraint book_sets_type_fk
    foreign key (owner_id, book_type_id) references public.book_types(owner_id, id) on delete set null
);
create index if not exists idx_book_sets_owner_series
  on public.book_sets(owner_id, series_id)
  where deleted_at is null;
create index if not exists idx_book_sets_owner_order
  on public.book_sets(owner_id, sort_order)
  where deleted_at is null;

create table if not exists public.books (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  set_id uuid,
  book_type_id text,
  title text not null check (char_length(title) between 1 and 160),
  subtitle text,
  author text,
  illustrator text,
  publisher text,
  language text,
  edition text,
  binding text,
  volume_label text,
  volume_number numeric,
  isbn text,
  cover_image_id uuid,
  purchase_price numeric(12,2) check (purchase_price is null or purchase_price >= 0),
  market_price numeric(12,2) check (market_price is null or market_price >= 0),
  market_price_date date,
  purchase_date date,
  purchase_channel text,
  status_id text default 'want',
  location_id uuid,
  quantity integer not null default 1 check (quantity >= 1),
  notes text,
  received_at date,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, id),
  constraint books_set_fk
    foreign key (owner_id, set_id) references public.book_sets(owner_id, id) on delete set null,
  constraint books_type_fk
    foreign key (owner_id, book_type_id) references public.book_types(owner_id, id) on delete set null,
  constraint books_status_fk
    foreign key (owner_id, status_id) references public.status_definitions(owner_id, id) on delete restrict,
  constraint books_location_fk
    foreign key (owner_id, location_id) references public.locations(owner_id, id) on delete set null
);
create index if not exists idx_books_owner_set_volume
  on public.books(owner_id, set_id, volume_number);
create index if not exists idx_books_owner_isbn
  on public.books(owner_id, isbn) where isbn is not null and deleted_at is null;
create index if not exists idx_books_owner_status
  on public.books(owner_id, status_id) where deleted_at is null;
create index if not exists idx_books_owner_location
  on public.books(owner_id, location_id) where deleted_at is null;
create index if not exists idx_books_owner_active
  on public.books(owner_id) where deleted_at is null;
create index if not exists idx_books_owner_type
  on public.books(owner_id, book_type_id);

-- series_items 在 001 已建；这里补 book_id 外键
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'series_items_book_fk') then
    alter table public.series_items
      add constraint series_items_book_fk
      foreign key (owner_id, book_id) references public.books(owner_id, id) on delete set null;
  end if;
end $$;

-- 套书进度函数（缺卷按 volume_number/label 计算；P3 页面使用）
create or replace function public.book_set_progress(p_owner uuid, p_set uuid)
returns table (
  total_volumes integer,
  owned_volumes integer,
  missing_volumes text[]
)
language sql
stable
security invoker
as $$
  with set_row as (
    select total_volumes from public.book_sets
    where owner_id = p_owner and id = p_set and deleted_at is null
  ),
  vols as (
    select b.volume_number,
           coalesce(nullif(b.volume_label, ''), b.volume_number::text) as label,
           (s.counts_as_owned and b.deleted_at is null) as owned
    from public.books b
    join public.status_definitions s
      on s.owner_id = b.owner_id and s.id = b.status_id
    where b.owner_id = p_owner and b.set_id = p_set
  ),
  missing as (
    select coalesce(array_agg(label order by volume_number nulls last), '{}'::text[]) as labels
    from vols where not owned
  )
  select coalesce((select total_volumes from set_row), (select count(*)::int from vols)),
         (select count(*)::int from vols where owned),
         (select labels from missing);
$$;
