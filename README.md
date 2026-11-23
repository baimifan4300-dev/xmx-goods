# 星愿收藏室 · 夏鸣星谷子图鉴

这是一个可部署到 GitHub Pages 的纯静态收藏图鉴初版。

## 文件结构

- `index.html`：页面结构
- `style.css`：日系粉色主题样式
- `app.js`：页面交互与本地收藏状态
- `data/products.json`：初始商品数据（当前为空）

## 本地预览

直接双击 `index.html` 通常无法读取 `data/products.json`（浏览器的本地文件安全限制）。建议用 VS Code 的 Live Server，或部署到 GitHub Pages 后访问。

## 发布到 GitHub Pages

1. 打开仓库 `https://github.com/baimifan4300-dev/xmx-goods`
2. 点击 **Add file → Upload files**。
3. 解压本压缩包，把 `index.html`、`style.css`、`app.js` 和 `data` 文件夹上传到仓库根目录（不要把外层 `xmx-goods-site` 文件夹整个套进去）。
4. 点击 **Commit changes**。
5. 打开仓库 **Settings → Pages**。
6. 在 **Build and deployment** 中选择 `Deploy from a branch`。
7. Branch 选 `main`，目录选 `/(root)`，点击 Save。
8. 等待 GitHub Pages 部署完成，访问 `https://baimifan4300-dev.github.io/xmx-goods/`。

## 当前功能

- 收藏首页统计：商品总数、已拥有、愿望清单、收集率
- 全图鉴：搜索、类别筛选、状态筛选、排序
- 添加、编辑商品
- 标记已拥有、加入/移出愿望清单
- 我的收藏、愿望清单
- 总体与类别收集进度
- 商品与收藏状态保存在当前浏览器

## 数据保存说明（重要）

当前版本是纯静态网页，商品数据和收藏状态保存在**当前浏览器**的 localStorage 中。换设备、换浏览器或清理网站数据后不会自动同步。请勿把浏览器本地存储误认为 GitHub 云端数据库。

目前商品数据初始模板在 `data/products.json`。之后如需让不同设备同步、多人共用或上传图片，需增加云数据库/后端服务。

## 商品数据格式示例

```json
[
  {
    "id": "tx-001",
    "name": "夏鸣星主题徽章",
    "category": "徽章/吧唧",
    "series": "示例系列",
    "price": 35,
    "code": "TX-001",
    "image": "",
    "note": ""
  }
]
```

`category` 建议使用：`徽章/吧唧`、`立牌`、`挂件`、`纸类`、`毛绒`、`其他`。

## 下一阶段建议

1. 导入真实商品清单与合集原图。
2. 为每件商品补充原图坐标 `image_region`，前端再实现原图裁剪显示。
3. 增加商品详情页、花费统计、数据导入导出和云端同步。
