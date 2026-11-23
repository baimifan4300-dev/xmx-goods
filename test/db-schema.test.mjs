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

console.log("执行迁移");
await run("202611230001_schema.sql");
await run("202611230002_rls.sql");
await run("202611230003_seed.sql");
await run("202611230004_grants.sql");

console.log("1. 表与固定分类");
const tables = await db.query(`
  select tablename from pg_tables where schemaname='public' order by tablename
`);
const tableNames = tables.rows.map((r) => r.tablename);
for (const name of ["products", "collections", "wishlist", "board_categories", "board_assignments", "product_images", "user_settings", "profiles"]) {
  assert(tableNames.includes(name), `表 ${name} 存在`);
}
const main = await db.query(`select key, label, sort_order from public.main_categories order by sort_order`);
assert(main.rows.length === 20, "20 个主分类");
assert(main.rows[0].key === "badge" && main.rows[19].key === "small_card", "主分类顺序正确");
const works = await db.query(`select id,title from public.works`);
assert(works.rows.length === 1 && works.rows[0].id === "gyly", "作品种子存在");
const chars = await db.query(`select id,name from public.characters where work_id='gyly'`);
assert(chars.rows.length === 1 && chars.rows[0].id === "xmx", "角色种子存在");

const priv = await db.query(`
  select has_table_privilege('authenticated','public.products','select') as products_select,
         has_table_privilege('authenticated','public.user_settings','update') as settings_update,
         has_table_privilege('anon','public.main_categories','select') as anon_categories
`);
assert(priv.rows[0].products_select === true, "authenticated 可读 products");
assert(priv.rows[0].settings_update === true, "authenticated 可写 user_settings");
assert(priv.rows[0].anon_categories === true, "anon 可读主分类");

console.log("2. 新用户触发器");
const u1 = "11111111-1111-4111-8111-111111111111";
const u2 = "22222222-2222-4222-8222-222222222222";
await db.query(`insert into auth.users(id,email) values ($1,$2),($3,$4)`, [u1, "a@example.com", u2, "b@example.com"]);
const profiles = await db.query(`select count(*)::int as c from public.profiles`);
assert(profiles.rows[0].c === 2, "新用户自动生成 profile");
const settings = await db.query(`select count(*)::int as c from public.user_settings`);
assert(settings.rows[0].c === 2, "新用户自动生成 settings");

console.log("3. 商品 / 收藏 / 分类数据");
await db.query(`
  insert into public.products (owner_id,id,name,work_id,character_id,payload,main_category_key,board_key,market_price)
  values
    ($1,'B01-001','测试商品1','gyly','xmx','{"id":"B01-001"}'::jsonb,'badge',null,88.50),
    ($1,'B01-002','测试商品2','gyly','xmx','{"id":"B01-002"}'::jsonb,null,'collab',null),
    ($2,'B01-001','另一个用户商品','gyly','xmx','{"id":"B01-001"}'::jsonb,'plush',null,10)
`, [u1, u2]);
await db.query(`
  insert into public.collections (owner_id,product_id,quantity,purchase_price,purchase_date,note)
  values ($1,'B01-001',2,65.00,'2026-02-03','测试')
`, [u1]);
await db.query(`insert into public.wishlist (owner_id,product_id) values ($1,'B01-002')`, [u1]);
await db.query(`
  insert into public.board_categories (owner_id,id,board_key,name,sort_order)
  values ($1,'c_test','collab','测试联动',1)
`, [u1]);
await db.query(`
  insert into public.board_assignments (owner_id,product_id,board_key,category_id)
  values ($1,'B01-002','collab','c_test')
`, [u1]);

