# 03 · 增量 Migration、RLS 与 Storage 设计

> 本文只给方案，不包含已执行 SQL；P1 才生成可执行文件。
> 硬约束：**不重建数据库、不删除 V5 表、不修改 1537 条商品 ID/图片/收藏。**

## 1. Migration 文件规划

建议拆成 6 个增量文件，按顺序执行；每个文件可重复执行（`if not exists` / `drop policy if exists` / `on conflict`）。

| 顺序 | 文件 | 作用 |
|---:|---|---|
| 1 | `202611240001_v6_core_tables.sql` | 收藏类型、状态、分类扩展、地点、系列、字段定义/值、软删除列 |
| 2 | `202611240002_v6_books.sql` | 书籍类型、套书、书籍/卷 |
| 3 | `202611240003_v6_orders_prices.sql` | 订单、订单行、付款流水、价格历史、出物、重复候选 |
| 4 | `202611240004_v6_achievements_images.sql` | 成就/徽章、多图相册、统一视图/函数 |
| 5 | `202611240005_v6_rls_storage_grants.sql` | RLS 策略、Storage 策略、表级 GRANT、Realtime publication |
| 6 | `202611240006_v6_seed_backfill.sql` | 默认状态/书籍类型、现有用户 seed、wishlist → collections、product_images → item_images、series 回填 |

> 也可以把 1–4 合并成一个文件；拆开是为了每期可单独验收、失败时可定位。P1 实际执行时优先按 1→6 顺序，不要跳。

## 2. 各文件的具体操作

### 2.1 `001_v6_core_tables.sql`

**新增表**

- `collection_types`
- `status_definitions`
- `main_category_prefs`
- `custom_main_categories`
- `series`
- `series_items`
- `locations`
- `field_definitions`
- `field_values`
- `status_history`（建议；用于报告/获得时间，只追加）

**修改现有表**

```sql
-- products
alter table public.products
  add column if not exists series_id uuid,
  add column if not exists market_price_date date,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_reason text,
  add column if not exists updated_by uuid;

-- collections
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

-- works / characters
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

-- main_categories
alter table public.main_categories
  add column if not exists is_builtin boolean not null default true,
  add column if not exists revision integer not null default 1,
  add column if not exists updated_at timestamptz not null default now();
```

> `status_id` 先加 nullable，回填 `'owned'` 后再 `set not null` / `set default 'owned'`，避免现有行违反约束。

**新增索引**

```sql
create index if not exists idx_products_owner_work_char
  on public.products(owner_id, work_id, character_id);
create index if not exists idx_products_owner_series
  on public.products(owner_id, series_id);
create index if not exists idx_products_owner_deleted
  on public.products(owner_id) where deleted_at is null;
create index if not exists idx_collections_owner_status
  on public.collections(owner_id, status_id);
create index if not exists idx_collections_owner_location
  on public.collections(owner_id, location_id);
create index if not exists idx_collections_owner_deleted
  on public.collections(owner_id) where deleted_at is null;
```

其他表索引见 `02-V6数据模型与ER.md`，在对应 `create table` 后创建。

### 2.2 `002_v6_books.sql`

**新增表**

- `book_types`
- `book_sets`
- `books`

**关键约束**

- `books.set_id` → `book_sets(owner_id,id) on delete set null`：删除套书不删单卷，单卷变为独立书。
- `books.status_id` → `status_definitions(owner_id,id) on delete restrict`。
- `books.location_id` → `locations(owner_id,id) on delete set null`。
- `book_sets.series_id` 可空；不强制套书属于系列。
- `books.isbn` 允许空；不设唯一约束（同 ISBN 可能多副本/多版本）。
- `books.volume_number` 可空；`volume_label` 支持特殊卷。
- `book_sets.total_volumes` 可空；空时用实际卷数计算。

**索引**

- `books(owner_id,set_id,volume_number)`
- `books(owner_id,isbn)`
- `books(owner_id,status_id)`
- `books(owner_id,location_id)`
- `books(owner_id) where deleted_at is null`
- `book_sets(owner_id,series_id)`
- `book_sets(owner_id,sort_order)`

