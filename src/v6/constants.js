/* V6 constants — P1 model/backup skeleton.
 * 不修改 V5 的 constants.js；V5 备份仍为 v2。
 */
export const V6_APP_VERSION = "6.0.0";
export const V6_SCHEMA_VERSION = "2026-11-supabase-v2";
export const V6_BACKUP_FORMAT = "xmx-collection-backup";
export const V6_BACKUP_FORMAT_VERSION = 4;
export const V5_BACKUP_FORMAT = "xmx-goods-backup";

export const V6_COLLECTION_TYPES = [
  { key: "goods", label: "谷子收藏", icon: "✦", sortOrder: 1 },
  { key: "books", label: "书籍收藏", icon: "▤", sortOrder: 2 }
];

export const V6_DEFAULT_STATUSES = [
  { id: "want", label: "想要", color: "#d989a2", icon: "☆", sortOrder: 1, countsAsOwned: false, isTerminal: false },
  { id: "watch", label: "蹲价格", color: "#c9a36b", icon: "◷", sortOrder: 2, countsAsOwned: false, isTerminal: false },
  { id: "preorder", label: "已预订", color: "#8f9ec9", icon: "◇", sortOrder: 3, countsAsOwned: false, isTerminal: false },
  { id: "balance", label: "待补尾款", color: "#d08b5b", icon: "!", sortOrder: 4, countsAsOwned: false, isTerminal: false },
  { id: "owned", label: "已入手", color: "#6f9b76", icon: "✓", sortOrder: 5, countsAsOwned: true, isTerminal: false },
  { id: "cancelled", label: "已取消", color: "#9b9b9b", icon: "×", sortOrder: 6, countsAsOwned: false, isTerminal: true }
];

export const V6_DEFAULT_BOOK_TYPES = [
  { id: "manga", label: "漫画", sortOrder: 1 },
  { id: "novel", label: "小说", sortOrder: 2 },
  { id: "artbook", label: "画集", sortOrder: 3 },
  { id: "setting", label: "设定集", sortOrder: 4 },
  { id: "other", label: "其他书籍", sortOrder: 5 }
];

export const V6_TABLES = [
  "collectionTypes", "works", "characters", "mainCategories", "mainCategoryPrefs",
  "customMainCategories", "statusDefinitions", "bookTypes", "fieldDefinitions",
  "fieldValues", "series", "seriesItems", "products", "collections",
  "boardCategories", "boardAssignments", "productImages", "bookSets", "books",
  "orders", "orderItems", "paymentRecords", "priceHistory", "achievements",
  "userAchievements", "locations", "itemImages", "sales", "duplicateCandidates",
  "statusHistory", "settings", "trash"
];

export function defaultStatusMap(rows = []) {
  const map = new Map();
  for (const row of rows) map.set(row.id, row);
  for (const row of V6_DEFAULT_STATUSES) if (!map.has(row.id)) map.set(row.id, { ...row });
  return map;
}
