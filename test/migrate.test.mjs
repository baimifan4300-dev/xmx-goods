import test from "node:test";
import assert from "node:assert/strict";

const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => memory.has(k) ? memory.get(k) : null,
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k)
};

const { readLegacyLocalData, migrateToCloud } = await import("../src/migrate.js");

function fakeBackend() {
  const state = {
    products: [],
    categories: [],
    assignments: [],
    collections: [],
    wishlist: [],
    settings: {}
  };
  return {
    user: { id: "u1" },
    state,
    async insertProducts(list) { state.products.push(...list); return list.length; },
    async insertBoardCategories(list) { state.categories.push(...list); return list.length; },
    async insertBoardAssignments(list) { state.assignments.push(...list); return list.length; },
    async insertCollections(list) { state.collections.push(...list); return list.length; },
    async insertWishlist(list) { state.wishlist.push(...list); return list.length; },
    async mergeSettings(patch) { state.settings = { ...state.settings, ...patch }; return state.settings; },
    async loadSnapshot() {
      return { products: state.products, boardCategories: state.categories, boardAssignments: state.assignments };
    }
  };
}

test("V4 本地数据迁移：商品、收藏、愿望、自定义分类与归属", async () => {
  memory.clear();
  localStorage.setItem("xmx.collection.v1", JSON.stringify({
    version: 1,
    owned: {
      "B01-001": { price: 65, date: "2026-02-03", note: "旧备注" },
      "NOT-EXIST": { price: 10 }
    },
    wishlist: ["B01-002", "NOT-EXIST"]
  }));
  localStorage.setItem("xmx.boards.v1.gyly.xmx", JSON.stringify({
    version: 1,
    boards: {
      collab: {
        categories: [{ id: "c_custom", name: "旧联动分类" }],
        assignments: { "B01-002": "c_custom", "NOT-EXIST": "c_custom" }
      },
      gift: { categories: [], assignments: {} }
    }
  }));
  const legacy = readLegacyLocalData();
  assert.equal(legacy.hasAny, true);
  assert.equal(legacy.categories.length, 1);

  const baseProducts = [
    { id: "B01-001", name: "商品一", category: "badge", categoryLabel: "吧唧", workId: "gyly", characterId: "xmx", image: {} },
    { id: "B01-002", name: "商品二", category: "card", categoryLabel: "纸制品", workId: "gyly", characterId: "xmx", image: {}, boardKey: "collab", board: "联动" }
  ];
  const backend = fakeBackend();
  const report = await migrateToCloud(backend, {
    snapshot: { products: [], boardCategories: [], boardAssignments: [] },
    baseProducts,
    legacy
  });
  assert.equal(report.initial, true);
  assert.equal(backend.state.products.length, 2);
  assert.equal(backend.state.categories.length, 1);
  assert.equal(backend.state.categories[0].id, "c_custom");
  assert.equal(backend.state.assignments.length, 1);
  assert.equal(backend.state.assignments[0].productId, "B01-002");
  assert.equal(backend.state.collections.length, 1);
  assert.equal(backend.state.collections[0].purchasePrice, 65);
  assert.equal(backend.state.wishlist.length, 1);
  assert.equal(backend.state.settings.defaultsInitialized, true);
  assert.equal(backend.state.settings.migration.source, "local-v4");
  assert.equal(localStorage.getItem("xmx.migrated.v5.u1"), "1");
});

test("迁移重复执行不会重复商品（由 upsert ignoreDuplicates 保证），且不会删除本机键", async () => {
  const backend = fakeBackend();
  backend.state.products = [{ id: "B01-001", name: "已有" }];
  const legacy = readLegacyLocalData();
  const report = await migrateToCloud(backend, {
    snapshot: { products: [{ id: "B01-001" }], boardCategories: [], boardAssignments: [] },
    baseProducts: [],
    legacy
  });
  assert.equal(report.initial, false);
  assert.equal(backend.state.products.length, 1, "合并模式不会重新导入内置 1537 条");
  assert.equal(localStorage.getItem("xmx.collection.v1") !== null, true, "本机收藏键保留");
  assert.equal(localStorage.getItem("xmx.boards.v1.gyly.xmx") !== null, true, "本机分类键保留");
});
