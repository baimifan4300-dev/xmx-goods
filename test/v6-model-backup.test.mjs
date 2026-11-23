import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  allocateOrderItems, bookSetProgress, bookToRow, collectionToRowV6, computeOrderTotals,
  effectiveMainCategories, normalizeBook, rowToCollectionV6, rowToV6Product, v6ProductToRow
} from "../src/v6/model.js";
import {
  buildV6BackupData, createV6Backup, inspectV6Backup, summarizeV6Data, v6SectionCounts
} from "../src/v6/backup.js";
import { SupabaseBackendV6 } from "../src/v6/cloud-supabase-v6.js";
import { V6_DEFAULT_STATUSES } from "../src/v6/constants.js";

const baseProduct = {
  id: "B01-001",
  name: "测试商品",
  workId: "gyly",
  characterId: "xmx",
  mainCategoryKey: "badge",
  series: "测试系列",
  marketPrice: 88.5,
  marketPriceDate: "2026-11-23",
  payload: {}
};

test("V6 商品行保留 market_price_date / series_id", () => {
  const row = v6ProductToRow({ ...baseProduct, seriesId: "series-1" }, "u1");
  assert.equal(row.market_price_date, "2026-11-23");
  assert.equal(row.series_id, "series-1");
  const back = rowToV6Product({ ...row, owner_id: "u1", revision: 1 });
  assert.equal(back.marketPriceDate, "2026-11-23");
  assert.equal(back.seriesId, "series-1");
});

test("内置分类改名/排序 + 自定义分类合并", () => {
  const list = effectiveMainCategories(
    [{ key: "badge", label: "吧唧", sort_order: 1 }, { key: "poster", label: "海报", sort_order: 2 }],
    [{ category_key: "badge", label: "徽章", sort_order: 3 }],
    [{ id: "custom-1", label: "手办", sort_order: 1 }]
  );
  assert.deepEqual(list.map((c) => c.key), ["custom-1", "poster", "badge"]);
  assert.equal(list.find((c) => c.key === "badge").label, "徽章");
  assert.equal(list.find((c) => c.key === "custom-1").isBuiltin, false);
});

test("V6 收藏行保留状态/目标价/地点/收货日期", () => {
  const row = collectionToRowV6({
    productId: "B01-001", quantity: 2, statusId: "preorder",
    targetPrice: 80, storeName: "测试店", expectedArrivalDate: "2026-12-01",
    locationId: "loc-1", receivedAt: "2026-12-02", purchasePrice: null
  }, "u1");
  assert.equal(row.status_id, "preorder");
  assert.equal(row.target_price, 80);
  assert.equal(row.location_id, "loc-1");
  assert.equal(row.received_at, "2026-12-02");
  const back = rowToCollectionV6({ ...row, revision: 1 });
  assert.equal(back.statusId, "preorder");
  assert.equal(back.targetPrice, 80);
  assert.equal(back.receivedAt, "2026-12-02");
});

test("书籍不同语言/出版社/版次/装帧独立映射", () => {
  const book = normalizeBook({
    id: "b1", title: "测试漫画", set_id: null, language: "繁体", publisher: "出版社B",
    edition: "再版", binding: "精装", volume_number: 1, status_id: "owned"
  });
  assert.equal(book.language, "繁体");
  assert.equal(book.publisher, "出版社B");
  assert.equal(book.edition, "再版");
  assert.equal(book.binding, "精装");
  const row = bookToRow(book, "u1");
  assert.equal(row.language, "繁体");
  assert.equal(row.status_id, "owned");
});

test("套书进度 12 卷、已拥有 1 卷、缺第 2 卷", () => {
  const set = { totalVolumes: 12 };
  const books = [
    { volumeNumber: 1, statusId: "owned", deletedAt: null },
    { volumeNumber: 2, statusId: "preorder", deletedAt: null }
  ];
  const progress = bookSetProgress(set, books, V6_DEFAULT_STATUSES);
  assert.equal(progress.totalVolumes, 12);
  assert.equal(progress.ownedVolumes, 1);
  assert.deepEqual(progress.missingVolumes, ["2"]);
});

test("订单应付/已付/退款/待补计算", () => {
  const totals = computeOrderTotals(
    { totalAmount: 200, shippingFee: 10, discountAmount: 5 },
    [
      { kind: "deposit", amount: 50, deletedAt: null },
      { kind: "balance", amount: 150, deletedAt: null },
      { kind: "refund", amount: 20, deletedAt: null }
    ]
  );
  assert.equal(totals.payable, 205);
  assert.equal(totals.paid, 180);
  assert.equal(totals.refunded, 20);
  assert.equal(totals.balanceDue, 25);
  assert.equal(totals.overpaid, 0);
});

test("多件订单按行金额分摊实付", () => {
  const allocated = allocateOrderItems([
    { unitPrice: 100, quantity: 1, lineDiscount: 0 },
    { unitPrice: 50, quantity: 1, lineDiscount: 0 }
  ], 165);
  assert.equal(allocated[0].allocated, 110);
  assert.equal(allocated[1].allocated, 55);
});

