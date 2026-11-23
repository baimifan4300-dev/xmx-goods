import { createClient } from "@supabase/supabase-js";
import {
  CLOUD_BATCH_SIZE, ERROR_CODES, STORAGE_BUCKET_DEFAULT
} from "./constants.js";
import {
  normalizeError, chunk
} from "./utils.js";
import {
  collectionToRow, productToRow, rowToBoardCategory, rowToCollection,
  rowToImage, rowToProduct
} from "./model.js";

export class CloudError extends Error {
  constructor(message, code = "XMX_ERROR", extra = {}) {
    super(message);
    this.name = "CloudError";
    this.code = code;
    this.userMessage = message;
    Object.assign(this, extra);
  }
}

export function conflictError(current, message = "云端数据已被其他设备修改。") {
  return new CloudError(message, ERROR_CODES.CONFLICT, { current });
}

export function deletedError(message = "这条数据已在其他设备被删除。") {
  return new CloudError(message, ERROR_CODES.DELETED);
}

function dbError(error, context = "") {
  const e = normalizeError(error);
  if (context) e.context = context;
  return e;
}

export class SupabaseBackend {
  constructor(config) {
    this.config = config;
    this.mode = "cloud";
    this.bucket = config.storageBucket || STORAGE_BUCKET_DEFAULT;
    this.client = null;
    this.user = null;
    this._realtime = null;
    this._signedCache = new Map();
  }