### 2.3 `003_v6_orders_prices.sql`

**新增表**

- `orders`
- `order_items`
- `payment_records`
- `price_history`
- `sales`
- `duplicate_candidates`

**订单计算不存冗余总额**

- `orders` 只存商品总额、运费、优惠、计划定金；
- `payment_records` 存实际付款/退款；
- `balance_due` 由视图计算，不存列，避免多设备重复扣减。

**关键约束**

- `order_items.order_id` → `orders(owner_id,id) on delete cascade`。
- `payment_records.order_id` → `orders(owner_id,id) on delete cascade`。
- `payment_records.kind <> 'adjustment'` 时 `amount > 0`；`refund` 用正数，汇总时减。
- `price_history.recorded_on` 可空；旧数据不补日期。
- `duplicate_candidates` 只记录候选，不自动合并。

### 2.4 `004_v6_achievements_images.sql`

**新增表**

- `achievements`
- `user_achievements`
- `item_images`

**视图/函数**

- `v_effective_main_categories`
- `v_order_totals`
- `v_pending_balances`
- `v_collection_items`
- `v_owned_counts`
- `book_set_progress`
- `achievement_progress`
- `trash_list`

**`item_images` 与 `product_images` 关系**

- `product_images` 保留，不删。
- `item_images` 为 V6 统一相册。
- P1 回填：把每个 `product_images` 行插入 `item_images`（同 `storage_path`/`thumb_path`，`entity_type='product'`，`kind` 映射 `cover/highres → cover/photo`），唯一键防重复。
- 新上传只写 `item_images`；V6 不再写 `product_images`。
- 备份同时包含两张表；恢复时优先 `item_images`，`product_images` 仅作 v2 兼容。

### 2.5 `005_v6_rls_storage_grants.sql`

见第 3、4、5 节。

### 2.6 `006_v6_seed_backfill.sql`

**默认数据**

- 每个现有 `auth.users` 插入六种状态（`want/watch/preorder/balance/owned/cancelled`），`scope='all'`，`is_builtin=true`。
- 每个现有用户插入五种书籍类型（漫画/小说/画集/设定集/其他）。
- 新增 `seed_v6_defaults()`（`security definer`）并在 `auth.users` 插入后触发，保证以后新账号自动有六状态 + 五书籍类型；不要在应用层假设它们已经存在。
- `works/characters` 现有行：`is_builtin=true`，`owner_id=null`。
- `main_categories` 现有 20 行：`is_builtin=true`。

**数据迁移**

1. `collections.status_id` 回填 `'owned'`，再设 not null/default。
2. `wishlist` → `collections`：
   - 对每个 `(owner_id,product_id)` 不存在于 collections 的行，插入 `status_id='want'`, `quantity=1`；
   - 不删除 `wishlist` 行；
   - 写 `user_settings.wishlistMigratedAt`。
3. `products.series` → `series`：
   - 对每个用户、每个非空 `products.series` 去重，创建 `series(type='goods', name=...)`；
   - 更新 `products.series_id`；
   - 原 `products.series` 文本保留，不删。
4. `product_images` → `item_images`：
   - 按 `(owner_id,product_id,kind)` 插入；
   - `is_primary=true` 对 highres 优先，其次 cover；
   - 同路径唯一键防重复。
5. 可选：为现有 `collections` 生成 `price_history` 的 purchase 记录？**不做**，避免伪造日期；只保留当前值。
6. 可选：为现有商品生成 `series_items`？**不做**，只建 series 分组；系列清单由用户手动建立。

**回填后的校验**

```sql
select count(*) from public.collections where status_id is null; -- 0
select count(*) from public.books; -- 0（初始）
select count(*) from public.item_images where entity_type='product'; -- >= product_images 数
```

## 3. RLS 设计

### 3.1 总原则

