import {
  BOARD_LABELS, DEFAULT_GIFT_CATEGORIES, defaultCategoryLabel
} from "./constants.js";

export const PRODUCT_COLUMN_FIELDS = [
  "name", "category", "category_label", "series", "work_id", "character_id",
  "version", "price", "price_text", "release_date", "product_code", "folder",
  "verification_status", "duplicate_group", "notes", "main_category",
  "main_category_key", "board", "board_key", "classification_status",
  "classification_basis", "classification_confidence",
  "classification_section_title", "classification_row", "variety", "market_price"
];

const DERIVED_KEYS = new Set([
  "_images", "_imageUrl", "_thumbUrl", "_highResUrl", "_coverUrl",
  "_signed", "_local", "_uploading"
]);

export function cloneJson(value) {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

export function normalizeProduct(raw = {}) {
  const p = { ...raw };
  for (const key of DERIVED_KEYS) delete p[key];
  p.id = String(p.id || "").trim();
  p.name = String(p.name || "").trim();
  p.category = p.category ?? null;
  p.categoryLabel = p.categoryLabel ?? p.category_label ?? null;
  p.series = p.series ?? null;
  p.workId = p.workId || "gyly";
  p.characterId = p.characterId || "xmx";
  p.version = p.version ?? null;
  p.price = p.price === "" || p.price === undefined || p.price === null
    ? null
    : (Number.isFinite(Number(p.price)) ? Number(p.price) : null);
  p.priceText = p.priceText ?? null;
  p.releaseDate = p.releaseDate ?? null;
  p.productCode = p.productCode ?? null;
  p.image = p.image && typeof p.image === "object" ? cloneJson(p.image) : {};
  p.folder = p.folder ?? null;
  p.verificationStatus = p.verificationStatus ?? null;
  p.duplicateGroup = p.duplicateGroup ?? null;
  p.notes = p.notes ?? null;
  p.mainCategory = p.mainCategory ?? null;
  p.mainCategoryKey = p.mainCategoryKey ?? null;
  p.board = p.board ?? null;
  p.boardKey = p.boardKey ?? null;
  p.classificationStatus = p.classificationStatus ?? null;
  p.classificationBasis = p.classificationBasis ?? null;
  p.classificationConfidence = p.classificationConfidence ?? null;
  p.classificationSectionTitle = p.classificationSectionTitle ?? null;
  p.classificationRow = p.classificationRow ?? null;
  p.variety = p.variety ?? p.categoryLabel ?? null;
  p.marketPrice = p.marketPrice === "" || p.marketPrice === undefined || p.marketPrice === null
    ? null
    : (Number.isFinite(Number(p.marketPrice)) ? Number(p.marketPrice) : null);
  p.marketPriceDate = p.marketPriceDate ?? p.market_price_date ?? null;
  p.seriesId = p.seriesId ?? p.series_id ?? null;
  p.deletedAt = p.deletedAt ?? p.deleted_at ?? null;
  p.isUserCreated = Boolean(p.isUserCreated);
  p.createdAt = p.createdAt || null;
  p.updatedAt = p.updatedAt || null;
  p.ownerId = p.ownerId || null;
  if (p._revision !== undefined) p._revision = Number(p._revision) || 1;
  return p;
}

export function rowToProduct(row) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const p = {
    ...payload,
    id: row.id,
    name: row.name,
    category: row.category,
    categoryLabel: row.category_label,
    series: row.series,
    workId: row.work_id,
    characterId: row.character_id,
    version: row.version,
    price: row.price,
    priceText: row.price_text,
    releaseDate: row.release_date,
    productCode: row.product_code,
    image: row.image || payload.image || {},
    folder: row.folder,
    verificationStatus: row.verification_status,
    duplicateGroup: row.duplicate_group,
    notes: row.notes,
    mainCategory: row.main_category,
    mainCategoryKey: row.main_category_key,
    board: row.board,
    boardKey: row.board_key,
    classificationStatus: row.classification_status,
    classificationBasis: row.classification_basis,
    classificationConfidence: row.classification_confidence,
    classificationSectionTitle: row.classification_section_title,
    classificationRow: row.classification_row,
    variety: row.variety,
    marketPrice: row.market_price,
    marketPriceDate: row.market_price_date || null,
    seriesId: row.series_id || null,
    deletedAt: row.deleted_at || null,
    isUserCreated: row.is_user_created,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerId: row.owner_id,
    _revision: Number(row.revision) || 1
  };
  return normalizeProduct(p);
}

