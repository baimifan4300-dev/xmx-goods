-- ============================================================================
-- V6 P1 · 006 seed + backfill (idempotent)
-- 只补默认值/迁移旧数据；不删除 V5 表/行。
-- ============================================================================

insert into public.collection_types (key, label, icon, sort_order, is_system)
values
  ('goods', '谷子收藏', '✦', 1, true),
  ('books', '书籍收藏', '▤', 2, true)
on conflict (key) do update set
  label = excluded.label,
  icon = excluded.icon,
  sort_order = excluded.sort_order;

-- 每个现有账号：六种状态
insert into public.status_definitions
  (owner_id, id, scope, label, color, icon, sort_order, is_builtin, counts_as_owned, is_terminal)
select u.id, v.id, 'all', v.label, v.color, v.icon, v.sort_order, true, v.counts_as_owned, v.is_terminal
from auth.users u
cross join (values
  ('want',      '想要',     '#d989a2', '☆', 1, false, false),
  ('watch',     '蹲价格',   '#c9a36b', '◷', 2, false, false),
  ('preorder',  '已预订',   '#8f9ec9', '◇', 3, false, false),
  ('balance',   '待补尾款', '#d08b5b', '!', 4, false, false),
  ('owned',     '已入手',   '#6f9b76', '✓', 5, true,  false),
  ('cancelled', '已取消',   '#9b9b9b', '×', 6, false, true)
) as v(id, label, color, icon, sort_order, counts_as_owned, is_terminal)
on conflict do nothing;

-- 每个现有账号：五种书籍类型
insert into public.book_types (owner_id, id, label, sort_order, is_builtin)
select u.id, v.id, v.label, v.sort_order, true
from auth.users u
cross join (values
  ('manga', '漫画', 1),
  ('novel', '小说', 2),
  ('artbook', '画集', 3),
  ('setting', '设定集', 4),
  ('other', '其他书籍', 5)
) as v(id, label, sort_order)
on conflict do nothing;

-- 内置标记
update public.works set is_builtin = true, owner_id = null
where id = 'gyly' and owner_id is null;

update public.characters set is_builtin = true, owner_id = null
where work_id = 'gyly' and id = 'xmx' and owner_id is null;

update public.main_categories set is_builtin = true
where is_builtin is null or is_builtin = false;

-- 旧收藏默认「已入手」
update public.collections set status_id = 'owned' where status_id is null;
alter table public.collections alter column status_id set default 'owned';
alter table public.collections alter column status_id set not null;

-- wishlist → collections（保留 wishlist 原表，不删除）
insert into public.collections
  (owner_id, product_id, quantity, status_id, note, created_at, updated_at)
select w.owner_id, w.product_id, 1, 'want', null, w.created_at, w.updated_at
from public.wishlist w
where not exists (
  select 1 from public.collections c
  where c.owner_id = w.owner_id and c.product_id = w.product_id
)
and exists (
  select 1 from public.status_definitions s
  where s.owner_id = w.owner_id and s.id = 'want'
);

-- product_images → item_images（镜像元数据，不复制文件）
insert into public.item_images
  (owner_id, entity_type, entity_id, kind, storage_path, thumb_path,
   is_primary, sort_order, caption, mime_type, size_bytes, width, height, revision)
select
  pi.owner_id,
  'product',
  pi.product_id,
  case when pi.kind = 'highres' then 'photo' else 'cover' end,
  pi.storage_path,
  pi.thumb_path,
  (pi.kind = 'highres') or not exists (
    select 1 from public.product_images hi
    where hi.owner_id = pi.owner_id and hi.product_id = pi.product_id and hi.kind = 'highres'
  ),
  0,
  pi.file_name,
  pi.mime_type,
  pi.size_bytes,
  pi.width,
  pi.height,
  1
from public.product_images pi
where not exists (
  select 1 from public.item_images ii
  where ii.owner_id = pi.owner_id and ii.entity_type = 'product'
    and ii.entity_id = pi.product_id and ii.storage_path = pi.storage_path
);

-- products.series 文本 → series 记录 + series_id（保留原文本）
insert into public.series (owner_id, id, type, name, sort_order)
select x.owner_id, gen_random_uuid(), 'goods', x.series, 0
from (
  select p.owner_id, btrim(p.series) as series
  from public.products p
  where p.series is not null
    and btrim(p.series) <> ''
    and p.deleted_at is null
  group by p.owner_id, btrim(p.series)
) x
where not exists (
  select 1 from public.series s
  where s.owner_id = x.owner_id and s.type = 'goods'
    and s.name = x.series and s.deleted_at is null
);

update public.products p
set series_id = s.id
from public.series s
where p.owner_id = s.owner_id
  and s.type = 'goods'
  and s.deleted_at is null
  and p.series is not null
  and btrim(p.series) = s.name
  and p.series_id is null;

-- 新账号自动 seed 六状态 + 五书籍类型（替换 V5 的 handle_new_user）
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

  insert into public.status_definitions
    (owner_id, id, scope, label, color, icon, sort_order, is_builtin, counts_as_owned, is_terminal)
  values
    (new.id, 'want',      'all', '想要',     '#d989a2', '☆', 1, true, false, false),
    (new.id, 'watch',     'all', '蹲价格',   '#c9a36b', '◷', 2, true, false, false),
    (new.id, 'preorder',  'all', '已预订',   '#8f9ec9', '◇', 3, true, false, false),
    (new.id, 'balance',   'all', '待补尾款', '#d08b5b', '!', 4, true, false, false),
    (new.id, 'owned',     'all', '已入手',   '#6f9b76', '✓', 5, true, true,  false),
    (new.id, 'cancelled', 'all', '已取消',   '#9b9b9b', '×', 6, true, false, true)
  on conflict (owner_id, id) do nothing;

  insert into public.book_types (owner_id, id, label, sort_order, is_builtin)
  values
    (new.id, 'manga', '漫画', 1, true),
    (new.id, 'novel', '小说', 2, true),
    (new.id, 'artbook', '画集', 3, true),
    (new.id, 'setting', '设定集', 4, true),
    (new.id, 'other', '其他书籍', 5, true)
  on conflict (owner_id, id) do nothing;

  return new;
end;
$$;