const pcount = await db.query(`select count(*)::int as c from public.products where owner_id=$1`, [u1]);
assert(pcount.rows[0].c === 2, "商品按 owner 写入");
const coll = await db.query(`select quantity,purchase_price from public.collections where owner_id=$1`, [u1]);
assert(coll.rows[0].quantity === 2 && Number(coll.rows[0].purchase_price) === 65, "收藏数量与实际购买价独立保存");
const market = await db.query(`select market_price from public.products where owner_id=$1 and id='B01-001'`, [u1]);
assert(Number(market.rows[0].market_price) === 88.5, "市场价格字段独立");

console.log("4. RLS 用户隔离");
await db.exec(`grant usage on schema public to anon, authenticated;
  grant select on public.works, public.characters, public.main_categories to anon, authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;`);
await db.exec(`set role authenticated`);
await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [u1]);
const own = await db.query(`select count(*)::int as c from public.products`);
assert(own.rows[0].c === 2, "用户 1 只能看到自己的 2 件商品");
const other = await db.query(`select count(*)::int as c from public.products where owner_id=$1`, [u2]);
assert(other.rows[0].c === 0, "用户 1 看不到用户 2 的商品");

console.log("5. revision 冲突检测基础");
const before = await db.query(`select revision from public.products where id='B01-001'`);
assert(Number(before.rows[0].revision) === 1, "初始 revision=1");
const updated = await db.query(`
  update public.products set name='测试商品1改名'
  where owner_id=$1 and id='B01-001' and revision=1
  returning revision,name
`, [u1]);
assert(updated.rows.length === 1 && Number(updated.rows[0].revision) === 2, "更新后 revision 自增到 2");
const stale = await db.query(`
  update public.products set name='过期覆盖'
  where owner_id=$1 and id='B01-001' and revision=1
  returning revision,name
`, [u1]);
assert(stale.rows.length === 0, "旧 revision 更新匹配 0 行，可用于冲突提示");

console.log("6. 删除分类不删除商品，删除商品级联");
await db.query(`delete from public.board_categories where owner_id=$1 and id='c_test'`, [u1]);
const afterCatDelete = await db.query(`select count(*)::int as c from public.products where owner_id=$1`, [u1]);
assert(afterCatDelete.rows[0].c === 2, "删除分类后商品仍在");
const assignAfter = await db.query(`select count(*)::int as c from public.board_assignments where owner_id=$1`, [u1]);
assert(assignAfter.rows[0].c === 0, "删除分类后关联自动清理");
await db.query(`delete from public.products where owner_id=$1 and id='B01-001'`, [u1]);
const afterProductDelete = await db.query(`select count(*)::int as c from public.products where owner_id=$1`, [u1]);
assert(afterProductDelete.rows[0].c === 1, "删除商品后另一件仍在");
const collAfter = await db.query(`select count(*)::int as c from public.collections where owner_id=$1`, [u1]);
assert(collAfter.rows[0].c === 0, "删除商品级联清理收藏");

console.log("7. Storage 私有桶与路径策略");
await db.exec(`reset role`);
await db.exec(`grant usage on schema storage to authenticated;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant select on storage.buckets to authenticated;`);
await db.exec(`set role authenticated`);
const buckets = await db.query(`select id,public,file_size_limit,allowed_mime_types from storage.buckets where id='product-images'`);
assert(buckets.rows.length === 1 && buckets.rows[0].public === false, "product-images 为私有桶");
assert(Number(buckets.rows[0].file_size_limit) === 12582912, "桶限制 12MB");
await db.query(`insert into storage.objects (bucket_id,name) values ('product-images',$1)`, [`${u1}/B01-002/cover-1.webp`]);
const objOwn = await db.query(`select count(*)::int as c from storage.objects where bucket_id='product-images'`);
assert(objOwn.rows[0].c === 1, "用户 1 可读取自己目录的图片");
const objOther = await db.query(`select count(*)::int as c from storage.objects where bucket_id='product-images' and name like $1`, [`${u2}/%`]);
assert(objOther.rows[0].c === 0, "用户 1 看不到用户 2 目录的图片");

await db.exec(`reset role`);
console.log("数据库 schema/RLS/触发器测试全部通过");
await db.close();