  async init() {
    this.client = createClient(this.config.supabaseUrl.replace(/\/$/, ""), this.config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
        storageKey: "xmx.auth.v5"
      },
      global: { headers: { "x-application-name": "xmx-goods-v5" } }
    });
    const { data, error } = await this.client.auth.getSession();
    if (error) throw dbError(error, "getSession");
    this.user = data.session?.user || null;
    return this.user;
  }

  async getUser() {
    const { data } = await this.client.auth.getUser();
    return data?.user || null;
  }

  onAuthChange(callback) {
    const { data } = this.client.auth.onAuthStateChange((event, session) => {
      this.user = session?.user || null;
      callback(event, this.user);
    });
    return () => data?.subscription?.unsubscribe?.();
  }

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw dbError(error, "signIn");
    this.user = data.user;
    return data;
  }

  async signUp(email, password) {
    const redirect = `${location.origin}${location.pathname}`;
    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: redirect }
    });
    if (error) throw dbError(error, "signUp");
    this.user = data.user || null;
    return { ...data, needsEmailConfirm: !data.session };
  }

  async signOut() {
    const { error } = await this.client.auth.signOut();
    if (error) throw dbError(error, "signOut");
    this.user = null;
  }

  async resetPassword(email) {
    const { error } = await this.client.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}${location.pathname}`
    });
    if (error) throw dbError(error, "resetPassword");
  }

  async resendConfirmation(email) {
    const { error } = await this.client.auth.resend({ type: "signup", email });
    if (error) throw dbError(error, "resendConfirmation");
  }

  async updatePassword(password) {
    const { error } = await this.client.auth.updateUser({ password });
    if (error) throw dbError(error, "updatePassword");
  }

  _assertUser() {
    if (!this.user) throw new CloudError("请先登录后再操作。", ERROR_CODES.AUTH);
    return this.user;
  }

  async _selectAll(table, configure, pageSize = 1000) {
    const rows = [];
    let from = 0;
    for (;;) {
      let query = this.client.from(table).select("*").range(from, from + pageSize - 1);
      if (configure) query = configure(query);
      const { data, error } = await query;
      if (error) throw dbError(error, `select:${table}`);
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
    return rows;
  }

  async _ensureSettings() {
    const uid = this._assertUser().id;
    const { data, error } = await this.client.from("user_settings").select("*").eq("owner_id", uid).maybeSingle();
    if (error) throw dbError(error, "settings:select");
    if (data) return data;
    const { data: inserted, error: insertError } = await this.client.from("user_settings")
      .insert({ owner_id: uid, settings: {} }).select("*").maybeSingle();
    if (insertError && !/duplicate|23505/i.test(insertError.message)) throw dbError(insertError, "settings:insert");
    if (inserted) return inserted;
    const retry = await this.client.from("user_settings").select("*").eq("owner_id", uid).maybeSingle();
    if (retry.error) throw dbError(retry.error, "settings:retry");
    return retry.data;
  }

  async loadSnapshot() {
    const uid = this._assertUser().id;
    const [products, collections, wishlist, boardCategories, boardAssignments, productImages, settingsRow, profileRows, mainCategories, works, characters] = await Promise.all([
      this._selectAll("products", (q) => q.eq("owner_id", uid).order("id", { ascending: true })),
      this._selectAll("collections", (q) => q.eq("owner_id", uid).order("product_id")),
      this._selectAll("wishlist", (q) => q.eq("owner_id", uid).order("product_id")),
      this._selectAll("board_categories", (q) => q.eq("owner_id", uid).order("board_key").order("sort_order")),
      this._selectAll("board_assignments", (q) => q.eq("owner_id", uid)),
      this._selectAll("product_images", (q) => q.eq("owner_id", uid).order("created_at")),
      this._ensureSettings(),
      this._selectAll("profiles", (q) => q.eq("id", uid)),
      this._selectAll("main_categories", (q) => q.order("sort_order")),
      this._selectAll("works", (q) => q.order("sort_order")),
      this._selectAll("characters", (q) => q.order("sort_order"))
    ]);
    return {
      mode: "cloud",
      user: this.user,
      profile: profileRows[0] || null,
      products: products.map(rowToProduct),
      collections: collections.map(rowToCollection),
      wishlist: wishlist.map((r) => r.product_id),
      boardCategories: boardCategories.map(rowToBoardCategory),
      boardAssignments: boardAssignments.map((r) => ({
        productId: r.product_id,
        boardKey: r.board_key,
        categoryId: r.category_id,
        revision: Number(r.revision) || 1
      })),
      productImages: productImages.map(rowToImage),
      settings: settingsRow?.settings || {},
      settingsRevision: Number(settingsRow?.revision) || 1,
      mainCategories,
      works,
      characters
    };
  }

  async getProduct(id) {
    const uid = this._assertUser().id;
    const { data, error } = await this.client.from("products").select("*").eq("owner_id", uid).eq("id", id).maybeSingle();
    if (error) throw dbError(error, "product:get");
    return data ? rowToProduct(data) : null;
  }

  async createProduct(product) {
    const uid = this._assertUser().id;
    const row = productToRow({ ...product, ownerId: uid }, uid);
    const { data, error } = await this.client.from("products").insert(row).select("*").single();
    if (error) throw dbError(error, "product:create");
    return rowToProduct(data);
  }

  async updateProduct(product, expectedRevision) {
    const uid = this._assertUser().id;
    const row = productToRow({ ...product, ownerId: uid }, uid);
    delete row.owner_id;
    const { data, error } = await this.client.from("products").update(row)
      .eq("owner_id", uid).eq("id", product.id).eq("revision", expectedRevision)
      .select("*").maybeSingle();
    if (error) throw dbError(error, "product:update");
    if (data) return rowToProduct(data);
    const current = await this.getProduct(product.id);
    if (!current) throw deletedError("这件商品已在其他设备被删除，无法保存修改。");
    throw conflictError(current);
  }

  async deleteProduct(id, expectedRevision) {
    const uid = this._assertUser().id;
    const { data, error } = await this.client.from("products").delete()
      .eq("owner_id", uid).eq("id", id).eq("revision", expectedRevision)
      .select("id").maybeSingle();
    if (error) throw dbError(error, "product:delete");
    if (!data) {
      const current = await this.getProduct(id);
      if (!current) throw deletedError("这件商品已经在其他设备被删除。");
      throw conflictError(current, "这件商品刚被其他设备修改，请确认后再删除。");
    }
    return true;
  }

  async getProductAssociations(id) {
    const uid = this._assertUser().id;
    const [collection, wishlist] = await Promise.all([
      this.client.from("collections").select("product_id", { count: "exact", head: true }).eq("owner_id", uid).eq("product_id", id),
      this.client.from("wishlist").select("product_id", { count: "exact", head: true }).eq("owner_id", uid).eq("product_id", id)
    ]);
    return {
      collection: collection.count || 0,
      wishlist: wishlist.count || 0
    };
  }

  async addCollection(productId, entry = {}) {
    const uid = this._assertUser().id;
    const row = collectionToRow({ productId, quantity: entry.quantity || 1, ...entry }, uid);
    const { data, error } = await this.client.from("collections").insert(row).select("*").single();
    if (error) throw dbError(error, "collection:add");
    return rowToCollection(data);
  }

  async getCollection(productId) {
    const uid = this._assertUser().id;
    const { data, error } = await this.client.from("collections").select("*")
      .eq("owner_id", uid).eq("product_id", productId).maybeSingle();
    if (error) throw dbError(error, "collection:get");
    return data ? rowToCollection(data) : null;
  }

  async updateCollection(productId, patch, expectedRevision) {
    const uid = this._assertUser().id;
    const row = collectionToRow({ productId, ...patch }, uid);
    delete row.owner_id;
    delete row.product_id;
    const { data, error } = await this.client.from("collections").update(row)
      .eq("owner_id", uid).eq("product_id", productId).eq("revision", expectedRevision)
      .select("*").maybeSingle();
    if (error) throw dbError(error, "collection:update");
    if (data) return rowToCollection(data);
    const current = await this.getCollection(productId);
    if (!current) throw deletedError("这条收藏已在其他设备被移除。");
    throw conflictError(current);
  }

  async deleteCollection(productId, expectedRevision) {
    const uid = this._assertUser().id;
    let query = this.client.from("collections").delete().eq("owner_id", uid).eq("product_id", productId);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("product_id").maybeSingle();
    if (error) throw dbError(error, "collection:delete");
    if (!data && Number.isInteger(expectedRevision)) {
      const current = await this.getCollection(productId);
      if (current) throw conflictError(current, "收藏信息刚被其他设备修改，请确认后再移除。");
    }
    return true;
  }

  async addWishlist(productId) {
    const uid = this._assertUser().id;
    const { error } = await this.client.from("wishlist").insert({ owner_id: uid, product_id: productId });
    if (error && !/duplicate|23505/i.test(error.message)) throw dbError(error, "wishlist:add");
    return true;
  }

  async deleteWishlist(productId) {
    const uid = this._assertUser().id;
    const { error } = await this.client.from("wishlist").delete().eq("owner_id", uid).eq("product_id", productId);
    if (error) throw dbError(error, "wishlist:delete");
    return true;
  }

  async createBoardCategory(category) {
    const uid = this._assertUser().id;
    const { data, error } = await this.client.from("board_categories").insert({
      owner_id: uid,
      id: category.id,
      work_id: category.workId || "gyly",
      character_id: category.characterId || "xmx",
      board_key: category.boardKey,
      name: category.name,
      sort_order: category.sortOrder ?? 0,
      is_default: Boolean(category.isDefault)
    }).select("*").single();
    if (error) throw dbError(error, "board_category:create");
    return rowToBoardCategory(data);
  }

  async updateBoardCategory(id, patch, expectedRevision) {
    const uid = this._assertUser().id;
    const row = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
    const { data, error } = await this.client.from("board_categories").update(row)
      .eq("owner_id", uid).eq("id", id).eq("revision", expectedRevision)
      .select("*").maybeSingle();
    if (error) throw dbError(error, "board_category:update");
    if (data) return rowToBoardCategory(data);
    const current = await this.client.from("board_categories").select("*").eq("owner_id", uid).eq("id", id).maybeSingle();
    if (current.error) throw dbError(current.error, "board_category:current");
    if (!current.data) throw deletedError("这个分类已在其他设备被删除。");
    throw conflictError(rowToBoardCategory(current.data));
  }

  async deleteBoardCategory(id, expectedRevision) {
    const uid = this._assertUser().id;
    const { data, error } = await this.client.from("board_categories").delete()
      .eq("owner_id", uid).eq("id", id).eq("revision", expectedRevision)
      .select("id").maybeSingle();
    if (error) throw dbError(error, "board_category:delete");
    if (!data) {
      const current = await this.client.from("board_categories").select("*").eq("owner_id", uid).eq("id", id).maybeSingle();
      if (current.data) throw conflictError(rowToBoardCategory(current.data), "这个分类刚被其他设备修改。");
      throw deletedError("这个分类已经在其他设备被删除。");
    }
    return true;
  }

  async getBoardAssignment(productId, boardKey) {
    const uid = this._assertUser().id;
    const { data, error } = await this.client.from("board_assignments").select("*")
      .eq("owner_id", uid).eq("product_id", productId).eq("board_key", boardKey).maybeSingle();
    if (error) throw dbError(error, "assignment:get");
    return data || null;
  }

  async setBoardAssignment(productId, boardKey, categoryId) {
    const uid = this._assertUser().id;
    const existing = await this.getBoardAssignment(productId, boardKey);
    if (!categoryId) {
      if (existing) {
        const { error } = await this.client.from("board_assignments").delete()
          .eq("owner_id", uid).eq("product_id", productId).eq("board_key", boardKey).eq("revision", existing.revision);
        if (error) throw dbError(error, "assignment:delete");
      }
      return null;
    }
    if (existing) {
      const { data, error } = await this.client.from("board_assignments")
        .update({ category_id: categoryId })
        .eq("owner_id", uid).eq("product_id", productId).eq("board_key", boardKey).eq("revision", existing.revision)
        .select("*").maybeSingle();
      if (error) throw dbError(error, "assignment:update");
      if (data) return data;
      const current = await this.getBoardAssignment(productId, boardKey);
      throw conflictError(current, "商品归类刚被其他设备修改。");
    }
    const { data, error } = await this.client.from("board_assignments").insert({
      owner_id: uid, product_id: productId, board_key: boardKey, category_id: categoryId
    }).select("*").single();
    if (error) throw dbError(error, "assignment:create");
    return data;
  }

  async saveSettings(settings, expectedRevision) {
    const uid = this._assertUser().id;
    if (Number.isInteger(expectedRevision)) {
      const { data, error } = await this.client.from("user_settings")
        .update({ settings }).eq("owner_id", uid).eq("revision", expectedRevision)
        .select("*").maybeSingle();
      if (error) throw dbError(error, "settings:update");
      if (data) return data;
    }
    const current = await this._ensureSettings();
    const merged = { ...(current?.settings || {}), ...(settings || {}) };
    if (current) {
      const { data, error } = await this.client.from("user_settings")
        .update({ settings: merged }).eq("owner_id", uid).eq("revision", current.revision)
        .select("*").maybeSingle();
      if (error) throw dbError(error, "settings:merge");
      if (data) return data;
    }
    const { data, error } = await this.client.from("user_settings")
      .upsert({ owner_id: uid, settings: merged }, { onConflict: "owner_id" })
      .select("*").single();
    if (error) throw dbError(error, "settings:upsert");
    return data;
  }

  async mergeSettings(patch) {
    const current = await this._ensureSettings();
    const merged = { ...(current?.settings || {}), ...(patch || {}) };
    return this.saveSettings(merged, current?.revision);
  }

  async uploadStorage(path, blob, contentType) {
    const { error } = await this.client.storage.from(this.bucket).upload(path, blob, {
      contentType,
      cacheControl: "31536000",
      upsert: false
    });
    if (error) throw dbError(error, "storage:upload");
    return path;
  }

  async removeStorage(paths) {
    const clean = (paths || []).filter(Boolean);
    if (!clean.length) return;
    for (const group of chunk(clean, 100)) {
      const { error } = await this.client.storage.from(this.bucket).remove(group);
      if (error) console.warn("删除 Storage 文件失败", error.message);
    }
  }

  async signImageUrls(paths) {
    const clean = [...new Set((paths || []).filter(Boolean))];
    const now = Date.now();
    const out = new Map();
    const missing = [];
    for (const path of clean) {
      const cached = this._signedCache.get(path);
      if (cached && cached.expires > now + 60_000) out.set(path, cached.url);
      else missing.push(path);
    }
    for (const group of chunk(missing, 100)) {
      const { data, error } = await this.client.storage.from(this.bucket).createSignedUrls(group, 3600);
      if (error) {
        console.warn("生成图片签名地址失败", error.message);
        continue;
      }
      for (const item of data || []) {
        if (item?.signedUrl) {
          out.set(item.path, item.signedUrl);
          this._signedCache.set(item.path, { url: item.signedUrl, expires: now + 3600_000 });
        }
      }
    }
    return out;
  }

  async downloadStorage(path) {
    const { data, error } = await this.client.storage.from(this.bucket).download(path);
    if (error) throw dbError(error, "storage:download");
    return data;
  }

  async getProductImage(productId, kind) {
    const uid = this._assertUser().id;
    const { data, error } = await this.client.from("product_images").select("*")
      .eq("owner_id", uid).eq("product_id", productId).eq("kind", kind).maybeSingle();
    if (error) throw dbError(error, "image:get");
    return data ? rowToImage(data) : null;
  }

  async saveProductImageRecord(record, existing = null) {
    const uid = this._assertUser().id;
    const row = {
      owner_id: uid,
      product_id: record.productId,
      kind: record.kind,
      storage_path: record.storagePath,
      thumb_path: record.thumbPath || null,
      file_name: record.fileName || null,
      mime_type: record.mimeType || null,
      size_bytes: record.sizeBytes ?? null,
      width: record.width ?? null,
      height: record.height ?? null
    };
    if (existing?.id) {
      const { data, error } = await this.client.from("product_images").update(row)
        .eq("owner_id", uid).eq("id", existing.id).eq("revision", existing.revision)
        .select("*").maybeSingle();
      if (error) throw dbError(error, "image:update");
      if (data) return rowToImage(data);
      const current = await this.getProductImage(record.productId, record.kind);
      if (!current) throw deletedError("图片记录已被删除。");
      throw conflictError(current, "图片刚被其他设备替换。");
    }
    const { data, error } = await this.client.from("product_images").insert(row).select("*").single();
    if (error) {
      if (/duplicate|23505/i.test(error.message)) {
        const current = await this.getProductImage(record.productId, record.kind);
        if (current) {
          const { data: updated, error: updateError } = await this.client.from("product_images").update(row)
            .eq("owner_id", uid).eq("id", current.id).eq("revision", current.revision)
            .select("*").maybeSingle();
          if (updateError) throw dbError(updateError, "image:update-existing");
          if (updated) return rowToImage(updated);
        }
      }
      throw dbError(error, "image:insert");
    }
    return rowToImage(data);
  }

  async deleteProductImageRecord(id, expectedRevision) {
    const uid = this._assertUser().id;
    const { data, error } = await this.client.from("product_images").delete()
      .eq("owner_id", uid).eq("id", id).eq("revision", expectedRevision)
      .select("*").maybeSingle();
    if (error) throw dbError(error, "image:delete");
    if (!data) {
      const current = await this.client.from("product_images").select("*").eq("owner_id", uid).eq("id", id).maybeSingle();
      if (current.data) throw conflictError(rowToImage(current.data), "图片刚被其他设备修改。");
      throw deletedError("图片已经在其他设备被删除。");
    }
    return rowToImage(data);
  }

  async logBackup(counts, kind = "export") {
    try {
      const uid = this._assertUser().id;
      await this.client.from("backup_logs").insert({
        owner_id: uid, kind, format_version: 2, counts
      });
    } catch (e) {
      console.warn("备份日志写入失败（不影响备份）", e.message);
    }
  }

  async insertProducts(products) {
    const uid = this._assertUser().id;
    let inserted = 0;
    for (const group of chunk(products, CLOUD_BATCH_SIZE)) {
      const rows = group.map((p) => productToRow({ ...p, ownerId: uid }, uid));
      const { error } = await this.client.from("products").upsert(rows, {
        onConflict: "owner_id,id", ignoreDuplicates: true
      });
      if (error) throw dbError(error, "migrate:products");
      inserted += rows.length;
    }
    return inserted;
  }

  async insertCollections(entries) {
    const uid = this._assertUser().id;
    let inserted = 0;
    for (const group of chunk(entries, CLOUD_BATCH_SIZE)) {
      const rows = group.map((e) => collectionToRow(e, uid));
      const { error } = await this.client.from("collections").upsert(rows, {
        onConflict: "owner_id,product_id", ignoreDuplicates: true
      });
      if (error) throw dbError(error, "migrate:collections");
      inserted += rows.length;
    }
    return inserted;
  }

  async insertWishlist(ids) {
    const uid = this._assertUser().id;
    let inserted = 0;
    for (const group of chunk(ids, CLOUD_BATCH_SIZE)) {
      const rows = group.map((productId) => ({ owner_id: uid, product_id: productId }));
      const { error } = await this.client.from("wishlist").upsert(rows, {
        onConflict: "owner_id,product_id", ignoreDuplicates: true
      });
      if (error) throw dbError(error, "migrate:wishlist");
      inserted += rows.length;
    }
    return inserted;
  }

  async insertBoardCategories(categories) {
    const uid = this._assertUser().id;
    let inserted = 0;
    for (const category of categories) {
      const { error } = await this.client.from("board_categories").upsert({
        owner_id: uid,
        id: category.id,
        work_id: category.workId || "gyly",
        character_id: category.characterId || "xmx",
        board_key: category.boardKey,
        name: category.name,
        sort_order: category.sortOrder ?? 0,
        is_default: Boolean(category.isDefault)
      }, { onConflict: "owner_id,id", ignoreDuplicates: true });
      if (!error) { inserted += 1; continue; }
      if (/duplicate|23505/i.test(error.message)) {
        console.warn("分类名称已存在，跳过", category.name);
        continue;
      }
      throw dbError(error, "migrate:categories");
    }
    return inserted;
  }

  async insertBoardAssignments(assignments) {
    const uid = this._assertUser().id;
    let inserted = 0;
    for (const group of chunk(assignments, CLOUD_BATCH_SIZE)) {
      const rows = group.map((a) => ({
        owner_id: uid,
        product_id: a.productId,
        board_key: a.boardKey,
        category_id: a.categoryId
      }));
      const { error } = await this.client.from("board_assignments").upsert(rows, {
        onConflict: "owner_id,product_id,board_key", ignoreDuplicates: true
      });
      if (error) throw dbError(error, "migrate:assignments");
      inserted += rows.length;
    }
    return inserted;
  }

  async upsertRestoreProducts(products, overwrite = false) {
    const uid = this._assertUser().id;
    let affected = 0;
    for (const group of chunk(products, CLOUD_BATCH_SIZE)) {
      const rows = group.map((p) => productToRow({ ...p, ownerId: uid }, uid));
      const { error } = await this.client.from("products").upsert(rows, {
        onConflict: "owner_id,id", ignoreDuplicates: !overwrite
      });
      if (error) throw dbError(error, "restore:products");
      affected += rows.length;
    }
    return affected;
  }

  async upsertRestoreCollections(entries, overwrite = false) {
    const uid = this._assertUser().id;
    let affected = 0;
    for (const group of chunk(entries, CLOUD_BATCH_SIZE)) {
      const rows = group.map((e) => collectionToRow(e, uid));
      const { error } = await this.client.from("collections").upsert(rows, {
        onConflict: "owner_id,product_id", ignoreDuplicates: !overwrite
      });
      if (error) throw dbError(error, "restore:collections");
      affected += rows.length;
    }
    return affected;
  }

  async upsertRestoreWishlist(ids, overwrite = false) {
    const uid = this._assertUser().id;
    let affected = 0;
    for (const group of chunk(ids, CLOUD_BATCH_SIZE)) {
      const rows = group.map((productId) => ({ owner_id: uid, product_id: productId }));
      const { error } = await this.client.from("wishlist").upsert(rows, {
        onConflict: "owner_id,product_id", ignoreDuplicates: !overwrite
      });
      if (error) throw dbError(error, "restore:wishlist");
      affected += rows.length;
    }
    return affected;
  }

  async upsertRestoreCategories(categories) {
    const uid = this._assertUser().id;
    let affected = 0;
    for (const category of categories) {
      const { error } = await this.client.from("board_categories").upsert({
        owner_id: uid,
        id: category.id,
        work_id: category.workId || "gyly",
        character_id: category.characterId || "xmx",
        board_key: category.boardKey,
        name: category.name,
        sort_order: category.sortOrder ?? 0,
        is_default: Boolean(category.isDefault)
      }, { onConflict: "owner_id,id", ignoreDuplicates: false });
      if (error && /duplicate|23505/i.test(error.message)) {
        console.warn("恢复分类时名称冲突，保留云端分类", category.name);
        continue;
      }
      if (error) throw dbError(error, "restore:categories");
      affected += 1;
    }
    return affected;
  }

  async upsertRestoreAssignments(assignments) {
    const uid = this._assertUser().id;
    let affected = 0;
    for (const group of chunk(assignments, CLOUD_BATCH_SIZE)) {
      const rows = group.map((a) => ({
        owner_id: uid, product_id: a.productId, board_key: a.boardKey, category_id: a.categoryId
      }));
      const { error } = await this.client.from("board_assignments").upsert(rows, {
        onConflict: "owner_id,product_id,board_key", ignoreDuplicates: false
      });
      if (error) throw dbError(error, "restore:assignments");
      affected += rows.length;
    }
    return affected;
  }

  subscribe(callback) {
    if (!this.user) return () => {};
    try {
      const uid = this.user.id;
      const tables = ["products", "collections", "wishlist", "board_categories", "board_assignments", "product_images"];
      let channel = this.client.channel("xmx-cloud-sync");
      for (const table of tables) {
        channel = channel.on("postgres_changes", {
          event: "*", schema: "public", table, filter: `owner_id=eq.${uid}`
        }, (payload) => callback({ table, payload }));
      }
      channel.subscribe((status) => {
        if (status === "CHANNEL_ERROR") console.warn("实时同步连接失败，将使用手动/刷新同步");
      });
      this._realtime = channel;
      return () => {
        try { this.client.removeChannel(channel); } catch {}
        this._realtime = null;
      };
    } catch (e) {
      console.warn("实时同步不可用", e.message);
      return () => {};
    }
  }
}