export function productToRow(product, ownerId, { includeRevision = false } = {}) {
  const p = normalizeProduct(product);
  const now = new Date().toISOString();
  p.ownerId = ownerId || p.ownerId;
  p.updatedAt = p.updatedAt || now;
  if (!p.createdAt) p.createdAt = now;
  const payload = cloneJson(p);
  delete payload._revision;
  const row = {
    owner_id: ownerId,
    id: p.id,
    name: p.name,
    category: p.category,
    category_label: p.categoryLabel,
    series: p.series,
    work_id: p.workId,
    character_id: p.characterId,
    version: p.version,
    price: p.price,
    price_text: p.priceText,
    release_date: p.releaseDate,
    product_code: p.productCode,
    image: p.image || {},
    folder: p.folder,
    verification_status: p.verificationStatus,
    duplicate_group: p.duplicateGroup,
    notes: p.notes,
    main_category: p.mainCategory,
    main_category_key: p.mainCategoryKey,
    board: p.board,
    board_key: p.boardKey,
    classification_status: p.classificationStatus,
    classification_basis: p.classificationBasis,
    classification_confidence: p.classificationConfidence,
    classification_section_title: p.classificationSectionTitle,
    classification_row: p.classificationRow,
    variety: p.variety,
    market_price: p.marketPrice,
    payload,
    is_user_created: p.isUserCreated
  };
  if (p.marketPriceDate !== undefined && p.marketPriceDate !== null) row.market_price_date = p.marketPriceDate;
  if (p.seriesId !== undefined && p.seriesId !== null) row.series_id = p.seriesId;
  if (includeRevision && p._revision !== undefined) row.revision = p._revision;
  return row;
}

export function makeNewProduct({ id, name, workId = "gyly", characterId = "xmx", mainCategoryKey = null }) {
  const label = mainCategoryKey ? defaultCategoryLabel(mainCategoryKey) : null;
  const now = new Date().toISOString();
  return normalizeProduct({
    id,
    name,
    category: mainCategoryKey || "other",
    categoryLabel: label || "其他",
    series: null,
    workId,
    characterId,
    version: null,
    price: null,
    priceText: null,
    releaseDate: null,
    productCode: null,
    image: {},
    folder: "站内新增",
    verificationStatus: "verified",
    duplicateGroup: null,
    notes: null,
    mainCategory: label,
    mainCategoryKey: mainCategoryKey || null,
    board: null,
    boardKey: null,
    classificationStatus: "已确认",
    classificationBasis: "用户站内新增",
    classificationConfidence: "高",
    classificationSectionTitle: null,
    classificationRow: null,
    variety: label || null,
    marketPrice: null,
    isUserCreated: true,
    createdAt: now,
    updatedAt: now
  });
}

export function applyCategoryToProduct(product, mainCategoryKey) {
  const p = { ...product };
  if (mainCategoryKey) {
    p.mainCategoryKey = mainCategoryKey;
    p.mainCategory = defaultCategoryLabel(mainCategoryKey);
    p.category = mainCategoryKey;
    p.categoryLabel = defaultCategoryLabel(mainCategoryKey);
    if (!p.variety) p.variety = p.mainCategory;
  } else {
    p.mainCategoryKey = null;
    p.mainCategory = null;
    p.category = p.boardKey ? (p.category || "other") : "other";
    p.categoryLabel = p.boardKey ? (p.categoryLabel || "其他") : "其他";
  }
  return p;
}

