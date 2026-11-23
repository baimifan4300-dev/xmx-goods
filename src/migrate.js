import {
  BOARD_STORE_PREFIX, DEFAULT_GIFT_CATEGORIES, LEGACY_PRODUCTS_KEY,
  MIGRATION_MARK_PREFIX, STATE_KEY
} from "./constants.js";
import { chunk, normalizeDate } from "./utils.js";
import {
  buildDefaultGiftAssignments, normalizeProduct
} from "./model.js";

function parse(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function readLegacyLocalData() {
  const state = parse(STATE_KEY, null);
  const boards = parse(`${BOARD_STORE_PREFIX}.gyly.xmx`, null);
  const customProducts = parse(LEGACY_PRODUCTS_KEY, []);
  const owned = state?.owned && typeof state.owned === "object" ? state.owned : {};
  const wishlist = Array.isArray(state?.wishlist) ? state.wishlist : [];
  const categories = [];
  const assignments = [];
  if (boards?.boards) {
    for (const boardKey of ["collab", "gift"]) {
      const board = boards.boards[boardKey] || {};
      (board.categories || []).forEach((c, index) => {
        if (!c?.id || !c?.name) return;
        categories.push({
          id: String(c.id),
          name: String(c.name).slice(0, 20),
          boardKey,
          workId: "gyly",
          characterId: "xmx",
          sortOrder: index + 1,
          isDefault: String(c.id).startsWith("gift_")
        });
      });
      for (const [productId, categoryId] of Object.entries(board.assignments || {})) {
        if (categoryId) assignments.push({ productId, boardKey, categoryId });
      }
    }
  }
  return {
    state,
    boards,
    customProducts: Array.isArray(customProducts) ? customProducts : [],
    owned,
    wishlist,
    categories,
    assignments,
    hasState: Boolean(state),
    hasBoards: Boolean(boards?.boards),
    hasAny: Boolean(state) || Boolean(boards?.boards) || (Array.isArray(customProducts) && customProducts.length > 0)
  };
}

export function legacySummary(legacy, baseCount) {
  return {
    baseProducts: baseCount,
    owned: Object.keys(legacy.owned || {}).length,
    wishlist: (legacy.wishlist || []).length,
    categories: (legacy.categories || []).length,
    assignments: (legacy.assignments || []).length,
    customProducts: (legacy.customProducts || []).length,
    hasBoards: Boolean(legacy.hasBoards),
    hasState: Boolean(legacy.hasState)
  };
}

function normalizeLegacyCustomProduct(raw, now) {
  return normalizeProduct({
    id: String(raw.id),
    name: String(raw.name || "未命名商品"),
    category: raw.category || "other",
    categoryLabel: raw.categoryLabel || raw.category || "其他",
    series: raw.series ?? null,
    workId: raw.workId || "gyly",
    characterId: raw.characterId || "xmx",
    version: raw.version ?? null,
    price: raw.price ?? null,
    priceText: raw.priceText ?? raw.price_text ?? null,
    releaseDate: raw.releaseDate ?? raw.release_date ?? null,
    productCode: raw.productCode ?? raw.product_code ?? null,
    image: typeof raw.image === "string" ? { src: raw.image } : (raw.image || {}),
    folder: raw.folder || "旧版本导入",
    verificationStatus: raw.verificationStatus || "verified",
    duplicateGroup: raw.duplicateGroup ?? null,
    notes: raw.notes || raw.note || null,
    mainCategory: raw.mainCategory || null,
    mainCategoryKey: raw.mainCategoryKey || null,
    board: raw.board || null,
    boardKey: raw.boardKey || null,
    classificationStatus: raw.classificationStatus || "已确认",
    classificationBasis: raw.classificationBasis || "旧版本本地商品迁移",
    classificationConfidence: raw.classificationConfidence || "中",
    variety: raw.variety || raw.categoryLabel || null,
    marketPrice: raw.marketPrice ?? null,
    isUserCreated: true,
    createdAt: raw.createdAt || now,
    updatedAt: now
  });
}

export function migrationMarkKey(userId) {
  return `${MIGRATION_MARK_PREFIX}.${userId}`;
}

export function isLocalMigrationDone(userId) {
  return localStorage.getItem(migrationMarkKey(userId)) === "1";
}

export function markLocalMigrationDone(userId) {
  localStorage.setItem(migrationMarkKey(userId), "1");
}

/**
 * 把 V4 本地数据 + 内置 1537 条图鉴迁移到云端。
 * @param {object} backend SupabaseBackend
 * @param {object} options {snapshot, baseProducts, legacy, mode:'auto'|'merge'}
 */
export async function migrateToCloud(backend, { snapshot, baseProducts, legacy, onProgress = () => {} }) {
  const uid = backend.user?.id;
  if (!uid) throw new Error("请先登录后再迁移。");
  const isInitial = (snapshot.products?.length || 0) === 0;
  const now = new Date().toISOString();
  const report = {
    initial: isInitial,
    products: 0,
    customProducts: 0,
    collections: 0,
    wishlist: 0,
    categories: 0,
    assignments: 0,
    warnings: []
  };

  const custom = (legacy.customProducts || []).filter((p) => p?.id && p?.name && !String(p.id).startsWith("B"));
  const customNormalized = custom.map((p) => normalizeLegacyCustomProduct(p, now));
  const base = isInitial ? (baseProducts || []) : [];
  const productsToInsert = [
    ...base.map((p) => normalizeProduct({
      ...p,
      marketPrice: p.marketPrice ?? null,
      variety: p.variety || p.categoryLabel || null,
      isUserCreated: false,
      createdAt: p.createdAt || now,
      updatedAt: p.updatedAt || now
    })),
    ...customNormalized
  ];

  if (productsToInsert.length) {
    const groups = chunk(productsToInsert, 200);
    let done = 0;
    for (const group of groups) {
      onProgress({
        phase: "products", message: `正在导入商品 ${done + group.length}/${productsToInsert.length}`,
        current: done, total: productsToInsert.length
      });
      await backend.insertProducts(group);
      done += group.length;
    }
    report.products = base.length;
    report.customProducts = customNormalized.length;
  }

  // 分类
  const existingCategories = snapshot.boardCategories || [];
  let categoriesToInsert = [];
  if (legacy.hasBoards) {
    categoriesToInsert = legacy.categories || [];
  } else if (!existingCategories.length) {
    categoriesToInsert = DEFAULT_GIFT_CATEGORIES.map((c, i) => ({
      id: c.id, name: c.name, boardKey: "gift", workId: "gyly", characterId: "xmx",
      sortOrder: i + 1, isDefault: true
    }));
  }
  if (categoriesToInsert.length) {
    onProgress({ phase: "categories", message: "正在迁移联动/满赠分类…", current: 0, total: categoriesToInsert.length });
    report.categories = await backend.insertBoardCategories(categoriesToInsert);
  }

  // 某些分类可能因同名冲突被跳过；以云端实际存在的分类为准过滤归属，避免外键失败。
  const afterCategories = (await backend.loadSnapshot()).boardCategories || [];
  const validCategoryIds = new Set(afterCategories.map((c) => c.id));
  const categoryNameToId = new Map(afterCategories.map((c) => [`${c.boardKey}|${c.name}`, c.id]));
  const localCategoryName = new Map((legacy.categories || []).map((c) => [c.id, c]));
  let assignments = legacy.hasBoards ? (legacy.assignments || []) : [];
  if (!legacy.hasBoards && !snapshot.boardAssignments?.length) {
    assignments = buildDefaultGiftAssignments(productsToInsert.filter((p) => p.boardKey === "gift"));
  }
  assignments = assignments
    .map((a) => {
      if (validCategoryIds.has(a.categoryId)) return a;
      const localCat = localCategoryName.get(a.categoryId);
      const mapped = localCat ? categoryNameToId.get(`${localCat.boardKey}|${localCat.name}`) : null;
      return mapped ? { ...a, categoryId: mapped } : null;
    })
    .filter(Boolean);
  const validProductIds = new Set([
    ...(snapshot.products || []).map((p) => p.id),
    ...productsToInsert.map((p) => p.id)
  ]);
  assignments = assignments.filter((a) => validProductIds.has(a.productId));
  if (assignments.length) {
    onProgress({ phase: "assignments", message: "正在迁移商品分类归属…", current: 0, total: assignments.length });
    report.assignments = await backend.insertBoardAssignments(assignments);
  }

  // 收藏
  const ownedEntries = Object.entries(legacy.owned || {}).filter(([productId]) => validProductIds.has(productId));
  if (ownedEntries.length) {
    onProgress({ phase: "collections", message: `正在迁移收藏 ${ownedEntries.length} 条…`, current: 0, total: ownedEntries.length });
    const rows = ownedEntries.map(([productId, entry]) => ({
      productId,
      quantity: Math.max(1, Number(entry?.quantity) || 1),
      purchasePrice: entry?.price == null ? null : Number(entry.price),
      purchaseDate: normalizeDate(entry?.date) || "",
      note: entry?.note || ""
    }));
    report.collections = await backend.insertCollections(rows);
  }

  const wishlist = (legacy.wishlist || []).map(String).filter((id) => validProductIds.has(id));
  if (wishlist.length) {
    onProgress({ phase: "wishlist", message: `正在迁移愿望清单 ${wishlist.length} 条…`, current: 0, total: wishlist.length });
    report.wishlist = await backend.insertWishlist(wishlist);
  }

  const counts = {
    products: report.products,
    customProducts: report.customProducts,
    collections: report.collections,
    wishlist: report.wishlist,
    categories: report.categories,
    assignments: report.assignments
  };
  await backend.mergeSettings({
    defaultsInitialized: true,
    migration: {
      version: 1,
      initial: isInitial,
      source: legacy.hasAny ? "local-v4" : "base-catalog",
      migratedAt: now,
      counts
    }
  });
  markLocalMigrationDone(uid);
  return report;
}

export function shouldOfferLocalMerge(snapshot, legacy, userId) {
  if (!legacy?.hasAny) return false;
  if (isLocalMigrationDone(userId)) return false;
  if (!(snapshot.products?.length)) return false;
  return true;
}