test("V6 备份结构包含全部核心配置/流水/软删除", () => {
  const snapshot = {
    user: { id: "u1", email: "a@example.com" },
    products: [baseProduct],
    collections: [{ productId: "B01-001", statusId: "owned" }],
    books: [{ id: "b1", title: "书" }],
    bookSets: [{ id: "s1", title: "套书" }],
    orders: [{ id: "o1" }],
    paymentRecords: [{ id: "p1" }],
    statusDefinitions: V6_DEFAULT_STATUSES,
    customMainCategories: [{ id: "custom-1", label: "手办" }],
    itemImages: [{ id: "i1", storagePath: "u1/books/x.webp" }],
    settings: { lastBackupAt: "2026-11-24" }
  };
  const data = buildV6BackupData(snapshot);
  assert.equal(data.format, "xmx-collection-backup");
  assert.equal(data.formatVersion, 4);
  assert.equal(data.counts.products, 1);
  assert.equal(data.counts.books, 1);
  assert.equal(data.counts.orders, 1);
  assert.equal(data.data.customMainCategories[0].label, "手办");
  assert.equal(v6SectionCounts(data).paymentRecords, 1);
  const summary = summarizeV6Data(data);
  assert.equal(summary.products, 1);
  assert.equal(summary.books, 1);
  assert.equal(summary.images, 1);
});

test("V6 v4 ZIP 可生成并读取", async () => {
  const snapshot = {
    user: { id: "u1" },
    products: [baseProduct],
    collections: [{ productId: "B01-001", statusId: "owned" }],
    books: [{ id: "b1", title: "书" }],
    orders: [{ id: "o1" }],
    paymentRecords: [{ id: "p1" }],
    statusDefinitions: V6_DEFAULT_STATUSES
  };
  const result = await createV6Backup(snapshot);
  assert.ok(result.blob.size > 0);
  assert.equal(result.manifest.formatVersion, 4);
  const inspection = await inspectV6Backup(await result.blob.arrayBuffer());
  assert.equal(inspection.sourceFormat, "v6");
  assert.equal(inspection.summary.products, 1);
  assert.equal(inspection.summary.books, 1);
});

test("V5 v2 备份可被识别并映射为 V6", async () => {
  const zip = new JSZip();
  const v5 = {
    format: "xmx-goods-backup",
    formatVersion: 2,
    schemaVersion: "2026-11-supabase-v1",
    exportedAt: "2026-11-23T00:00:00.000Z",
    owner: { id: "u1", email: "a@example.com" },
    counts: { products: 1, collections: 1, wishlist: 1 },
    data: {
      products: [baseProduct],
      collections: [{ productId: "B01-001", quantity: 2, purchasePrice: 65, statusId: undefined }],
      wishlist: ["B01-002"],
      boardCategories: [],
      boardAssignments: [],
      productImages: [{ productId: "B01-001", kind: "highres", storagePath: "u1/B01-001/x.webp" }],
      settings: {}
    }
  };
  zip.file("data.json", JSON.stringify(v5));
  zip.file("manifest.json", JSON.stringify({ format: v5.format, formatVersion: 2 }));
  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  const inspection = await inspectV6Backup(buffer);
  assert.equal(inspection.sourceFormat, "v5");
  assert.equal(inspection.data.data.collections.length, 2);
  assert.equal(inspection.data.data.collections[0].statusId, "owned");
  assert.equal(inspection.data.data.collections[1].statusId, "want");
  assert.equal(inspection.data.data.itemImages.length, 1);
});

test("V6 backend 适配器加载全部扩展表", async () => {
  class FakeBackend extends SupabaseBackendV6 {
    constructor() {
      super({ supabaseUrl: "http://x", supabaseAnonKey: "x" });
      this.user = { id: "u1", email: "a@example.com" };
      this.rows = {
        collection_types: [{ key: "goods" }, { key: "books" }],
        status_definitions: [{ id: "owned" }],
        main_category_prefs: [{ category_key: "badge", label: "吧唧" }],
        custom_main_categories: [{ id: "custom-1", label: "手办" }],
        series: [{ id: "s1", name: "系列" }],
        series_items: [{ id: "si1" }],
        locations: [{ id: "loc1" }],
        field_definitions: [{ id: "f1" }],
        field_values: [{ id: "fv1" }],
        book_types: [{ id: "manga" }],
        book_sets: [{ id: "bs1" }],
        books: [{ id: "b1" }],
        orders: [{ id: "o1" }],
        order_items: [{ id: "oi1" }],
        payment_records: [{ id: "p1" }],
        price_history: [{ id: "ph1" }],
        achievements: [{ id: "a1" }],
        user_achievements: [{ id: "ua1" }],
        item_images: [{ id: "img1" }],
        sales: [{ id: "sale1" }],
        duplicate_candidates: [{ id: "d1" }],
        status_history: [{ id: "sh1" }]
      };
    }
    async _selectAll(table) {
      return this.rows[table] || [];
    }
  }
  const backend = new FakeBackend();
  const extras = await backend.loadV6Extras();
  assert.equal(extras.collectionTypes.length, 2);
  assert.equal(extras.statusDefinitions.length, 1);
  assert.equal(extras.customMainCategories[0].label, "手办");
  assert.equal(extras.bookSets.length, 1);
  assert.equal(extras.books.length, 1);
  assert.equal(extras.orders.length, 1);
  assert.equal(extras.paymentRecords.length, 1);
  assert.equal(extras.itemImages.length, 1);
  assert.equal(extras.statusHistory.length, 1);
});
