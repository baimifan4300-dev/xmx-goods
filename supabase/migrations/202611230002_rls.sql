-- ============================================================================
-- 星愿收藏室 v5 · Row Level Security + Storage 私有桶
-- 所有用户私人表都只允许 auth.uid() = owner_id；主分类/作品/角色公开只读。
-- ============================================================================

alter table public.profiles enable row level security;
alter table public.works enable row level security;
alter table public.characters enable row level security;
alter table public.main_categories enable row level security;
alter table public.products enable row level security;
alter table public.collections enable row level security;
alter table public.wishlist enable row level security;
alter table public.board_categories enable row level security;
alter table public.board_assignments enable row level security;
alter table public.product_images enable row level security;
alter table public.user_settings enable row level security;
alter table public.backup_logs enable row level security;

-- profiles -----------------------------------------------------------------
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
for insert to authenticated with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
for update to authenticated using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

-- public reference data ------------------------------------------------------
drop policy if exists "works_public_read" on public.works;
create policy "works_public_read" on public.works
for select to anon, authenticated using (true);

drop policy if exists "characters_public_read" on public.characters;
create policy "characters_public_read" on public.characters
for select to anon, authenticated using (true);

drop policy if exists "main_categories_public_read" on public.main_categories;
create policy "main_categories_public_read" on public.main_categories
for select to anon, authenticated using (true);

-- products ------------------------------------------------------------------
drop policy if exists "products_select_own" on public.products;
create policy "products_select_own" on public.products
for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "products_insert_own" on public.products;
create policy "products_insert_own" on public.products
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "products_update_own" on public.products;
create policy "products_update_own" on public.products
for update to authenticated using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "products_delete_own" on public.products;
create policy "products_delete_own" on public.products
for delete to authenticated using ((select auth.uid()) = owner_id);

-- collections ---------------------------------------------------------------
drop policy if exists "collections_select_own" on public.collections;
create policy "collections_select_own" on public.collections
for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "collections_insert_own" on public.collections;
create policy "collections_insert_own" on public.collections
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "collections_update_own" on public.collections;
create policy "collections_update_own" on public.collections
for update to authenticated using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "collections_delete_own" on public.collections;
create policy "collections_delete_own" on public.collections
for delete to authenticated using ((select auth.uid()) = owner_id);

-- wishlist ------------------------------------------------------------------
drop policy if exists "wishlist_select_own" on public.wishlist;
create policy "wishlist_select_own" on public.wishlist
for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "wishlist_insert_own" on public.wishlist;
create policy "wishlist_insert_own" on public.wishlist
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "wishlist_update_own" on public.wishlist;
create policy "wishlist_update_own" on public.wishlist
for update to authenticated using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "wishlist_delete_own" on public.wishlist;
create policy "wishlist_delete_own" on public.wishlist
for delete to authenticated using ((select auth.uid()) = owner_id);

-- board_categories ----------------------------------------------------------
drop policy if exists "board_categories_select_own" on public.board_categories;
create policy "board_categories_select_own" on public.board_categories
for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "board_categories_insert_own" on public.board_categories;
create policy "board_categories_insert_own" on public.board_categories
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "board_categories_update_own" on public.board_categories;
create policy "board_categories_update_own" on public.board_categories
for update to authenticated using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "board_categories_delete_own" on public.board_categories;
create policy "board_categories_delete_own" on public.board_categories
for delete to authenticated using ((select auth.uid()) = owner_id);

-- board_assignments ---------------------------------------------------------
drop policy if exists "board_assignments_select_own" on public.board_assignments;
create policy "board_assignments_select_own" on public.board_assignments
for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "board_assignments_insert_own" on public.board_assignments;
create policy "board_assignments_insert_own" on public.board_assignments
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "board_assignments_update_own" on public.board_assignments;
create policy "board_assignments_update_own" on public.board_assignments
for update to authenticated using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "board_assignments_delete_own" on public.board_assignments;
create policy "board_assignments_delete_own" on public.board_assignments
for delete to authenticated using ((select auth.uid()) = owner_id);

-- product_images ------------------------------------------------------------
drop policy if exists "product_images_select_own" on public.product_images;
create policy "product_images_select_own" on public.product_images
for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "product_images_insert_own" on public.product_images;
create policy "product_images_insert_own" on public.product_images
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "product_images_update_own" on public.product_images;
create policy "product_images_update_own" on public.product_images
for update to authenticated using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "product_images_delete_own" on public.product_images;
create policy "product_images_delete_own" on public.product_images
for delete to authenticated using ((select auth.uid()) = owner_id);

-- user_settings -------------------------------------------------------------
drop policy if exists "user_settings_select_own" on public.user_settings;
create policy "user_settings_select_own" on public.user_settings
for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "user_settings_insert_own" on public.user_settings;
create policy "user_settings_insert_own" on public.user_settings
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "user_settings_update_own" on public.user_settings;
create policy "user_settings_update_own" on public.user_settings
for update to authenticated using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "user_settings_delete_own" on public.user_settings;
create policy "user_settings_delete_own" on public.user_settings
for delete to authenticated using ((select auth.uid()) = owner_id);

-- backup_logs ---------------------------------------------------------------
drop policy if exists "backup_logs_select_own" on public.backup_logs;
create policy "backup_logs_select_own" on public.backup_logs
for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "backup_logs_insert_own" on public.backup_logs;
create policy "backup_logs_insert_own" on public.backup_logs
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "backup_logs_delete_own" on public.backup_logs;
create policy "backup_logs_delete_own" on public.backup_logs
for delete to authenticated using ((select auth.uid()) = owner_id);

-- ---------------------------------------------------------------------------
-- Storage：私有桶 product-images
-- 路径规则：<auth.uid()>/<product_id>/<kind>-<timestamp>.<ext>
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  false,
  12582912,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "product_images_storage_select_own" on storage.objects;
create policy "product_images_storage_select_own" on storage.objects
for select to authenticated using (
  bucket_id = 'product-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "product_images_storage_insert_own" on storage.objects;
create policy "product_images_storage_insert_own" on storage.objects
for insert to authenticated with check (
  bucket_id = 'product-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "product_images_storage_update_own" on storage.objects;
create policy "product_images_storage_update_own" on storage.objects
for update to authenticated using (
  bucket_id = 'product-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
)
with check (
  bucket_id = 'product-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

drop policy if exists "product_images_storage_delete_own" on storage.objects;
create policy "product_images_storage_delete_own" on storage.objects
for delete to authenticated using (
  bucket_id = 'product-images'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
);

-- ---------------------------------------------------------------------------
-- Realtime publication（可选；失败不影响前台刷新同步）
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['products', 'collections', 'wishlist', 'board_categories', 'board_assignments', 'product_images']
    loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;
