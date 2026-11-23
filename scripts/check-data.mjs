import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productsPath = path.join(root, "data/gyly/xmx/products.json");
const categoriesPath = path.join(root, "data/categories.json");
const products = JSON.parse(fs.readFileSync(productsPath, "utf8"));
const categories = JSON.parse(fs.readFileSync(categoriesPath, "utf8"));

const errors = [];
if (!Array.isArray(products)) errors.push("products.json 不是数组");
if (products.length !== 1537) errors.push(`商品数应为 1537，实际 ${products.length}`);
if (new Set(products.map((p) => p.id)).size !== products.length) errors.push("商品 ID 有重复");
if (categories.main?.length !== 20) errors.push(`主分类应为 20，实际 ${categories.main?.length}`);
if (categories.boards?.length !== 2) errors.push(`独立板块应为 2，实际 ${categories.boards?.length}`);

const required = ["id", "name", "category", "categoryLabel", "workId", "characterId", "image", "folder"];
for (const p of products) {
  for (const key of required) {
    if (!(key in p)) errors.push(`${p.id || "(no id)"} 缺少字段 ${key}`);
  }
  if (!p.image?.src) errors.push(`${p.id} 缺少 image.src`);
}

const board = products.reduce((acc, p) => {
  const key = p.boardKey || "main";
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

console.log(JSON.stringify({
  products: products.length,
  uniqueIds: new Set(products.map((p) => p.id)).size,
  mainCategories: categories.main.length,
  boards: categories.boards.map((b) => b.key),
  distribution: board,
  errors
}, null, 2));

if (errors.length) process.exit(1);
