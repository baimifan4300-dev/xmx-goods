/* V6 model — P1. 只新增模块，不修改 V5 的 model.js/运行中的 app.js。 */
import { normalizeProduct, productToRow, rowToProduct } from "../model.js";
import { defaultStatusMap } from "./constants.js";

function textOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value, fallback = false) {
  return value === undefined || value === null ? fallback : Boolean(value);
}

function dateOrNull(value) {
  const text = textOrNull(value);
  return text ? text.slice(0, 10) : null;
}

function runtimeFree(row) {
  const out = { ...row };
  for (const key of ["_images", "_imageUrl", "_thumbUrl", "_highResUrl", "_coverUrl", "_signed", "_local", "_uploading"]) delete out[key];
  return out;
}

/* -------------------------------------------------------------------------- */
/* 谷子（V6 增量字段）                                                        */
/* -------------------------------------------------------------------------- */

export function rowToV6Product(row) {
  const product = rowToProduct(row);
  product.marketPriceDate = row.market_price_date || null;
  product.seriesId = row.series_id || null;
  product.deletedAt = row.deleted_at || null;
  return product;
}

export function v6ProductToRow(product, ownerId, options = {}) {
  const row = productToRow(product, ownerId, options);
  row.market_price_date = dateOrNull(product.marketPriceDate);
  row.series_id = textOrNull(product.seriesId);
  if (options.includeDeleted) {
    row.deleted_at = product.deletedAt || null;
    row.deleted_reason = product.deletedReason || null;
  }
  return row;
}

export function rowToCollectionV6(row) {
  return {
    productId: row.product_id,
    quantity: Math.max(1, Number(row.quantity) || 1),
    purchasePrice: row.purchase_price === null ? null : Number(row.purchase_price),
    purchaseDate: row.purchase_date || "",
    note: row.note || "",
    statusId: row.status_id || "owned",
    targetPrice: row.target_price === null ? null : Number(row.target_price),
    purchaseUrl: row.purchase_url || "",
    storeName: row.store_name || "",
    expectedArrivalDate: row.expected_arrival_date || "",
    wishlistNote: row.wishlist_note || "",
    locationId: row.location_id || null,
    receivedAt: row.received_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || null
  };
}

export function collectionToRowV6(entry, ownerId, options = {}) {
  const row = {
    owner_id: ownerId,
    product_id: entry.productId,
    quantity: Math.max(1, Number(entry.quantity) || 1),
    purchase_price: numberOrNull(entry.purchasePrice),
    purchase_date: dateOrNull(entry.purchaseDate),
    note: textOrNull(entry.note),
    status_id: entry.statusId || "owned",
    target_price: numberOrNull(entry.targetPrice),
    purchase_url: textOrNull(entry.purchaseUrl),
    store_name: textOrNull(entry.storeName),
    expected_arrival_date: dateOrNull(entry.expectedArrivalDate),
    wishlist_note: textOrNull(entry.wishlistNote),
    location_id: entry.locationId || null,
    received_at: dateOrNull(entry.receivedAt)
  };
  if (options.includeRevision && Number.isInteger(entry.revision)) row.revision = entry.revision;
  return row;
}

/* -------------------------------------------------------------------------- */
/* 状态 / 分类 / 系列 / 地点 / 字段                                             */
/* -------------------------------------------------------------------------- */

