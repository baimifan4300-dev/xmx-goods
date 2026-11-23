# 星愿收藏室 · 夏鸣星谷子图鉴（v5 云端版）

以 **V4 完整源码与 1537 条商品数据为唯一开发基准** 升级。保留原有页面、20 个主分类、联动/满赠分类管理、合集图红框定位和收藏功能，在此基础上接入 Supabase 云端数据库、账号、跨设备同步、站内商品管理、收藏数量/购买价/市场价、私有图片存储和完整备份恢复。

> 在线地址（GitHub Pages）：https://baimifan4300-dev.github.io/xmx-goods/
> `config.js` 只包含 Supabase Publishable/anon key，本来就要发给浏览器，可以公开；**service_role / secret key 绝不能进入前端或仓库**。
> 不配置 Supabase 时，可用 `?demo=1` 进入本地预览；该模式明确标记为“本地预览”，不会伪装成云端同步。

## 1. 这次升级做了什么

| 能力 | 实现 |
|---|---|
| 云端数据库 | Supabase PostgreSQL，所有私人数据按 `owner_id` + RLS 隔离 |
| 登录 | Supabase Auth 邮箱 + 密码，支持注册、登录、找回密码、邮箱确认 |
| 多设备同步 | 登录后从云端加载；实时订阅 + 窗口聚焦/重新可见时刷新 |
| 商品管理 | 站内新增、编辑、删除商品；保留原始 ID 与全部原字段 |
| 收藏 | 数量 >1、实际购买价、购买日期、个人备注；与市场价完全独立 |
| 市场价格 | 每件商品独立维护，可留空，不影响购买价与数量 |
| 联动/满赠分类 | V4 分类与归属自动迁移到云端，可继续新增/重命名/删除/归类 |
| 图片 | Supabase Storage 私有桶；高清图上传/替换/删除/恢复合集图；自动缩略图 |
| 冲突处理 | 所有可编辑记录有 `revision`；更新时校验旧版本，冲突弹窗让用户选择保留版本 |
| 完整备份 | ZIP：`data.json` + `manifest.json` + 全部用户高清图 + 原始合集图/缩略图 |
| 恢复 | 校验格式/版本/图片 SHA-256/重复 ID；二次确认；合并或覆盖；结果报告 |
| 安全 | RLS、私有 Storage 策略、前端只有 anon public key，无 service_role |

## 2. 技术架构

```text
浏览器（GitHub / Vercel 静态站点）
  index.html + style.css + app.js（esbuild 打包的 IIFE）
        │
        ├── Supabase Auth            邮箱/密码、会话持久化
        ├── Supabase JS SDK          PostgREST + Storage + Realtime
        │      ├── PostgreSQL        商品/收藏/愿望/分类/图片元数据
        │      └── Storage           私有桶 product-images
        │
        └── 本地预览适配器            仅 ?demo=1，使用 IndexedDB/localStorage
```

- 前端仍然是纯静态 HTML/CSS/JS，不需要服务器运行时；可直接部署到 Vercel。
- 云端是登录后的唯一权威数据源；前端不做“只写 localStorage”的云端替代。
- 实时同步是增强项；即使 Realtime 未开启，刷新/重新进入/窗口聚焦也会拉取最新数据。
- 冲突处理采用 `revision` 乐观锁，不静默覆盖。

## 3. 文件结构

```text
.
├── index.html                    页面结构（原有 5 个页面 + 登录 + 账户/数据）
├── style.css                     V4 视觉 + 详情基础样式 + v5 弹窗/表单/备份样式
├── app.js                        构建产物（esbuild bundle；不要直接手改）
├── config.js                     运行时 Supabase 配置（可被构建环境变量覆盖）
├── config.example.js             配置模板
├── data/
│   ├── categories.json           20 主分类 + 联动/满赠 + 待核对顺序
│   ├── works.json                作品/角色
│   └── gyly/xmx/products.json    1537 条原始商品（未被修改）
├── assets/works/gyly/xmx/
│   ├── images/                   57 张合集原图
│   └── thumbs/                   1296 张裁切缩略图
├── src/                          前端源码（构建 app.js）
│   ├── main.js                   页面与交互
│   ├── cloud-supabase.js         Supabase 数据层
│   ├── cloud-local.js            本地预览适配器
│   ├── model.js                  商品/收藏/分类映射
│   ├── migrate.js                V4 本机数据迁移
│   ├── backup.js                 完整备份/恢复
│   ├── images.js                 图片校验、压缩、缩略图
│   ├── constants.js / utils.js
├── supabase/migrations/          PostgreSQL schema / RLS / seed
├── scripts/                      构建、开发服务器、数据校验、配置检查
├── test/                         单元、数据库、E2E、完整备份测试
├── docs/                         部署、数据库、备份、验收文档
└── vercel.json                   Vercel 构建、CSP 与缓存头
```

`data/gyly/xmx/products.json` 保持 V4 原样，字段和 1537 条数据未改动；云端数据由登录后的迁移流程写入。

