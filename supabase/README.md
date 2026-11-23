# Supabase 初始化

## 文件

| 文件 | 内容 |
|---|---|
| `migrations/202611230001_schema.sql` | 表、约束、索引、updated_at/revision 触发器、新用户触发器 |
| `migrations/202611230002_rls.sql` | RLS、Storage 私有桶与策略、Realtime publication |
| `migrations/202611230003_seed.sql` | 20 主分类、作品、角色 |
| `migrations/202611230004_grants.sql` | public 表级 GRANT（必须执行；只建 RLS 不授权会 `permission denied for table`） |

## Dashboard SQL Editor

按顺序复制执行四份 SQL。执行完检查：

```sql
select count(*) from public.main_categories; -- 20
select id,name from public.works;            -- gyly
select id,name from public.characters;       -- xmx
select id,public,file_size_limit from storage.buckets where id='product-images';
```

## Supabase CLI

```bash
npm install -g supabase
supabase login
supabase link --project-ref <project-ref>
supabase db push
```

## 认证

Authentication → Providers → Email 开启。
URL Configuration 增加：

- `https://xmx-goods.vercel.app/**`
- `http://127.0.0.1:8765/**`

## Storage

`product-images` 由 SQL 自动创建：

- private
- 12MB
- jpeg/png/webp/avif

路径规则：`<auth.uid()>/<product_id>/<kind>-<timestamp>.<ext>`。

## 安全

- 前端只用 anon public key。
- 不把 service_role 放进 `config.js` / Vercel 前端变量 / 浏览器。
- 所有私人表 RLS 按 `owner_id` 隔离。
- `main_categories/works/characters` 公开只读。

## 验证

```sql
-- 以登录用户运行
select count(*) from public.products where owner_id = auth.uid();
select count(*) from public.board_categories where owner_id = auth.uid();
```

如果返回 0 且已登录，检查迁移是否执行、RLS 是否启用、Auth 用户是否创建了 profile。
