/* V6 backup — P1 skeleton. V5 的 src/backup.js 保持不变，V6 独立格式 v4。 */
import JSZip from "jszip";
import {
  V6_APP_VERSION, V6_BACKUP_FORMAT, V6_BACKUP_FORMAT_VERSION,
  V6_SCHEMA_VERSION, V5_BACKUP_FORMAT, V6_DEFAULT_STATUSES, V6_TABLES
} from "./constants.js";
import { stripV6Runtime } from "./model.js";

const V6_ARRAY_KEYS = [
  "collectionTypes", "works", "characters", "mainCategories", "mainCategoryPrefs",
  "customMainCategories", "statusDefinitions", "bookTypes", "fieldDefinitions",
  "fieldValues", "series", "seriesItems", "products", "collections",
  "boardCategories", "boardAssignments", "productImages", "bookSets", "books",
  "orders", "orderItems", "paymentRecords", "priceHistory", "achievements",
  "userAchievements", "locations", "itemImages", "sales", "duplicateCandidates",
  "statusHistory", "trash"
];

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function countOf(snapshot) {
  const counts = {};
  for (const key of V6_ARRAY_KEYS) counts[key] = arrayOf(snapshot[key]).length;
  counts.products = arrayOf(snapshot.products).length;
  counts.books = arrayOf(snapshot.books).length;
  counts.bookSets = arrayOf(snapshot.bookSets).length;
  counts.orders = arrayOf(snapshot.orders).length;
  counts.paymentRecords = arrayOf(snapshot.paymentRecords).length;
  return counts;
}

export function buildV6BackupData(snapshot = {}) {
  const data = {};
  for (const key of V6_ARRAY_KEYS) {
    data[key] = stripV6Runtime(arrayOf(snapshot[key]));
  }
  // settings 是对象，不是数组
  data.settings = snapshot.settings && typeof snapshot.settings === "object" ? { ...snapshot.settings } : {};
  return {
    format: V6_BACKUP_FORMAT,
    formatVersion: V6_BACKUP_FORMAT_VERSION,
    schemaVersion: V6_SCHEMA_VERSION,
    appVersion: V6_APP_VERSION,
    exportedAt: new Date().toISOString(),
    owner: {
      id: snapshot.user?.id || null,
      email: snapshot.user?.email || null
    },
    counts: countOf(snapshot),
    data
  };
}

export function buildV6Manifest(data, options = {}) {
  return {
    format: V6_BACKUP_FORMAT,
    formatVersion: V6_BACKUP_FORMAT_VERSION,
    schemaVersion: V6_SCHEMA_VERSION,
    appVersion: V6_APP_VERSION,
    exportedAt: data.exportedAt,
    owner: data.owner,
    counts: data.counts,
    options: {
      includeBaseImages: options.includeBaseImages !== false,
      includeThumbs: options.includeThumbs !== false,
      includeTrash: options.includeTrash !== false
    },
    dataFile: "data.json",
    images: arrayOf(options.images),
    warnings: arrayOf(options.warnings)
  };
}

/**
 * P1 骨架：生成 data.json + manifest.json + README 的 ZIP。
 * 图片下载/校验在 P6 完整备份里实现；P1 不把它伪装成含图片的完整包。
 */
export async function createV6Backup(snapshot, options = {}) {
  const data = buildV6BackupData(snapshot);
  const manifest = buildV6Manifest(data, options);
  const zip = new JSZip();
  zip.file("data.json", JSON.stringify(data, null, 2), { compression: "DEFLATE", compressionOptions: { level: 6 } });
  zip.file("manifest.json", JSON.stringify(manifest, null, 2), { compression: "DEFLATE", compressionOptions: { level: 6 } });
  zip.file("README.txt", [
    "星愿收藏室 · V6 数据备份（P1 骨架）",
    `导出时间：${data.exportedAt}`,
    `数据格式：v${V6_BACKUP_FORMAT_VERSION} · ${V6_SCHEMA_VERSION}`,
    `商品：${data.counts.products}；书籍：${data.counts.books}；套书：${data.counts.bookSets}`,
    `订单：${data.counts.orders}；付款流水：${data.counts.paymentRecords}`,
    "",
    "P1 骨架只包含 data.json/manifest.json，不包含图片；P6 会加入完整图片与 SHA-256。",
    "恢复请回到网站，不要手工修改本压缩包。"
  ].join("\n"), { compression: "DEFLATE" });
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE", streamFiles: true });
  return { blob, data, manifest, warnings: manifest.warnings };
}

export function v6BackupFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `xmx-collection-backup-v4-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.zip`;
}

/**
 * 读取备份并区分 V6 v4 / V5 v2。
 * V5 v2 会被映射成 V6 结构，便于 P6 恢复；P1 只做预览，不写数据库。
 */
