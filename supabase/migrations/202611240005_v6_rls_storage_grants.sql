-- ============================================================================
-- V6 P1 · 005 RLS, grants, revision triggers, realtime
-- 所有私人表 owner_id = auth.uid()；公开参考表只读。
-- ============================================================================

-- 公开参考表 ----------------------------------------------------------------
alter table public.collection_types enable row level security;
drop policy if exists "collection_types_public_read" on public.collection_types;
create policy "collection_types_public_read" on public.collection_types
for select to anon, authenticated using (true);

-- 20 内置主分类：允许 authenticated 改名/排序；禁止增删
drop policy if exists "main_categories_update_auth" on public.main_categories;
create policy "main_categories_update_auth" on public.main_categories
for update to authenticated using (true) with check (true);

-- 作品/角色：公开读；自定义行可写；内置行可改不可删
drop policy if exists "works_insert_auth" on public.works;
create policy "works_insert_auth" on public.works
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "works_update_auth" on public.works;
create policy "works_update_auth" on public.works
for update to authenticated
using (owner_id is null or (select auth.uid()) = owner_id)
with check (owner_id is null or (select auth.uid()) = owner_id);

drop policy if exists "works_delete_auth" on public.works;
create policy "works_delete_auth" on public.works
for delete to authenticated
using ((select auth.uid()) = owner_id and is_builtin = false);

drop policy if exists "characters_insert_auth" on public.characters;
create policy "characters_insert_auth" on public.characters
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "characters_update_auth" on public.characters;
create policy "characters_update_auth" on public.characters
for update to authenticated
using (owner_id is null or (select auth.uid()) = owner_id)
with check (owner_id is null or (select auth.uid()) = owner_id);

drop policy if exists "characters_delete_auth" on public.characters;
create policy "characters_delete_auth" on public.characters
for delete to authenticated
using ((select auth.uid()) = owner_id and is_builtin = false);

-- 私人表统一策略 ------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'status_definitions', 'main_category_prefs', 'custom_main_categories',
    'series', 'series_items', 'locations', 'field_definitions', 'field_values',
    'book_types', 'book_sets', 'books',
    'orders', 'order_items', 'payment_records', 'sales', 'duplicate_candidates',
    'achievements', 'user_achievements', 'item_images'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = owner_id)', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = owner_id)', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id)', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = owner_id)', t || '_delete_own', t);
  end loop;
end $$;

-- 只追加表：select + insert，不 update/delete
do $$
declare
  t text;
  tables text[] := array['status_history', 'price_history'];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = owner_id)', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = owner_id)', t || '_insert_own', t);
  end loop;
end $$;

-- 表级 GRANT ---------------------------------------------------------------
grant select on public.collection_types to anon, authenticated;
grant insert, update, delete on public.works, public.characters to authenticated;
grant update on public.main_categories to authenticated;

grant select, insert, update, delete on
  public.status_definitions, public.main_category_prefs, public.custom_main_categories,
  public.series, public.series_items, public.locations,
  public.field_definitions, public.field_values,
  public.book_types, public.book_sets, public.books,
  public.orders, public.order_items, public.payment_records,
  public.sales, public.duplicate_candidates,
  public.achievements, public.user_achievements, public.item_images
to authenticated;

grant select, insert on public.status_history, public.price_history to authenticated;
grant select on
  public.v_effective_main_categories,
  public.v_order_totals,
  public.v_pending_balances,
  public.v_owned_counts,
  public.v_collection_items
to authenticated;

-- revision 触发器（只对可编辑表）
do $$
declare
  t text;
  tables text[] := array[
    'works', 'characters', 'main_categories',
    'status_definitions', 'main_category_prefs', 'custom_main_categories',
    'series', 'series_items', 'locations', 'field_definitions', 'field_values',
    'book_types', 'book_sets', 'books',
    'orders', 'order_items', 'payment_records', 'sales', 'duplicate_candidates',
    'achievements', 'user_achievements', 'item_images'
  ];
begin
  foreach t in array tables loop
    execute format('drop trigger if exists trg_%I_revision on public.%I', t, t);
    execute format('create trigger trg_%I_revision before update on public.%I for each row execute function public.bump_revision()', t, t);
  end loop;
end $$;

-- Realtime（可选；失败不影响前台刷新）
do $$
declare
  t text;
  tables text[] := array[
    'products', 'collections', 'books', 'book_sets', 'series', 'series_items',
    'orders', 'order_items', 'payment_records', 'item_images',
    'status_definitions', 'custom_main_categories', 'achievements',
    'user_achievements', 'locations', 'price_history', 'sales',
    'field_definitions', 'field_values'
  ];
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array tables loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
