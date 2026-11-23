import test from "node:test";
import assert from "node:assert/strict";
import {
  collectionToRow, defaultGiftCategoryFor, buildDefaultGiftAssignments, normalizeProduct,
  productToRow, rowToCollection, rowToProduct
} from "../src/model.js";
import { buildBackupData } from "../src/backup.js";
import { isCloudConfigured, validateSupabaseConfig } from "../src/utils.js";

const baseProduct = {
  id: "B01-001",
  name: "测试商品",
  category: "badge",
  categoryLabel: "吧唧",
  series: "测试系列",
  workId: "gyly",
  characterId: "xmx",
  version: "初版",
  price: null,
  priceText: "赠品",
  releaseDate: null,
  productCode: "P-001",
  image: { src: "assets/x.jpg", x: 1, y: 2, width: 3, height: 4, imageWidth: 10, imageHeight: 20 },
  folder: "测试",
  verificationStatus: "verified",
  duplicateGroup: null,
  notes: "备注",
  mainCategory: "吧唧",
  mainCategoryKey: "badge",
  board: null,
  boardKey: null,
  classificationStatus: "已确认",
  classificationBasis: "测试",
  classificationConfidence: "高",
  classificationSectionTitle: "标题",
  classificationRow: 1
};

test("normalizeProduct 保留 null 价格，不把 null 变成 0", () => {
  const p = normalizeProduct({ ...baseProduct, price: null, marketPrice: null });
  assert.equal(p.price, null);
  assert.equal(p.marketPrice, null);
});

test("normalizeProduct 保留 revision 并保留未知字段", () => {
  const p = normalizeProduct({ ...baseProduct, _revision: 7, customField: "保留我" });
  assert.equal(p._revision, 7);
  assert.equal(p.customField, "保留我");
});

test("productToRow / rowToProduct 完整往返，且 payload 不含 _revision", () => {
  const p = normalizeProduct({ ...baseProduct, marketPrice: 88.5, variety: "徽章", customField: "保留我", _revision: 3, isUserCreated: true });
  const row = productToRow(p, "11111111-1111-4111-8111-111111111111");
  assert.equal(row.market_price, 88.5);
  assert.equal(row.variety, "徽章");
  assert.equal(row.payload.marketPrice, 88.5);
  assert.equal("_revision" in row.payload, false);
  const back = rowToProduct({
    ...row,
    revision: 3,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z"
  });
  assert.equal(back.id, p.id);
  assert.equal(back.name, p.name);
  assert.equal(back.marketPrice, 88.5);
  assert.equal(back._revision, 3);
  assert.deepEqual(back.image, p.image);
  assert.equal(back.customField, "保留我");
});

test("收藏数量默认 1，购买价与市场价互不相关", () => {
  const p = normalizeProduct({ ...baseProduct, marketPrice: 100 });
  assert.equal(p.marketPrice, 100);
  const row = collectionToRow({ productId: p.id, quantity: 2, purchasePrice: 65, purchaseDate: "2026-02-03", note: "闲鱼" }, "owner");
  assert.equal(row.quantity, 2);
  assert.equal(row.purchase_price, 65);
  const back = rowToCollection({ ...row, revision: 1, created_at: "", updated_at: "" });
  assert.equal(back.quantity, 2);
  assert.equal(back.purchasePrice, 65);
  assert.equal(p.marketPrice, 100);
});

test("满赠默认分类规则", () => {
  assert.equal(defaultGiftCategoryFor({ category: "badge" }), "gift_badge");
  assert.equal(defaultGiftCategoryFor({ category: "card" }), "gift_paper");
  assert.equal(defaultGiftCategoryFor({ category: "keychain" }), "gift_acrylic");
  assert.equal(defaultGiftCategoryFor({ category: "standee" }), "gift_acrylic");
  assert.equal(defaultGiftCategoryFor({ category: "other" }), "gift_other");
  const assignments = buildDefaultGiftAssignments([
    { id: "A", boardKey: "gift", category: "badge" },
    { id: "B", boardKey: "collab", category: "badge" }
  ]);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].categoryId, "gift_badge");
});

test("备份 JSON 包含完整商品、收藏、分类、图片元数据", () => {
  const snapshot = {
    user: { id: "u1", email: "a@example.com" },
    products: [normalizeProduct({ ...baseProduct, marketPrice: 88.5, _revision: 3 })],
    collections: [{ productId: "B01-001", quantity: 2, purchasePrice: 65, purchaseDate: "2026-02-03", note: "" }],
    wishlist: ["B01-002"],
    boardCategories: [{ id: "c1", name: "分类", boardKey: "collab", sortOrder: 1 }],
    boardAssignments: [{ productId: "B01-001", boardKey: "collab", categoryId: "c1" }],
    productImages: [{ id: "img1", productId: "B01-001", kind: "highres", storagePath: "u1/B01-001/x.jpg" }],
    settings: { defaultsInitialized: true },
    mainCategories: [],
    works: [],
    characters: []
  };
  const data = buildBackupData(snapshot);
  assert.equal(data.format, "xmx-goods-backup");
  assert.equal(data.data.products.length, 1);
  assert.equal(data.data.products[0].revision, 3);
  assert.equal(data.counts.collections, 1);
  assert.equal(data.counts.boardCategories, 1);
  assert.equal(data.counts.productImages, 1);
  assert.equal(data.data.collections[0].purchasePrice, 65);
});

test("Supabase 配置校验拒绝 service_role 与错误 URL", () => {
  assert.equal(validateSupabaseConfig({ supabaseUrl: "https://abc.supabase.co", supabaseAnonKey: "a".repeat(60) }), null);
  assert.match(validateSupabaseConfig({ supabaseUrl: "http://abc.supabase.co", supabaseAnonKey: "a".repeat(60) }), /https/);
  assert.match(validateSupabaseConfig({ supabaseUrl: "https://abc.example.com", supabaseAnonKey: "a".repeat(60) }), /supabase\.co/);
  assert.match(validateSupabaseConfig({ supabaseUrl: "https://abc.supabase.co", supabaseAnonKey: "service_role" + "a".repeat(60) }), /service_role/);
  const jwt = [
    Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
    Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url"),
    "sig"
  ].join(".");
  assert.match(validateSupabaseConfig({ supabaseUrl: "https://abc.supabase.co", supabaseAnonKey: jwt }), /service_role/);
  assert.equal(isCloudConfigured({ supabaseUrl: "https://abc.supabase.co", supabaseAnonKey: "a".repeat(60) }), true);
});