export async function inspectV6Backup(file) {
  const zip = await JSZip.loadAsync(file);
  const manifestFile = zip.file("manifest.json");
  const dataFile = zip.file("data.json");
  if (!manifestFile) throw new Error("备份包缺少 manifest.json。");
  if (!dataFile) throw new Error("备份包缺少 data.json。");
  const manifest = JSON.parse(await manifestFile.async("string"));
  const raw = JSON.parse(await dataFile.async("string"));

  const isV6 = raw.format === V6_BACKUP_FORMAT || manifest.format === V6_BACKUP_FORMAT;
  const isV5 = raw.format === V5_BACKUP_FORMAT || manifest.format === V5_BACKUP_FORMAT;
  if (!isV6 && !isV5) throw new Error("不是星愿收藏室的备份格式。");

  if (isV5) {
    const version = Number(raw.formatVersion ?? manifest.formatVersion ?? 2);
    if (version > 2) throw new Error(`V5 备份版本 v${version} 高于当前支持的 v2。`);
    const data = mapV5ToV6(raw);
    return {
      zip, manifest, raw, data,
      sourceFormat: "v5",
      sourceVersion: version,
      summary: summarizeV6Data(data),
      images: arrayOf(raw.data?.productImages),
      warnings: ["这是 V5 v2 备份，将按 V6 结构映射；书籍/订单等 V6 数据为空。"]
    };
  }

  const version = Number(raw.formatVersion ?? manifest.formatVersion ?? 0);
  if (version > V6_BACKUP_FORMAT_VERSION) {
    throw new Error(`备份版本 v${version} 高于当前网站支持的 v${V6_BACKUP_FORMAT_VERSION}。`);
  }
  if (!raw.data || !Array.isArray(raw.data.products)) {
    throw new Error("V6 备份数据不完整：缺少 products。");
  }
  return {
    zip, manifest, raw, data: raw,
    sourceFormat: "v6",
    sourceVersion: version,
    summary: summarizeV6Data(raw),
    images: arrayOf(raw.data.itemImages).concat(arrayOf(raw.data.productImages)),
    warnings: arrayOf(manifest.warnings)
  };
}

function mapV5ToV6(raw) {
  const src = raw.data || {};
  const products = arrayOf(src.products);
  const collections = arrayOf(src.collections).map((c) => ({
    ...c,
    statusId: c.statusId || c.status_id || "owned",
    targetPrice: null,
    purchaseUrl: "",
    storeName: "",
    expectedArrivalDate: "",
    wishlistNote: "",
    locationId: null,
    receivedAt: "",
    deletedAt: null
  }));
  const wishlist = arrayOf(src.wishlist).map((w) => ({
    productId: typeof w === "string" ? w : w.productId || w.product_id,
    quantity: 1,
    purchasePrice: null,
    purchaseDate: "",
    note: "",
    statusId: "want",
    targetPrice: null,
    purchaseUrl: "",
    storeName: "",
    expectedArrivalDate: "",
    wishlistNote: "",
    locationId: null,
    receivedAt: "",
    deletedAt: null
  }));
  return {
    format: V6_BACKUP_FORMAT,
    formatVersion: V6_BACKUP_FORMAT_VERSION,
    schemaVersion: V6_SCHEMA_VERSION,
    appVersion: V6_APP_VERSION,
    exportedAt: raw.exportedAt || new Date().toISOString(),
    owner: raw.owner || { id: null, email: null },
    counts: { products: products.length, books: 0, bookSets: 0, orders: 0, paymentRecords: 0 },
    data: {
      collectionTypes: [
        { key: "goods", label: "谷子收藏", icon: "✦", sortOrder: 1 },
        { key: "books", label: "书籍收藏", icon: "▤", sortOrder: 2 }
      ],
      works: arrayOf(src.works),
      characters: arrayOf(src.characters),
      mainCategories: arrayOf(src.mainCategories),
      mainCategoryPrefs: [],
      customMainCategories: [],
      statusDefinitions: V6_DEFAULT_STATUSES.map((s) => ({ ...s, scope: "all", isBuiltin: true })),
      bookTypes: [],
      fieldDefinitions: [],
      fieldValues: [],
      series: [],
      seriesItems: [],
      products,
      collections: [...collections, ...wishlist.filter((w) => !collections.some((c) => c.productId === w.productId))],
      boardCategories: arrayOf(src.boardCategories),
      boardAssignments: arrayOf(src.boardAssignments),
      productImages: arrayOf(src.productImages),
      bookSets: [],
      books: [],
      orders: [],
      orderItems: [],
      paymentRecords: [],
      priceHistory: [],
      achievements: [],
      userAchievements: [],
      locations: [],
      itemImages: arrayOf(src.productImages).map((img) => ({
        entityType: "product",
        entityId: img.productId,
        kind: img.kind === "highres" ? "photo" : "cover",
        storagePath: img.storagePath,
        thumbPath: img.thumbPath || null,
        isPrimary: img.kind === "highres",
        sortOrder: 0,
        caption: img.fileName || "",
        mimeType: img.mimeType || null,
        sizeBytes: img.sizeBytes || null,
        width: img.width || null,
        height: img.height || null
      })),
      sales: [],
      duplicateCandidates: [],
      statusHistory: [],
      settings: src.settings || {},
      trash: []
    }
  };
}

export function summarizeV6Data(data) {
  const d = data?.data || {};
  return {
    exportedAt: data?.exportedAt,
    products: arrayOf(d.products).length,
    collections: arrayOf(d.collections).length,
    books: arrayOf(d.books).length,
    bookSets: arrayOf(d.bookSets).length,
    orders: arrayOf(d.orders).length,
    paymentRecords: arrayOf(d.paymentRecords).length,
    statuses: arrayOf(d.statusDefinitions).length,
    categories: arrayOf(d.customMainCategories).length + arrayOf(d.mainCategories).length,
    images: arrayOf(d.itemImages).length + arrayOf(d.productImages).length
  };
}

export function v6SectionCounts(data) {
  const d = data?.data || {};
  return Object.fromEntries(V6_TABLES.map((key) => [key, arrayOf(d[key]).length]));
}