- 单用户，但仍保留 `auth.uid()` RLS，防止未来误开放。
- 私人表：`select/insert/update/delete` 全部 `auth.uid() = owner_id`。
- 公开参考表：`collection_types`、`main_categories`、`works`、`characters` 的 select 对 `anon, authenticated` 开放。
- 配置表（状态/字段/分类/徽章/地点）按 owner 隔离，跨设备同账号可见。
- `main_categories` 只允许 `authenticated` update；不允许 insert/delete（自定义分类另表）。
- `works/characters` 允许 authenticated insert/update；delete 只允许自定义行（`owner_id=auth.uid() and is_builtin=false`）；内置行不删。
- 软删除不改变 RLS：删除=update `deleted_at`，仍按 owner。
- 视图使用 `security_invoker = true`，确保底层 RLS 生效。

### 3.2 RLS 矩阵

| 表 | select | insert | update | delete |
|---|---|---|---|---|
| `collection_types` | anon+auth | 无 | 无 | 无 |
| `main_categories` | anon+auth | 无 | auth（改名/排序） | 无 |
| `works` | anon+auth | auth（owner=uid） | auth（owner=uid or builtin） | auth（owner=uid and not builtin） |
| `characters` | anon+auth | auth（owner=uid） | auth（owner=uid or builtin） | auth（owner=uid and not builtin） |
| `main_category_prefs` | own | own | own | own |
| `custom_main_categories` | own | own | own | own（软删） |
| `status_definitions` | own | own | own | own（软删） |
| `book_types` | own | own | own | own（软删） |
| `series` / `series_items` | own | own | own | own（软删） |
| `book_sets` / `books` | own | own | own | own（软删） |
| `field_definitions` / `field_values` | own | own | own | own（软删/清值） |
| `status_history` | own | own（追加） | 无 | 无 |
| `locations` | own | own | own | own（软删） |
| `item_images` | own | own | own | own（软删） |
| `price_history` | own | own | own | own |
| `orders` / `order_items` / `payment_records` | own | own | own | own（软删订单；明细随订单） |
| `achievements` / `user_achievements` | own | own | own | own（软删/撤销） |
| `sales` | own | own | own | own（软删） |
| `duplicate_candidates` | own | own | own | own |
| `products/collections/wishlist/board_*/product_images/user_settings/backup_logs` | 保持 V5 own | 保持 | 保持 | 保持（V6 改为软删） |

### 3.3 策略示例

```sql
-- 私人表通用
alter table public.books enable row level security;
create policy "books_select_own" on public.books
for select to authenticated using ((select auth.uid()) = owner_id);
create policy "books_insert_own" on public.books
for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "books_update_own" on public.books
for update to authenticated using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);
create policy "books_delete_own" on public.books
for delete to authenticated using ((select auth.uid()) = owner_id);
```

> 软删除使用 update，所以 delete 策略可以保留但应用不调用；永久删除只从回收站走。

```sql
-- 20 主分类：只允许改 label/sort_order，不允许增删
create policy "main_categories_update_auth" on public.main_categories
for update to authenticated using (true) with check (true);
```

> 单用户场景下允许 authenticated 更新 20 行；不授予 insert/delete。多用户时应改为 `main_category_prefs` 覆盖，本设计已经预留该表。

### 3.4 重要约束触发器

- `validate_order_payment`: `payment_records.order_id` 必须属于同一 owner；金额规则。
- `validate_item_image_entity`: `entity_type` + `entity_id` 必须存在且属于同一 owner（多态完整性）。
- `validate_field_value_entity`: 同上。
- `validate_series_item`: product/book 至少一个，且属于同一 owner。
- `validate_status_delete`: 删除/软删状态前，若 `collections/books` 仍在用，阻止或要求重分配。
- `validate_custom_category_delete`: 软删自定义分类前，若 `products.main_category_key` 仍在用，阻止；应用先重归类。
- `protect_main_category_key`: 禁止 update 修改 `main_categories.key`（只允许 label/sort_order）；同理保护 `products.id`、`books.id` 不可变。
- `bump_revision` 扩展到新表（products/collections 已有；works、characters、main_categories、books、book_sets、orders、payment_records、item_images、status_definitions、field_definitions、achievements 等）。

## 4. Storage 设计

### 4.1 复用现有私有桶

继续使用 `product-images`（private，12MB，jpeg/png/webp/avif），不新建桶；所有新图片路径第一段仍是 `<auth.uid()>`，现有 Storage RLS 直接复用。

### 4.2 路径规范

