import {
  BOARD_STORE_PREFIX, ERROR_CODES, LOCAL_STORE_PREFIX,
  STORAGE_BUCKET_DEFAULT, STATE_KEY
} from "./constants.js";
import { uid } from "./utils.js";
import {
  buildDefaultGiftAssignments, defaultBoardCategories, normalizeProduct, sortCategories
} from "./model.js";

const DB_NAME = "xmx-local-images-v5";
const STORE_NAME = "images";
const LOCK = "xmx-local-v5";

function nowIso() {
  return new Date().toISOString();
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function key(name) {
  return `${LOCAL_STORE_PREFIX}.${name}`;
}

function openImageDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(path, blob) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(blob, path);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet(path) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(path);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function idbDelete(path) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(path);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export class LocalBackend {
  constructor(config = {}) {
    this.config = config;
    this.mode = "local";
    this.bucket = config.storageBucket || STORAGE_BUCKET_DEFAULT;
    this.user = { id: "local-user", email: "本地预览模式" };
    this._subscribers = new Set();
    this._objectUrls = new Map();
    this._channel = null;
    this._seeding = null;
  }

  async init() {
    await this._ensureSeeded();
    try {
      this._channel = new BroadcastChannel(LOCK);
      this._channel.onmessage = (event) => {
        if (event.data?.type === "changed") {
          for (const cb of this._subscribers) cb({ table: event.data.table || "local", payload: event.data });
        }
      };
    } catch {
      this._channel = null;
    }
    return this.user;
  }

  async getUser() { return this.user; }
  onAuthChange() { return () => {}; }
  async signIn() { throw new Error("本地预览模式无需登录"); }
  async signUp() { throw new Error("本地预览模式无需注册"); }
  async signOut() { return true; }
  async resendConfirmation() { throw new Error("本地预览模式无需确认邮件"); }
  async resetPassword() { throw new Error("本地预览模式无需重置密码"); }
  async updatePassword() { throw new Error("本地预览模式无需修改密码"); }

  _notify(table) {
    try { this._channel?.postMessage({ type: "changed", table, at: Date.now() }); } catch {}
  }

  subscribe(callback) {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  async _ensureSeeded() {
    if (localStorage.getItem(key("initialized")) === "1") return;
    if (this._seeding) return this._seeding;
    this._seeding = (async () => {
      let baseProducts = [];
      try {
        const res = await fetch("data/gyly/xmx/products.json", { cache: "no-store" });
        if (res.ok) baseProducts = await res.json();
      } catch (e) {
        console.warn("本地预览读取图鉴数据失败", e);
      }
      const now = nowIso();
      const products = baseProducts.map((p) => normalizeProduct({
        ...p,
        marketPrice: null,
        variety: p.categoryLabel || null,
        isUserCreated: false,
        createdAt: p.createdAt || now,
        updatedAt: p.updatedAt || now,
        ownerId: this.user.id,
        _revision: 1
      }));

      // 兼容 V1 旧键里用户手工加过的商品（若存在）
      const legacyProducts = read("xmx-goods-products-v1", []);
      if (Array.isArray(legacyProducts)) {
        const ids = new Set(products.map((p) => p.id));
        for (const old of legacyProducts) {
          if (!old?.id || !old?.name || ids.has(old.id)) continue;
          products.push(normalizeProduct({
            id: String(old.id),
            name: String(old.name),
            category: old.category || "other",
            categoryLabel: old.categoryLabel || old.category || "其他",
            price: old.price ?? null,
            image: old.image || (old.imageUrl ? { src: old.imageUrl } : {}),
            notes: old.notes || old.note || null,
            folder: "旧版本导入",
            isUserCreated: true,
            mainCategoryKey: old.mainCategoryKey || null,
            mainCategory: old.mainCategory || null,
            marketPrice: old.marketPrice ?? null,
            variety: old.variety || old.categoryLabel || null,
            createdAt: now,
            updatedAt: now,
            ownerId: this.user.id,
            _revision: 1
          }));
        }
      }

      const legacyBoards = read(`${BOARD_STORE_PREFIX}.gyly.xmx`, null);
      const categories = [];
      const assignments = [];
      if (legacyBoards?.boards) {
        for (const boardKey of ["collab", "gift"]) {
          const board = legacyBoards.boards[boardKey] || {};
          const list = Array.isArray(board.categories) ? board.categories : [];
          list.forEach((c, index) => {
            if (!c?.id || !c?.name) return;
            categories.push({
              id: String(c.id), name: String(c.name), boardKey, workId: "gyly", characterId: "xmx",
              sortOrder: index + 1, isDefault: String(c.id).startsWith("gift_"), revision: 1,
              createdAt: now, updatedAt: now
            });
          });
          for (const [productId, categoryId] of Object.entries(board.assignments || {})) {
            if (categoryId) assignments.push({ productId, boardKey, categoryId, revision: 1 });
          }
        }
      } else {
        for (const c of defaultBoardCategories().gift) {
          categories.push({ ...c, workId: "gyly", characterId: "xmx" });
        }
        assignments.push(...buildDefaultGiftAssignments(products));
      }

      const state = read(STATE_KEY, { version: 1, owned: {}, wishlist: [] });
      const collections = [];
      for (const [productId, entry] of Object.entries(state.owned || {})) {
        if (!products.some((p) => p.id === productId)) continue;
        collections.push({
          productId,
          quantity: Math.max(1, Number(entry?.quantity) || 1),
          purchasePrice: entry?.price == null ? null : Number(entry.price),
          purchaseDate: entry?.date || "",
          note: entry?.note || "",
          revision: 1,
          createdAt: now,
          updatedAt: now
        });
      }
      const wishlist = (state.wishlist || []).filter((id) => products.some((p) => p.id === id));

      write(key("products"), products);
      write(key("collections"), collections);
      write(key("wishlist"), wishlist);
      write(key("board_categories"), categories);
      write(key("assignments"), assignments);
      write(key("images"), []);
      write(key("settings"), {
        seed: { baseProducts: products.length - (legacyProducts?.length || 0), at: now, source: "V4 本地数据" },
        defaultsInitialized: true
      });
      localStorage.setItem(key("initialized"), "1");
      this._notify("seed");
    })();
    try {
      await this._seeding;
    } finally {
      this._seeding = null;
    }
  }

  async loadSnapshot() {
    await this._ensureSeeded();
    const products = read(key("products"), []).map((p) => normalizeProduct(p));
    const collections = read(key("collections"), []).map((c) => ({
      ...c, productId: c.productId || c.product_id
    }));
    const wishlist = read(key("wishlist"), []);
    const categories = sortCategories(read(key("board_categories"), []).map((c) => ({
      ...c,
      boardKey: c.boardKey || c.board_key,
      sortOrder: c.sortOrder ?? c.sort_order ?? 0,
      revision: c.revision || 1
    })));
    const assignments = read(key("assignments"), []).map((a) => ({
      ...a,
      productId: a.productId || a.product_id,
      boardKey: a.boardKey || a.board_key,
      categoryId: a.categoryId || a.category_id
    }));
    const images = read(key("images"), []).map((i) => ({
      ...i,
      productId: i.productId || i.product_id,
      storagePath: i.storagePath || i.storage_path,
      thumbPath: i.thumbPath || i.thumb_path,
      revision: i.revision || 1
    }));
    const settings = read(key("settings"), {});
    return {
      mode: "local",
      user: this.user,
      profile: { id: this.user.id, email: this.user.email },
      products,
      collections,
      wishlist,
      boardCategories: categories,
      boardAssignments: assignments,
      productImages: images,
      settings,
      settingsRevision: 1,
      mainCategories: [],
      works: [],
      characters: []
    };
  }

  _products() { return read(key("products"), []); }
  _saveProducts(products) { write(key("products"), products); this._notify("products"); }
  _collections() { return read(key("collections"), []); }
  _saveCollections(list) { write(key("collections"), list); this._notify("collections"); }
  _wishlist() { return read(key("wishlist"), []); }
  _saveWishlist(list) { write(key("wishlist"), list); this._notify("wishlist"); }
  _categories() { return read(key("board_categories"), []); }
  _saveCategories(list) { write(key("board_categories"), list); this._notify("board_categories"); }
  _assignments() { return read(key("assignments"), []); }
  _saveAssignments(list) { write(key("assignments"), list); this._notify("board_assignments"); }
  _images() { return read(key("images"), []); }
  _saveImages(list) { write(key("images"), list); this._notify("product_images"); }

  async getProduct(id) {
    const p = this._products().find((x) => x.id === id);
    return p ? normalizeProduct(p) : null;
  }

  async createProduct(product) {
    const products = this._products();
    if (products.some((p) => p.id === product.id)) {
      const e = new Error("商品 ID 已存在"); e.code = ERROR_CODES.DUPLICATE; throw e;
    }
    const row = normalizeProduct({ ...product, ownerId: this.user.id, _revision: 1 });
    products.push(row);
    this._saveProducts(products);
    return row;
  }

  async updateProduct(product, expectedRevision) {
    const products = this._products();
    const index = products.findIndex((p) => p.id === product.id);
    if (index < 0) { const e = new Error("商品已被删除"); e.code = ERROR_CODES.DELETED; throw e; }
    const current = normalizeProduct(products[index]);
    if ((current._revision || 1) !== expectedRevision) {
      const e = new Error("数据已被修改"); e.code = ERROR_CODES.CONFLICT; e.current = current; throw e;
    }
    const next = normalizeProduct({
      ...product, ownerId: this.user.id,
      createdAt: current.createdAt || product.createdAt,
      updatedAt: nowIso(), _revision: (current._revision || 1) + 1
    });
    products[index] = next;
    this._saveProducts(products);
    return next;
  }

  async deleteProduct(id, expectedRevision) {
    const products = this._products();
    const index = products.findIndex((p) => p.id === id);
    if (index < 0) { const e = new Error("商品已被删除"); e.code = ERROR_CODES.DELETED; throw e; }
    const current = products[index];
    if ((current._revision || 1) !== expectedRevision) {
      const e = new Error("数据已被修改"); e.code = ERROR_CODES.CONFLICT; e.current = current; throw e;
    }
    products.splice(index, 1);
    this._saveProducts(products);
    this._saveCollections(this._collections().filter((c) => c.productId !== id));
    this._saveWishlist(this._wishlist().filter((x) => x !== id));
    this._saveAssignments(this._assignments().filter((a) => a.productId !== id));
    const images = this._images().filter((i) => i.productId === id);
    this._saveImages(this._images().filter((i) => i.productId !== id));
    for (const image of images) {
      if (image.storagePath) idbDelete(image.storagePath).catch(() => {});
      if (image.thumbPath) idbDelete(image.thumbPath).catch(() => {});
    }
    return true;
  }

  async getProductAssociations(id) {
    return {
      collection: this._collections().filter((c) => c.productId === id).length,
      wishlist: this._wishlist().filter((x) => x === id).length
    };
  }

  async addCollection(productId, entry = {}) {
    const list = this._collections();
    if (list.some((c) => c.productId === productId)) {
      const e = new Error("已经收藏"); e.code = ERROR_CODES.DUPLICATE; throw e;
    }
    const row = {
      productId,
      quantity: Math.max(1, Number(entry.quantity) || 1),
      purchasePrice: entry.purchasePrice ?? null,
      purchaseDate: entry.purchaseDate || "",
      note: entry.note || "",
      revision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    list.push(row);
    this._saveCollections(list);
    return row;
  }

  async getCollection(productId) {
    return this._collections().find((c) => c.productId === productId) || null;
  }

  async updateCollection(productId, patch, expectedRevision) {
    const list = this._collections();
    const index = list.findIndex((c) => c.productId === productId);
    if (index < 0) { const e = new Error("收藏已被移除"); e.code = ERROR_CODES.DELETED; throw e; }
    const current = list[index];
    if ((current.revision || 1) !== expectedRevision) {
      const e = new Error("收藏信息已被修改"); e.code = ERROR_CODES.CONFLICT; e.current = current; throw e;
    }
    const next = {
      ...current,
      ...patch,
      quantity: Math.max(1, Number(patch.quantity ?? current.quantity) || 1),
      revision: (current.revision || 1) + 1,
      updatedAt: nowIso()
    };
    list[index] = next;
    this._saveCollections(list);
    return next;
  }

  async deleteCollection(productId, expectedRevision) {
    const list = this._collections();
    const current = list.find((c) => c.productId === productId);
    if (current && Number.isInteger(expectedRevision) && (current.revision || 1) !== expectedRevision) {
      const e = new Error("收藏信息已被修改"); e.code = ERROR_CODES.CONFLICT; e.current = current; throw e;
    }
    this._saveCollections(list.filter((c) => c.productId !== productId));
    return true;
  }

  async addWishlist(productId) {
    const list = this._wishlist();
    if (!list.includes(productId)) { list.push(productId); this._saveWishlist(list); }
    return true;
  }

  async deleteWishlist(productId) {
    this._saveWishlist(this._wishlist().filter((x) => x !== productId));
    return true;
  }

  async createBoardCategory(category) {
    const list = this._categories();
    if (list.some((c) => c.id === category.id)) throw new Error("分类 ID 已存在");
    if (list.some((c) => c.boardKey === category.boardKey && c.name === category.name)) {
      const e = new Error("分类名称已存在"); e.code = ERROR_CODES.DUPLICATE; throw e;
    }
    const row = {
      id: category.id, name: category.name, boardKey: category.boardKey,
      workId: category.workId || "gyly", characterId: category.characterId || "xmx",
      sortOrder: category.sortOrder ?? list.filter((c) => c.boardKey === category.boardKey).length + 1,
      isDefault: Boolean(category.isDefault), revision: 1, createdAt: nowIso(), updatedAt: nowIso()
    };
    list.push(row);
    this._saveCategories(list);
    return row;
  }

  async updateBoardCategory(id, patch, expectedRevision) {
    const list = this._categories();
    const index = list.findIndex((c) => c.id === id);
    if (index < 0) { const e = new Error("分类已删除"); e.code = ERROR_CODES.DELETED; throw e; }
    if ((list[index].revision || 1) !== expectedRevision) {
      const e = new Error("分类已被修改"); e.code = ERROR_CODES.CONFLICT; e.current = list[index]; throw e;
    }
    if (patch.name && list.some((c) => c.id !== id && c.boardKey === list[index].boardKey && c.name === patch.name)) {
      const e = new Error("分类名称已存在"); e.code = ERROR_CODES.DUPLICATE; throw e;
    }
    list[index] = { ...list[index], ...patch, revision: (list[index].revision || 1) + 1, updatedAt: nowIso() };
    this._saveCategories(list);
    return list[index];
  }

  async deleteBoardCategory(id, expectedRevision) {
    const list = this._categories();
    const current = list.find((c) => c.id === id);
    if (!current) { const e = new Error("分类已删除"); e.code = ERROR_CODES.DELETED; throw e; }
    if ((current.revision || 1) !== expectedRevision) {
      const e = new Error("分类已被修改"); e.code = ERROR_CODES.CONFLICT; e.current = current; throw e;
    }
    this._saveCategories(list.filter((c) => c.id !== id));
    this._saveAssignments(this._assignments().filter((a) => a.categoryId !== id));
    return true;
  }

  async setBoardAssignment(productId, boardKey, categoryId) {
    const list = this._assignments();
    const index = list.findIndex((a) => a.productId === productId && a.boardKey === boardKey);
    if (!categoryId) {
      if (index >= 0) { list.splice(index, 1); this._saveAssignments(list); }
      return null;
    }
    if (index >= 0) list[index] = { ...list[index], categoryId, revision: (list[index].revision || 1) + 1 };
    else list.push({ productId, boardKey, categoryId, revision: 1 });
    this._saveAssignments(list);
    return list.find((a) => a.productId === productId && a.boardKey === boardKey);
  }

  async saveSettings(settings) {
    const current = read(key("settings"), {});
    const merged = { ...current, ...settings };
    write(key("settings"), merged);
    this._notify("settings");
    return { settings: merged, revision: 1 };
  }

  async mergeSettings(patch) {
    return this.saveSettings({ ...read(key("settings"), {}), ...patch });
  }

  async uploadStorage(path, blob) {
    await idbPut(path, blob);
    return path;
  }

  async removeStorage(paths) {
    for (const path of paths || []) {
      await idbDelete(path).catch(() => {});
      const url = this._objectUrls.get(path);
      if (url) { URL.revokeObjectURL(url); this._objectUrls.delete(path); }
    }
  }

  async signImageUrls(paths) {
    const map = new Map();
    for (const path of [...new Set((paths || []).filter(Boolean))]) {
      if (this._objectUrls.has(path)) { map.set(path, this._objectUrls.get(path)); continue; }
      const blob = await idbGet(path).catch(() => null);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      this._objectUrls.set(path, url);
      map.set(path, url);
    }
    return map;
  }

  async downloadStorage(path) {
    const blob = await idbGet(path);
    if (!blob) throw new Error("本地图片文件不存在");
    return blob;
  }

  async getProductImage(productId, kind) {
    return this._images().find((i) => i.productId === productId && i.kind === kind) || null;
  }

  async saveProductImageRecord(record, existing = null) {
    const list = this._images();
    const index = list.findIndex((i) => i.productId === record.productId && i.kind === record.kind);
    if (index >= 0) {
      if (existing && (list[index].revision || 1) !== existing.revision) {
        const e = new Error("图片已被替换"); e.code = ERROR_CODES.CONFLICT; e.current = list[index]; throw e;
      }
      list[index] = {
        ...list[index], ...record, revision: (list[index].revision || 1) + 1, updatedAt: nowIso()
      };
      this._saveImages(list);
      return list[index];
    }
    const row = {
      id: uid("img_"), ...record, revision: 1, createdAt: nowIso(), updatedAt: nowIso()
    };
    list.push(row);
    this._saveImages(list);
    return row;
  }

  async deleteProductImageRecord(id, expectedRevision) {
    const list = this._images();
    const current = list.find((i) => i.id === id);
    if (!current) { const e = new Error("图片已删除"); e.code = ERROR_CODES.DELETED; throw e; }
    if ((current.revision || 1) !== expectedRevision) {
      const e = new Error("图片已被修改"); e.code = ERROR_CODES.CONFLICT; e.current = current; throw e;
    }
    this._saveImages(list.filter((i) => i.id !== id));
    return current;
  }

  async logBackup() {}

  async insertProducts(products) {
    const list = this._products();
    const ids = new Set(list.map((p) => p.id));
    const now = nowIso();
    let count = 0;
    for (const p of products) {
      if (ids.has(p.id)) continue;
      list.push(normalizeProduct({ ...p, ownerId: this.user.id, createdAt: p.createdAt || now, updatedAt: p.updatedAt || now, _revision: 1 }));
      ids.add(p.id);
      count += 1;
    }
    this._saveProducts(list);
    return count;
  }

  async insertCollections(entries) {
    const list = this._collections();
    const ids = new Set(list.map((c) => c.productId));
    let count = 0;
    for (const entry of entries) {
      if (ids.has(entry.productId)) continue;
      list.push({ ...entry, revision: 1, createdAt: nowIso(), updatedAt: nowIso() });
      ids.add(entry.productId);
      count += 1;
    }
    this._saveCollections(list);
    return count;
  }

  async insertWishlist(ids) {
    const list = this._wishlist();
    const set = new Set(list);
    let count = 0;
    for (const id of ids) if (!set.has(id)) { list.push(id); set.add(id); count += 1; }
    this._saveWishlist(list);
    return count;
  }

  async insertBoardCategories(categories) {
    const list = this._categories();
    let count = 0;
    for (const c of categories) {
      if (list.some((x) => x.id === c.id)) continue;
      if (list.some((x) => x.boardKey === c.boardKey && x.name === c.name)) continue;
      list.push({ ...c, revision: 1, createdAt: nowIso(), updatedAt: nowIso() });
      count += 1;
    }
    this._saveCategories(list);
    return count;
  }

  async insertBoardAssignments(assignments) {
    const list = this._assignments();
    let count = 0;
    for (const a of assignments) {
      if (list.some((x) => x.productId === a.productId && x.boardKey === a.boardKey)) continue;
      list.push({ ...a, revision: 1 });
      count += 1;
    }
    this._saveAssignments(list);
    return count;
  }

  async upsertRestoreProducts(products, overwrite = false) {
    const list = this._products();
    const map = new Map(list.map((p, i) => [p.id, i]));
    let count = 0;
    for (const p of products) {
      if (map.has(p.id)) {
        if (!overwrite) continue;
        list[map.get(p.id)] = normalizeProduct({ ...p, ownerId: this.user.id, _revision: (list[map.get(p.id)]._revision || 1) + 1 });
      } else {
        list.push(normalizeProduct({ ...p, ownerId: this.user.id, _revision: 1 }));
        map.set(p.id, list.length - 1);
      }
      count += 1;
    }
    this._saveProducts(list);
    return count;
  }

  async upsertRestoreCollections(entries, overwrite = false) {
    const list = this._collections();
    const map = new Map(list.map((c, i) => [c.productId, i]));
    let count = 0;
    for (const entry of entries) {
      if (map.has(entry.productId)) {
        if (!overwrite) continue;
        list[map.get(entry.productId)] = { ...entry, revision: (list[map.get(entry.productId)].revision || 1) + 1, updatedAt: nowIso() };
      } else {
        list.push({ ...entry, revision: 1, createdAt: nowIso(), updatedAt: nowIso() });
        map.set(entry.productId, list.length - 1);
      }
      count += 1;
    }
    this._saveCollections(list);
    return count;
  }

  async upsertRestoreWishlist(ids, overwrite = false) {
    return this.insertWishlist(ids);
  }

  async upsertRestoreCategories(categories) {
    return this.insertBoardCategories(categories);
  }

  async upsertRestoreAssignments(assignments) {
    return this.insertBoardAssignments(assignments);
  }
}
