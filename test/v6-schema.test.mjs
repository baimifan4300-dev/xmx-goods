import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".");
const db = new PGlite();

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  console.log(`  ✓ ${message}`);
}

async function run(file) {
  const sql = fs.readFileSync(path.join(root, "supabase/migrations", file), "utf8");
  await db.exec(sql);
}

console.log("准备最小 Supabase 环境（auth / storage / roles）");
await db.exec(`
  create schema if not exists auth;
  create schema if not exists storage;

  create table auth.users (
    id uuid primary key,
    email text
  );

  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );

  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null,
    name text not null
  );
  alter table storage.objects enable row level security;

  create or replace function auth.uid()
  returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

  create or replace function storage.foldername(name text)
  returns text[] language sql immutable as $$
    select string_to_array(name, '/')
  $$;

  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  end $$;

  create publication supabase_realtime;
`);

console.log("执行 V5 + V6 迁移");
for (const file of [
  "202611230001_schema.sql",
  "202611230002_rls.sql",
  "202611230003_seed.sql",
  "202611230004_grants.sql",
  "202611240001_v6_core_tables.sql",
  "202611240002_v6_books.sql",
  "202611240003_v6_orders_prices.sql",
  "202611240004_v6_achievements_images.sql",
  "202611240005_v6_rls_storage_grants.sql",
  "202611240006_v6_seed_backfill.sql"
]) {
  await run(file);
  console.log(`  ✓ ${file}`);
}

console.log("1. 新表/类型");
const tables = await db.query(`select tablename from pg_tables where schemaname='public' order by tablename`);
const names = new Set(tables.rows.map((r) => r.tablename));
for (const t of ["collection_types", "status_definitions", "main_category_prefs", "custom_main_categories", "series", "series_items", "locations", "field_definitions", "field_values", "book_types", "book_sets", "books", "orders", "order_items", "payment_records", "price_history", "sales", "duplicate_candidates", "achievements", "user_achievements", "item_images", "status_history"]) {
  assert(names.has(t), `表 ${t} 存在`);
}
const types = await db.query(`select key,label from public.collection_types order by sort_order`);
assert(types.rows.length === 2 && types.rows[0].key === "goods" && types.rows[1].key === "books", "collection_types 为 goods/books");

console.log("2. 新用户 seed 状态/书籍类型");
const u1 = "11111111-1111-4111-8111-111111111111";
const u2 = "22222222-2222-4222-8222-222222222222";
await db.query(`insert into auth.users(id,email) values ($1,$2),($3,$4)`, [u1, "a@example.com", u2, "b@example.com"]);
for (const uid of [u1, u2]) {
  const st = await db.query(`select count(*)::int as c from public.status_definitions where owner_id=$1`, [uid]);
  assert(st.rows[0].c === 6, `用户 ${uid.slice(0, 4)} 有 6 个默认状态`);
  const bt = await db.query(`select count(*)::int as c from public.book_types where owner_id=$1`, [uid]);
  assert(bt.rows[0].c === 5, `用户 ${uid.slice(0, 4)} 有 5 个书籍类型`);
}
const profiles = await db.query(`select count(*)::int as c from public.profiles`);
assert(profiles.rows[0].c === 2, "新用户自动生成 profile");
const settings = await db.query(`select count(*)::int as c from public.user_settings`);
assert(settings.rows[0].c === 2, "新用户自动生成 settings");

console.log("3. 商品/收藏/状态");
await db.query(`
  insert into public.products
    (owner_id,id,name,work_id,character_id,series,main_category_key,market_price,market_price_date,payload)
  values
    ($1,'B01-001','测试商品1','gyly','xmx','测试系列','badge',88.50,'2026-11-23','{"id":"B01-001"}'::jsonb),
    ($1,'B01-002','测试商品2','gyly','xmx',null,null,null,null,'{"id":"B01-002"}'::jsonb),
    ($2,'B01-001','另一个用户商品','gyly','xmx',null,null,10,null,'{"id":"B01-001"}'::jsonb)
`, [u1, u2]);
await db.query(`
  insert into public.collections
    (owner_id,product_id,quantity,purchase_price,purchase_date,status_id)
  values
    ($1,'B01-001',2,65.00,'2026-02-03','owned'),
    ($1,'B01-002',1,null,null,'want')
`, [u1]);
const market = await db.query(`select market_price,market_price_date::text as market_price_date from public.products where owner_id=$1 and id='B01-001'`, [u1]);
assert(Number(market.rows[0].market_price) === 88.5 && market.rows[0].market_price_date === "2026-11-23", "市场价和记录日期独立保存");
const coll = await db.query(`select quantity,purchase_price,status_id from public.collections where owner_id=$1 and product_id='B01-001'`, [u1]);
assert(coll.rows[0].quantity === 2 && Number(coll.rows[0].purchase_price) === 65 && coll.rows[0].status_id === "owned", "收藏数量/购买价/状态正确");

