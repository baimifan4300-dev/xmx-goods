# 星愿收藏室 · 夏鸣星谷子图鉴

这是一个可部署到 GitHub Pages 的纯静态收藏图鉴。v3 已完成 1537 条商品的分类数据接入。

## 文件结构

- `index.html`：页面结构
- `style.css`：日系粉色主题样式
- `app.js`：页面交互、分类筛选、本地收藏状态
- `data/categories.json`：20 个主分类 + 联动/满赠独立板块 + 待核对的顺序配置
- `data/works.json`：作品/角色入口配置
- `data/gyly/xmx/products.json`：1537 条商品（原始字段 + 分类字段）
- `assets/works/gyly/xmx/images/`：57 张合集原图
- `assets/works/gyly/xmx/thumbs/`：1296 张商品裁剪缩略图
- `start.bat`：Windows 本地预览启动脚本

## 当前功能

- 收藏首页统计：商品总数、已拥有、愿望清单、收集率
- 全图鉴：搜索、分类筛选、收藏状态筛选、排序、加载更多
- 分类筛选：20 个主分类按整理表顺序排列；联动、满赠放在「独立板块」分组；另有「待核对」分组
- 商品详情：合集原图定位红框、分类、独立板块、分类状态、置信度、分类依据
- 我的收藏、愿望清单、收藏进度
- 收藏状态保存在当前浏览器 `localStorage`（键名 `xmx.collection.v1`）

## 分类数据说明

`data/gyly/xmx/products.json` 保留原有字段（id、name、category、categoryLabel、series、price、image、folder 等），并新增：

- `mainCategory` / `mainCategoryKey`：主分类中文名 / 分类 key（20 个之一）
- `board` / `boardKey`：独立板块（联动 / 满赠）
- `classificationStatus`：已确认 / 待核对
- `classificationBasis`：分类依据
- `classificationConfidence`：高 / 中 / 低
- `classificationSectionTitle`：原合集图标题
- `classificationRow`：图内行号

统计：20 个主分类 1102 条；联动 347 条；满赠 77 条；待核对 11 条；合计 1537 条。

## 本地预览

直接双击 `index.html` 通常无法读取 `data/*.json`（浏览器的本地文件安全限制）。请用本地 HTTP 服务：

### 方式一：start.bat

双击 `start.bat`，浏览器访问 `http://127.0.0.1:8765/`。

### 方式二：命令行

在项目根目录执行：

```bash
python -m http.server 8765
```

然后访问：

- 首页：`http://127.0.0.1:8765/`
- 图鉴：`http://127.0.0.1:8765/#/w/gyly/c/xmx/catalog`
- 我的收藏：`http://127.0.0.1:8765/#/w/gyly/c/xmx/owned`
- 愿望清单：`http://127.0.0.1:8765/#/w/gyly/c/xmx/wishlist`
- 收藏进度：`http://127.0.0.1:8765/#/w/gyly/c/xmx/progress`

## 发布到 GitHub Pages

1. 打开仓库 `https://github.com/baimifan4300-dev/xmx-goods`
2. 把 `index.html`、`style.css`、`app.js`、`data`、`assets` 上传到仓库根目录。
3. Commit 后，在 Settings → Pages 选择 `main` 分支、`/(root)` 目录。
4. 访问 `https://baimifan4300-dev.github.io/xmx-goods/`。

## 数据保存说明

当前版本是纯静态网页，收藏状态保存在当前浏览器 localStorage。换设备、换浏览器或清理网站数据后不会自动同步。商品资料本身来自 `data/gyly/xmx/products.json`，由 JSON 统一维护。
