-- ============================================================================
-- 星愿收藏室 v5 · 表级授权（必须执行）
--
-- 背景：Supabase 新建项目不会自动把 public 表的 SELECT/INSERT/UPDATE/DELETE
-- 授予 anon / authenticated。只启用 RLS 而不授权时，登录虽然成功，但所有
-- 查询都会返回：
--   permission denied for table products (SQLSTATE 42501)
-- 前端会显示“没有权限执行该操作，请确认已登录且数据属于当前账号”。
--
-- 本文件只做 GRANT，不修改数据、不删除策略，可重复执行。
-- 执行顺序：001_schema.sql → 002_rls.sql → 003_seed.sql → 004_grants.sql
-- ============================================================================

grant usage on schema public to anon, authenticated;

-- 公开只读配置：未登录也要能读取 20 个主分类、作品、角色 --------------------
grant select on table public.works to anon, authenticated;
grant select on table public.characters to anon, authenticated;
grant select on table public.main_categories to anon, authenticated;

-- 用户私人表：只授权给 authenticated，具体行由 RLS 按 owner_id 隔离 -------
grant select, insert, update, delete on table public.profiles to authenticated;
grant select, insert, update, delete on table public.products to authenticated;
grant select, insert, update, delete on table public.collections to authenticated;
grant select, insert, update, delete on table public.wishlist to authenticated;
grant select, insert, update, delete on table public.board_categories to authenticated;
grant select, insert, update, delete on table public.board_assignments to authenticated;
grant select, insert, update, delete on table public.product_images to authenticated;
grant select, insert, update, delete on table public.user_settings to authenticated;
grant select, insert, delete on table public.backup_logs to authenticated;

-- 以后新增的表/序列默认也授权给 authenticated，避免再次出现同样问题 -------
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

grant usage, select on all sequences in schema public to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;

-- 自检：以下查询应全部返回 true --------------------------------------------
-- select has_table_privilege('anon', 'public.main_categories', 'select') as anon_reads_categories,
--        has_table_privilege('authenticated', 'public.products', 'select') as user_reads_products,
--        has_table_privilege('authenticated', 'public.user_settings', 'update') as user_updates_settings;