| 用途 | 路径 |
|---|---|
| 谷子主图/相册 | `<uid>/products/<product_id>/<image_id>-<kind>.<ext>` |
| 书籍封面/相册 | `<uid>/books/<book_id>/<image_id>-<kind>.<ext>` |
| 套书封面 | `<uid>/book-sets/<set_id>/<image_id>-cover.<ext>` |
| 徽章图片 | `<uid>/badges/<achievement_id>.<ext>` |
| 状态图标 | `<uid>/status-icons/<status_id>.<ext>` |
| 自定义字段图片 | `<uid>/field-images/<field_id>/<value_id>-<n>.<ext>` |
| 系列清单图 | `<uid>/series/<series_id>/<item_id>.<ext>` |

> 现有 `product-images` 路径是 `<uid>/<product_id>/...`，V6 新路径加了 `products/` 段。两者都能被现有策略识别（第一段 uid）；旧文件不移动，避免破坏 V5。

### 4.3 Storage 策略

现有策略已覆盖：

```sql
bucket_id = 'product-images'
and (storage.foldername(name))[1] = auth.uid()::text
```

V6 不需要新桶；只需确认策略仍存在。若未来拆桶，再新增 `collection-images` 和对应策略。

### 4.4 图片删除与恢复

- 软删除 `item_images.deleted_at`，不立即删 Storage。
- 回收站永久删除时，才调用 `storage.remove`。
- 恢复软删除图片时，Storage 文件仍在，直接恢复元数据。
- 备份下载所有 `item_images`（含软删除可选），manifest 记录 `entity_type/entity_id/kind`。

## 5. 表级 GRANT 与 Realtime

### 5.1 GRANT

V5 的 `004_grants.sql` 已给 `authenticated` 默认权限；新增表仍需显式授权，避免再次出现 `permission denied`：

```sql
grant select, insert, update, delete on
  public.collection_types, public.status_definitions,
  public.main_category_prefs, public.custom_main_categories,
  public.series, public.series_items,
  public.book_types, public.book_sets, public.books,
  public.field_definitions, public.field_values,
  public.status_history,
  public.locations, public.item_images, public.price_history,
  public.orders, public.order_items, public.payment_records,
  public.achievements, public.user_achievements,
  public.sales, public.duplicate_candidates
to authenticated;
```

`anon` 只读公开表：

```sql
grant select on public.collection_types to anon;
-- main_categories/works/characters 已有 anon select
```

`works/characters/main_categories` 需要写权限：

```sql
grant insert, update on public.works, public.characters to authenticated;
grant update on public.main_categories to authenticated;
```

### 5.2 Realtime

建议加入 publication 的高频表：

`products, collections, books, book_sets, series, series_items, orders, payment_records, item_images, status_definitions, custom_main_categories, achievements, user_achievements, locations, price_history`

配置类低频表（`field_definitions/field_values`、`main_category_prefs`、`book_types`）可以只在窗口聚焦/手动同步时刷新，避免 Realtime 表过多。

订阅仍按 `owner_id=eq.<uid>` 过滤；前端 debounce 刷新。

## 6. 回滚与安全

- 每个 Migration 文件只加表/列/策略，不删旧表；回滚时可直接 `drop table` 新增表（确认无数据依赖），不改 V5 表。
- 新列可保留（nullable/default），回滚 V5 代码不影响。
- 执行前必须：
  1. 代码 tag `pre-v6-p1`；
  2. Supabase 完整备份（应用 ZIP + 平台备份）；
  3. 在独立分支/独立 Supabase 项目先演练；
  4. 先跑 `select` 校验，再跑 Migration；
  5. 每份 Migration 后用 `has_table_privilege` / `count(*)` 验证。
- **不要在 V6 未验收前删除 `wishlist`、`product_images` 或任何 V5 表。**

## 7. 执行顺序（P1 实际执行时）

```text
备份
→ 001 core tables
→ 002 books
→ 003 orders/prices
→ 004 achievements/images/views
→ 005 RLS/storage/grants
→ 006 seed/backfill
→ 校验 SQL
→ 前端接入
```

P0 不执行以上任何一步。