console.log("4. wishlist → collections / product_images → item_images / series 回填");
await db.query(`insert into public.wishlist(owner_id,product_id) values ($1,'B01-002')`, [u1]);
await db.query(`insert into public.product_images
  (owner_id,product_id,kind,storage_path,file_name,mime_type,size_bytes,width,height)
  values ($1,'B01-001','highres',$2,'a.webp','image/webp',100,10,10)`, [u1, `${u1}/B01-001/highres.webp`]);
await run("202611240006_v6_seed_backfill.sql");
const want = await db.query(`select status_id from public.collections where owner_id=$1 and product_id='B01-002'`, [u1]);
assert(want.rows.length === 1 && want.rows[0].status_id === "want", "wishlist 迁移为 want 状态");
const mirrored = await db.query(`select count(*)::int as c from public.item_images where owner_id=$1 and entity_type='product'`, [u1]);
assert(mirrored.rows[0].c === 1, "product_images 镜像为 item_images");
const series = await db.query(`select s.name, p.series_id is not null as linked from public.series s join public.products p on p.owner_id=s.owner_id and p.series_id=s.id where p.owner_id=$1 and p.id='B01-001'`, [u1]);
assert(series.rows.length === 1 && series.rows[0].name === "测试系列" && series.rows[0].linked === true, "products.series 回填 series/series_id");

console.log("5. 书籍套/卷/版本");
const set1 = "33333333-3333-4333-8333-333333333333";
const b1 = "44444444-4444-4444-8444-444444444444";
const b2 = "55555555-5555-4555-8555-555555555555";
const b3 = "66666666-6666-4666-8666-666666666666";
await db.query(`insert into public.book_sets
  (owner_id,id,title,book_type_id,language,publisher,edition,binding,total_volumes)
  values ($1,$2,'测试漫画','manga','简体','测试出版社','初版','平装',12)`, [u1, set1]);
await db.query(`insert into public.books
  (owner_id,id,set_id,book_type_id,title,language,publisher,edition,binding,volume_number,volume_label,isbn,status_id,quantity)
  values
    ($1,$2,$3,'manga','测试漫画 第1卷','简体','测试出版社','初版','平装',1,'1','978000000001','owned',1),
    ($1,$4,$3,'manga','测试漫画 第2卷','简体','测试出版社','初版','平装',2,'2','978000000002','preorder',1),
    ($1,$5,null,'manga','测试漫画 繁体第1卷','繁体','另一出版社','再版','精装',1,'1','978000000003','want',1)
`, [u1, b1, set1, b2, b3]);
const progress = await db.query(`select * from public.book_set_progress($1,$2)`, [u1, set1]);
assert(Number(progress.rows[0].total_volumes) === 12 && Number(progress.rows[0].owned_volumes) === 1, "套书进度 12 卷、已拥有 1 卷");
assert(Array.isArray(progress.rows[0].missing_volumes) && progress.rows[0].missing_volumes.includes("2"), "缺少卷数包含第 2 卷");
const editions = await db.query(`select count(*)::int as c from public.books where owner_id=$1 and language in ('简体','繁体')`, [u1]);
assert(editions.rows[0].c === 3, "不同语言/出版社/版次/装帧独立保存");

console.log("6. 订单/定金/尾款/退款");
const order1 = "77777777-7777-4777-8777-777777777777";
await db.query(`insert into public.orders
  (owner_id,id,total_amount,shipping_fee,discount_amount,status,balance_due_date)
  values ($1,$2,200,10,5,'open','2026-12-31')`, [u1, order1]);
await db.query(`insert into public.order_items
  (owner_id,order_id,entity_type,entity_id,quantity,unit_price)
  values ($1,$2,'product','B01-001',1,200)`, [u1, order1]);
await db.query(`insert into public.payment_records
  (owner_id,order_id,kind,amount,paid_at)
  values
    ($1,$2,'deposit',50,'2026-11-01'),
    ($1,$2,'balance',150,'2026-11-20'),
    ($1,$2,'refund',20,'2026-11-21')`, [u1, order1]);