## 4. 本地预览（无需 Supabase）

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:8765/?demo=1`。

或双击 `start.bat`（会打开本地预览）。本地预览：

- 首次从 `data/gyly/xmx/products.json` 初始化 1537 条商品；
- 读取 V4 的 `xmx.collection.v1` 与 `xmx.boards.v1.gyly.xmx`；
- 收藏、分类、站内新增商品保存在当前浏览器；
- **不会跨设备同步**，页面顶部有明确提示。

本地预览不写入 `data/gyly/xmx/products.json`，也不会影响云端。

## 5. 云端部署（摘要）

1. 创建 Supabase 项目。
2. 在 SQL Editor 依次执行：
   - `supabase/migrations/202611230001_schema.sql`
   - `supabase/migrations/202611230002_rls.sql`
   - `supabase/migrations/202611230003_seed.sql`
   - `supabase/migrations/202611230004_grants.sql`（表级授权，必须执行；否则登录后所有查询都会报 `permission denied`）
3. Authentication → Providers → Email 开启；个人使用可关闭“Confirm email”，或配置 SMTP。
4. 确认 Storage 中存在私有桶 `product-images`（SQL 会自动创建）。
5. 配置 `SUPABASE_URL` / `SUPABASE_ANON_KEY`：
   - 本地：填 `config.js`，或 `cp .env.example .env` 后由构建脚本生成；
   - Vercel：Project Settings → Environment Variables 添加同名变量，重新部署。
6. 打开网站 → 注册/登录。首次登录自动导入 1537 条商品，并迁移当前浏览器里的 V4 收藏/愿望/联动满赠分类。
7. 迁移前会自动下载 `xmx-v4-premigration-*.json` 数据快照；V4 本机键不会删除。

完整步骤与排错见 [docs/云端部署与迁移.md](docs/云端部署与迁移.md)。

## 6. 数据模型

| 表 | 用途 | 关键字段 |
|---|---|---|
| `products` | 用户商品（每人一份完整图鉴） | `owner_id,id,payload,market_price,board_key,revision` |
| `collections` | 收藏 | `quantity,purchase_price,purchase_date,note,revision` |
| `wishlist` | 愿望清单 | `owner_id,product_id` |
| `board_categories` | 联动/满赠自定义分类 | `id,name,board_key,sort_order,revision` |
| `board_assignments` | 商品 → 子分类 | `product_id,board_key,category_id` |
| `product_images` | 用户上传图片元数据 | `storage_path,thumb_path,width,height` |
| `user_settings` | 迁移标记、默认分类初始化等 | `settings jsonb` |
| `main_categories` | 固定 20 主分类（公开只读） | `key,label,sort_order` |
| `works` / `characters` | 作品/角色（公开只读） | `id,name,theme` |
| `profiles` | 用户资料 | `id,email` |
| `backup_logs` | 备份记录 | `kind,counts` |

`products.payload` 保存完整商品 JSON，确保原始 1537 条的所有字段（包括当前不展示的扩展字段）不丢失；列字段用于索引/筛选/同步。`market_price` 与 `collections.purchase_price` 完全独立。

## 7. 常用命令

```bash
npm run build          # 构建 app.js，并从环境变量生成 config.js
npm run check          # 校验 1537 条商品、20 主分类、ID 唯一
npm test               # 单元测试 + 迁移逻辑测试
npm run test:db        # 用 PGlite 执行真实 PostgreSQL 迁移/RLS/触发器测试
npm run test:e2e       # Edge headless 全流程测试（本地预览模式）
npm run test:full-backup
npm run config:check   # 检查 config.js 是否可连接（不输出密钥）
```

> `npm test` 在受限沙箱里可能因 Node test runner 需要 spawn 子进程而报 EPERM；在普通终端或 CI 中运行正常。

## 8. 安全与数据

- 前端只使用 anon public key；`.env.example` 中的 `SUPABASE_SERVICE_ROLE_KEY` 仅用于可选的服务器备份，不进入浏览器。
- RLS 已覆盖所有私人表；Storage 私有桶按 `auth.uid()` 目录隔离。
- 图片文件限制 12MB，JPG/PNG/WebP/AVIF；上传时自动压缩大图并生成 640px 缩略图。
- 删除分类不删除商品；删除商品会级联清理收藏、愿望、分类归属与图片记录（UI 会明确提示）。
- 原始 1537 条商品删除需要二次确认并输入“删除”。
- 完整备份包含个人购买价与备注，请妥善保管。

## 9. 已知限制 / 待云端验收

- 本开发环境没有可用的 Supabase 项目密钥，因此 **真实云端多设备同步、Auth 邮件、Storage 上传** 需要在用户配置 Supabase 后做一次线上验收；本地 E2E、数据库迁移/RLS/触发器、完整备份包已通过测试。
- 备份中的原始合集图与缩略图用于归档校验；恢复到新站点时，原始图片仍由项目 `assets/` 提供，用户上传图会重新上传到 Storage。
- 实时同步依赖 Supabase Realtime Publication；未开启时仍可通过刷新/重新进入/窗口聚焦同步。
- 浏览器在首次迁移时可能拦截自动下载的迁移前 JSON 快照；本机 V4 数据不会被删除，也可在账户里手动导出收藏 JSON。

## 10. 版本

- 网站：v5.0.0
- 数据结构：`2026-11-supabase-v1`
- 备份格式：`xmx-goods-backup` v2
- 基线：V4（`xmx-goods-site/xmx-goods-v2-preview`）