export function normalizeStatus(row = {}) {
  return {
    id: String(row.id || ""),
    ownerId: row.owner_id || row.ownerId || null,
    scope: row.scope || "all",
    label: row.label || "",
    color: row.color || "#d989a2",
    icon: row.icon || "☆",
    iconPath: row.icon_path || row.iconPath || null,
    sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
    isBuiltin: bool(row.is_builtin ?? row.isBuiltin),
    countsAsOwned: bool(row.counts_as_owned ?? row.countsAsOwned),
    isTerminal: bool(row.is_terminal ?? row.isTerminal),
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function statusToRow(status, ownerId) {
  return {
    owner_id: ownerId,
    id: status.id,
    scope: status.scope || "all",
    label: status.label,
    color: status.color || null,
    icon: status.icon || null,
    icon_path: status.iconPath || null,
    sort_order: Number(status.sortOrder) || 0,
    is_builtin: bool(status.isBuiltin),
    counts_as_owned: bool(status.countsAsOwned),
    is_terminal: bool(status.isTerminal)
  };
}

export function effectiveMainCategories(globalRows = [], prefs = [], custom = []) {
  const prefMap = new Map(prefs.map((p) => [p.category_key || p.key, p]));
  const builtIn = globalRows.map((row, index) => {
    const pref = prefMap.get(row.key);
    return {
      key: row.key,
      label: pref?.label || row.label,
      sortOrder: Number(pref?.sort_order ?? row.sort_order ?? index + 1),
      isBuiltin: true
    };
  });
  const customRows = custom
    .filter((row) => !row.deleted_at)
    .map((row) => ({
      key: row.id,
      label: row.label,
      sortOrder: Number(row.sort_order) || 0,
      isBuiltin: false
    }));
  return [...builtIn, ...customRows].sort((a, b) => (a.sortOrder - b.sortOrder) || a.key.localeCompare(b.key));
}

export function normalizeSeries(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    type: row.type || "goods",
    name: row.name || "",
    workId: row.work_id || row.workId || null,
    characterId: row.character_id || row.characterId || null,
    description: row.description || "",
    coverImageId: row.cover_image_id || row.coverImageId || null,
    totalExpected: numberOrNull(row.total_expected ?? row.totalExpected),
    sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function normalizeSeriesItem(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    seriesId: row.series_id || row.seriesId,
    entityType: row.entity_type || row.entityType || "manual",
    productId: row.product_id || row.productId || null,
    bookId: row.book_id || row.bookId || null,
    displayName: row.display_name || row.displayName || "",
    imagePath: row.image_path || row.imagePath || null,
    officialNo: row.official_no || row.officialNo || null,
    volumeLabel: row.volume_label || row.volumeLabel || null,
    statusId: row.status_id || row.statusId || null,
    sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
    note: row.note || "",
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function normalizeLocation(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    name: row.name || "",
    kind: row.kind || "other",
    parentId: row.parent_id || row.parentId || null,
    sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
    note: row.note || "",
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function normalizeFieldDefinition(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    scope: row.scope || "all",
    key: row.key || "",
    label: row.label || "",
    fieldType: row.field_type || row.fieldType || "text",
    options: Array.isArray(row.options) ? row.options : [],
    required: bool(row.required),
    sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
    isActive: bool(row.is_active ?? row.isActive, true),
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function normalizeFieldValue(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    fieldId: row.field_id || row.fieldId,
    entityType: row.entity_type || row.entityType,
    entityId: row.entity_id || row.entityId,
    valueText: row.value_text ?? row.valueText ?? null,
    valueNumber: row.value_number === null || row.value_number === undefined ? null : Number(row.value_number),
    valueDate: row.value_date || row.valueDate || null,
    valueJson: row.value_json ?? row.valueJson ?? null,
    revision: Number(row.revision) || 1
  };
}

/* -------------------------------------------------------------------------- */
/* 书籍                                                                       */
/* -------------------------------------------------------------------------- */

export function normalizeBookType(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    label: row.label || "",
    sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
    isBuiltin: bool(row.is_builtin ?? row.isBuiltin),
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function normalizeBookSet(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    seriesId: row.series_id || row.seriesId || null,
    title: row.title || "",
    bookTypeId: row.book_type_id || row.bookTypeId || null,
    language: row.language || "",
    publisher: row.publisher || "",
    edition: row.edition || "",
    binding: row.binding || "",
    totalVolumes: numberOrNull(row.total_volumes ?? row.totalVolumes),
    description: row.description || "",
    coverImageId: row.cover_image_id || row.coverImageId || null,
    sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function normalizeBook(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    setId: row.set_id || row.setId || null,
    bookTypeId: row.book_type_id || row.bookTypeId || null,
    title: row.title || "",
    subtitle: row.subtitle || "",
    author: row.author || "",
    illustrator: row.illustrator || "",
    publisher: row.publisher || "",
    language: row.language || "",
    edition: row.edition || "",
    binding: row.binding || "",
    volumeLabel: row.volume_label || row.volumeLabel || "",
    volumeNumber: numberOrNull(row.volume_number ?? row.volumeNumber),
    isbn: row.isbn || "",
    coverImageId: row.cover_image_id || row.coverImageId || null,
    purchasePrice: numberOrNull(row.purchase_price ?? row.purchasePrice),
    marketPrice: numberOrNull(row.market_price ?? row.marketPrice),
    marketPriceDate: dateOrNull(row.market_price_date ?? row.marketPriceDate),
    purchaseDate: dateOrNull(row.purchase_date ?? row.purchaseDate),
    purchaseChannel: row.purchase_channel || row.purchaseChannel || "",
    statusId: row.status_id || row.statusId || "want",
    locationId: row.location_id || row.locationId || null,
    quantity: Math.max(1, Number(row.quantity) || 1),
    notes: row.notes || "",
    receivedAt: dateOrNull(row.received_at ?? row.receivedAt),
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function bookToRow(book, ownerId, options = {}) {
  const row = {
    owner_id: ownerId,
    id: book.id || undefined,
    set_id: book.setId || null,
    book_type_id: book.bookTypeId || null,
    title: book.title,
    subtitle: textOrNull(book.subtitle),
    author: textOrNull(book.author),
    illustrator: textOrNull(book.illustrator),
    publisher: textOrNull(book.publisher),
    language: textOrNull(book.language),
    edition: textOrNull(book.edition),
    binding: textOrNull(book.binding),
    volume_label: textOrNull(book.volumeLabel),
    volume_number: numberOrNull(book.volumeNumber),
    isbn: textOrNull(book.isbn),
    cover_image_id: book.coverImageId || null,
    purchase_price: numberOrNull(book.purchasePrice),
    market_price: numberOrNull(book.marketPrice),
    market_price_date: dateOrNull(book.marketPriceDate),
    purchase_date: dateOrNull(book.purchaseDate),
    purchase_channel: textOrNull(book.purchaseChannel),
    status_id: book.statusId || "want",
    location_id: book.locationId || null,
    quantity: Math.max(1, Number(book.quantity) || 1),
    notes: textOrNull(book.notes),
    received_at: dateOrNull(book.receivedAt)
  };
  if (options.includeRevision && Number.isInteger(book.revision)) row.revision = book.revision;
  return row;
}

export function bookSetToRow(set, ownerId, options = {}) {
  const row = {
    owner_id: ownerId,
    id: set.id || undefined,
    series_id: set.seriesId || null,
    title: set.title,
    book_type_id: set.bookTypeId || null,
    language: textOrNull(set.language),
    publisher: textOrNull(set.publisher),
    edition: textOrNull(set.edition),
    binding: textOrNull(set.binding),
    total_volumes: numberOrNull(set.totalVolumes),
    description: textOrNull(set.description),
    cover_image_id: set.coverImageId || null,
    sort_order: Number(set.sortOrder) || 0
  };
  if (options.includeRevision && Number.isInteger(set.revision)) row.revision = set.revision;
  return row;
}

export function bookSetProgress(set, books = [], statuses = []) {
  const statusMap = defaultStatusMap(statuses);
  const active = books.filter((b) => !b.deletedAt);
  const owned = active.filter((b) => statusMap.get(b.statusId)?.countsAsOwned);
  const missing = active
    .filter((b) => !statusMap.get(b.statusId)?.countsAsOwned)
    .map((b) => b.volumeLabel || (b.volumeNumber != null ? String(b.volumeNumber) : "未标卷"));
  const total = Number(set.totalVolumes) > 0 ? Number(set.totalVolumes) : active.length;
  return {
    totalVolumes: total,
    ownedVolumes: owned.length,
    missingVolumes: missing,
    rate: total ? Math.round((owned.length / total) * 100) : 0
  };
}

/* -------------------------------------------------------------------------- */
/* 订单 / 付款                                                                */
/* -------------------------------------------------------------------------- */

export function normalizeOrder(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    orderNo: row.order_no || row.orderNo || "",
    shopName: row.shop_name || row.shopName || "",
    orderUrl: row.order_url || row.orderUrl || "",
    currency: row.currency || "CNY",
    totalAmount: Number(row.total_amount ?? row.totalAmount) || 0,
    shippingFee: Number(row.shipping_fee ?? row.shippingFee) || 0,
    discountAmount: Number(row.discount_amount ?? row.discountAmount) || 0,
    depositPlanned: numberOrNull(row.deposit_planned ?? row.depositPlanned),
    orderedAt: row.ordered_at || row.orderedAt || "",
    expectedArrivalDate: row.expected_arrival_date || row.expectedArrivalDate || "",
    balanceDueDate: row.balance_due_date || row.balanceDueDate || "",
    status: row.status || "open",
    note: row.note || "",
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function normalizeOrderItem(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    orderId: row.order_id || row.orderId,
    entityType: row.entity_type || row.entityType,
    entityId: row.entity_id || row.entityId,
    quantity: Math.max(1, Number(row.quantity) || 1),
    unitPrice: Number(row.unit_price ?? row.unitPrice) || 0,
    lineDiscount: Number(row.line_discount ?? row.lineDiscount) || 0,
    allocatedAmount: numberOrNull(row.allocated_amount ?? row.allocatedAmount),
    note: row.note || "",
    revision: Number(row.revision) || 1
  };
}

export function normalizePayment(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    orderId: row.order_id || row.orderId,
    kind: row.kind || "full",
    amount: Number(row.amount) || 0,
    paidAt: row.paid_at || row.paidAt || "",
    method: row.method || "",
    reference: row.reference || "",
    note: row.note || "",
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function computeOrderTotals(order, payments = []) {
  const payable = Math.max(0, Number(order.totalAmount) + Number(order.shippingFee) - Number(order.discountAmount));
  let grossPaid = 0;
  let refunded = 0;
  for (const p of payments) {
    if (p.deletedAt) continue;
    if (p.kind === "refund") refunded += Number(p.amount) || 0;
    else grossPaid += Number(p.amount) || 0;
  }
  const paid = grossPaid - refunded;
  return {
    payable,
    paid,
    refunded,
    balanceDue: Math.max(0, payable - paid),
    overpaid: Math.max(0, paid - payable)
  };
}

export function allocateOrderItems(items, paid) {
  const active = (items || []).filter((item) => !item.deletedAt);
  const total = active.reduce((sum, item) => {
    if (item.allocatedAmount != null) return sum + Number(item.allocatedAmount);
    return sum + Math.max(0, Number(item.unitPrice) * Number(item.quantity) - Number(item.lineDiscount));
  }, 0);
  if (!total) return active.map((item) => ({ ...item, allocated: 0 }));
  return active.map((item) => {
    if (item.allocatedAmount != null) return { ...item, allocated: Number(item.allocatedAmount) };
    const line = Math.max(0, Number(item.unitPrice) * Number(item.quantity) - Number(item.lineDiscount));
    return { ...item, allocated: Math.round((paid * line / total) * 100) / 100 };
  });
}

/* -------------------------------------------------------------------------- */
/* 成就 / 相册 / 出物 / 价格历史                                               */
/* -------------------------------------------------------------------------- */

export function normalizeAchievement(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    name: row.name || "",
    description: row.description || "",
    category: row.category || "收藏",
    iconPath: row.icon_path || row.iconPath || null,
    badgeType: row.badge_type || row.badgeType || "custom",
    ruleType: row.rule_type || row.ruleType || "manual",
    ruleConfig: row.rule_config || row.ruleConfig || {},
    isActive: bool(row.is_active ?? row.isActive, true),
    sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function normalizeUserAchievement(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    achievementId: row.achievement_id || row.achievementId,
    status: row.status || "locked",
    progress: Number(row.progress) || 0,
    unlockedAt: row.unlocked_at || row.unlockedAt || null,
    awardSource: row.award_source || row.awardSource || "auto",
    note: row.note || "",
    revision: Number(row.revision) || 1
  };
}

export function normalizeItemImage(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    entityType: row.entity_type || row.entityType,
    entityId: row.entity_id || row.entityId,
    kind: row.kind || "photo",
    storagePath: row.storage_path || row.storagePath,
    thumbPath: row.thumb_path || row.thumbPath || null,
    isPrimary: bool(row.is_primary ?? row.isPrimary),
    sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
    caption: row.caption || "",
    mimeType: row.mime_type || row.mimeType || null,
    sizeBytes: numberOrNull(row.size_bytes ?? row.sizeBytes),
    width: numberOrNull(row.width),
    height: numberOrNull(row.height),
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function normalizeSale(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    entityType: row.entity_type || row.entityType,
    entityId: row.entity_id || row.entityId,
    saleStatus: row.sale_status || row.saleStatus || "idle",
    salePrice: numberOrNull(row.sale_price ?? row.salePrice),
    soldAt: row.sold_at || row.soldAt || "",
    buyerNote: row.buyer_note || row.buyerNote || "",
    transactionNote: row.transaction_note || row.transactionNote || "",
    revision: Number(row.revision) || 1,
    deletedAt: row.deleted_at || row.deletedAt || null
  };
}

export function normalizePriceHistory(row = {}) {
  return {
    id: row.id,
    ownerId: row.owner_id || row.ownerId || null,
    entityType: row.entity_type || row.entityType,
    entityId: row.entity_id || row.entityId,
    priceType: row.price_type || row.priceType,
    amount: Number(row.amount) || 0,
    recordedOn: row.recorded_on || row.recordedOn || null,
    source: row.source || "",
    note: row.note || "",
    createdAt: row.created_at || row.createdAt || null
  };
}

export function stripV6Runtime(value) {
  if (Array.isArray(value)) return value.map(stripV6Runtime);
  if (!value || typeof value !== "object") return value;
  const out = runtimeFree(value);
  for (const key of Object.keys(out)) out[key] = stripV6Runtime(out[key]);
  return out;
}