export function applyBoardToProduct(product, boardKey) {
  const p = { ...product, boardKey: boardKey || null, board: boardKey ? BOARD_LABELS[boardKey] : null };
  if (!boardKey && !p.mainCategoryKey) {
    p.category = "other";
    p.categoryLabel = "其他";
  }
  return p;
}

export function rowToCollection(row) {
  return {
    productId: row.product_id,
    quantity: Math.max(1, Number(row.quantity) || 1),
    purchasePrice: row.purchase_price === null ? null : Number(row.purchase_price),
    purchaseDate: row.purchase_date || "",
    note: row.note || "",
    statusId: row.status_id || "owned",
    targetPrice: row.target_price === null || row.target_price === undefined ? null : Number(row.target_price),
    purchaseUrl: row.purchase_url || "",
    storeName: row.store_name || "",
    expectedArrivalDate: row.expected_arrival_date || "",
    wishlistNote: row.wishlist_note || "",
    locationId: row.location_id || null,
    receivedAt: row.received_at || "",
    deletedAt: row.deleted_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision) || 1
  };
}

export function collectionToRow(entry, ownerId) {
  const row = {
    owner_id: ownerId,
    product_id: entry.productId,
    quantity: Math.max(1, Number(entry.quantity) || 1),
    purchase_price: entry.purchasePrice === null || entry.purchasePrice === undefined || entry.purchasePrice === ""
      ? null : Number(entry.purchasePrice),
    purchase_date: entry.purchaseDate || null,
    note: entry.note || null
  };
  if (entry.statusId !== undefined) row.status_id = entry.statusId || "owned";
  if (entry.targetPrice !== undefined) row.target_price = entry.targetPrice === "" || entry.targetPrice === null ? null : Number(entry.targetPrice);
  if (entry.purchaseUrl !== undefined) row.purchase_url = entry.purchaseUrl || null;
  if (entry.storeName !== undefined) row.store_name = entry.storeName || null;
  if (entry.expectedArrivalDate !== undefined) row.expected_arrival_date = entry.expectedArrivalDate || null;
  if (entry.wishlistNote !== undefined) row.wishlist_note = entry.wishlistNote || null;
  if (entry.locationId !== undefined) row.location_id = entry.locationId || null;
  if (entry.receivedAt !== undefined) row.received_at = entry.receivedAt || null;
  return row;
}

export function rowToBoardCategory(row) {
  return {
    id: row.id,
    name: row.name,
    boardKey: row.board_key,
    workId: row.work_id,
    characterId: row.character_id,
    sortOrder: Number(row.sort_order) || 0,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision) || 1
  };
}

export function rowToImage(row) {
  return {
    id: row.id,
    productId: row.product_id,
    kind: row.kind,
    storagePath: row.storage_path,
    thumbPath: row.thumb_path || null,
    fileName: row.file_name || null,
    mimeType: row.mime_type || null,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision) || 1,
    url: null,
    thumbUrl: null
  };
}

export function defaultGiftCategoryFor(product) {
  if (product.category === "badge") return "gift_badge";
  if (product.category === "card") return "gift_paper";
  if (product.category === "keychain" || product.category === "standee") return "gift_acrylic";
  return "gift_other";
}

export function defaultBoardCategories() {
  return {
    collab: [],
    gift: DEFAULT_GIFT_CATEGORIES.map((c, index) => ({
      id: c.id,
      name: c.name,
      boardKey: "gift",
      sortOrder: index + 1,
      isDefault: true,
      revision: 1
    }))
  };
}

export function buildDefaultGiftAssignments(products) {
  const out = [];
  for (const product of products) {
    if (product.boardKey !== "gift") continue;
    out.push({
      productId: product.id,
      boardKey: "gift",
      categoryId: defaultGiftCategoryFor(product)
    });
  }
  return out;
}

export function categoryNameMap(categories) {
  const map = new Map();
  for (const c of categories || []) map.set(c.id, c.name);
  return map;
}

export function sortCategories(categories) {
  return [...(categories || [])].sort((a, b) => (a.sortOrder - b.sortOrder) || String(a.id).localeCompare(String(b.id)));
}