const totals = await db.query(`select payable,paid,refunded,balance_due from public.v_order_totals where owner_id=$1 and order_id=$2`, [u1, order1]);
assert(Number(totals.rows[0].payable) === 205, "应付 = 200 + 10 - 5");
assert(Number(totals.rows[0].paid) === 180, "已付 = 50 + 150 - 20");
assert(Number(totals.rows[0].balance_due) === 25, "待补 = 25");

console.log("7. 视图/统计");
const pending = await db.query(`select count(*)::int as c from public.v_pending_balances where owner_id=$1`, [u1]);
assert(pending.rows[0].c === 1, "待补尾款视图包含 1 单");
const owned = await db.query(`select collection_type,owned_kinds,owned_pieces from public.v_owned_counts where owner_id=$1 order by collection_type`, [u1]);
assert(owned.rows.length === 2, "谷子/书籍分别统计");
const items = await db.query(`select count(*)::int as c from public.v_collection_items where owner_id=$1`, [u1]);
assert(items.rows[0].c === 5, "统一视图 2 件谷子 + 3 本书");
const cats = await db.query(`select count(*)::int as c from public.v_effective_main_categories`);
assert(cats.rows[0].c === 20, "统一主分类视图 20 个内置分类");

console.log("8. RLS 用户隔离");
await db.exec(`grant usage on schema public to anon, authenticated;
  grant select on all tables in schema public to authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;`);
await db.exec(`set role authenticated`);
await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [u1]);
const own = await db.query(`select count(*)::int as c from public.products`);
assert(own.rows[0].c === 2, "用户 1 只看到自己的 2 件商品");
const other = await db.query(`select count(*)::int as c from public.products where owner_id=$1`, [u2]);
assert(other.rows[0].c === 0, "用户 1 看不到用户 2 的商品");
const otherBooks = await db.query(`select count(*)::int as c from public.books where owner_id=$1`, [u2]);
assert(otherBooks.rows[0].c === 0, "用户 1 看不到用户 2 的书籍");
await db.exec(`reset role`);

console.log("9. 软删除");
await db.query(`update public.products set deleted_at=now() where owner_id=$1 and id='B01-001'`, [u1]);
const active = await db.query(`select count(*)::int as c from public.products where owner_id=$1 and deleted_at is null`, [u1]);
assert(active.rows[0].c === 1, "软删除后活跃商品只剩 1 件");
await db.query(`update public.products set deleted_at=null where owner_id=$1 and id='B01-001'`, [u1]);

console.log("10. status_history");
await db.query(`insert into public.status_history(owner_id,entity_type,entity_id,from_status_id,to_status_id)
  values ($1,'product','B01-002','want','owned')`, [u1]);
const hist = await db.query(`select count(*)::int as c from public.status_history where owner_id=$1`, [u1]);
assert(hist.rows[0].c === 1, "状态历史只追加");

console.log("11. 迁移幂等（V6 001–006 再跑一遍）");
for (const file of [
  "202611240001_v6_core_tables.sql",
  "202611240002_v6_books.sql",
  "202611240003_v6_orders_prices.sql",
  "202611240004_v6_achievements_images.sql",
  "202611240005_v6_rls_storage_grants.sql",
  "202611240006_v6_seed_backfill.sql"
]) {
  await run(file);
}
const counts = await db.query(`
  select
    (select count(*)::int from public.products where owner_id=$1) as products,
    (select count(*)::int from public.collections where owner_id=$1) as collections,
    (select count(*)::int from public.item_images where owner_id=$1) as images,
    (select count(*)::int from public.status_definitions where owner_id=$1) as statuses,
    (select count(*)::int from public.book_types where owner_id=$1) as book_types,
    (select count(*)::int from public.books where owner_id=$1) as books
`, [u1]);
assert(counts.rows[0].products === 2, "幂等重跑不重复商品");
assert(counts.rows[0].collections === 2, "幂等重跑不重复收藏");
assert(counts.rows[0].images === 1, "幂等重跑不重复图片");
assert(counts.rows[0].statuses === 6, "幂等重跑不重复状态");
assert(counts.rows[0].book_types === 5, "幂等重跑不重复书籍类型");
assert(counts.rows[0].books === 3, "幂等重跑不重复书籍");

console.log("V6 P1 schema/RLS/触发器/迁移测试全部通过");
