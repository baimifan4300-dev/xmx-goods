/* V6 Supabase backend — P1: load V6 tables without changing V5 methods. */
import { SupabaseBackend } from "../cloud-supabase.js";
import { uid as makeId } from "../utils.js";
import { bookSetToRow, bookToRow } from "./model.js";

function emptyV6Extras() {
  return {
    collectionTypes: [],
    statusDefinitions: [],
    mainCategoryPrefs: [],
    customMainCategories: [],
    series: [],
    seriesItems: [],
    locations: [],
    fieldDefinitions: [],
    fieldValues: [],
    bookTypes: [],
    bookSets: [],
    books: [],
    orders: [],
    orderItems: [],
    paymentRecords: [],
    priceHistory: [],
    achievements: [],
    userAchievements: [],
    itemImages: [],
    sales: [],
    duplicateCandidates: [],
    statusHistory: []
  };
}

export class SupabaseBackendV6 extends SupabaseBackend {
  async loadV6Extras() {
    const uid = this._assertUser().id;
    const [
      collectionTypes, statuses, categoryPrefs, customCategories,
      series, seriesItems, locations, fieldDefs, fieldValues,
      bookTypes, bookSets, books, orders, orderItems, payments,
      priceHistory, achievements, userAchievements, itemImages,
      sales, duplicates, statusHistory
    ] = await Promise.all([
      this._selectAll("collection_types", (q) => q.order("sort_order")),
      this._selectAll("status_definitions", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("scope").order("sort_order")),
      this._selectAll("main_category_prefs", (q) => q.eq("owner_id", uid).order("sort_order")),
      this._selectAll("custom_main_categories", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("sort_order")),
      this._selectAll("series", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("type").order("sort_order")),
      this._selectAll("series_items", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("series_id").order("sort_order")),
      this._selectAll("locations", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("parent_id").order("sort_order")),
      this._selectAll("field_definitions", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("scope").order("sort_order")),
      this._selectAll("field_values", (q) => q.eq("owner_id", uid).order("entity_type").order("entity_id")),
      this._selectAll("book_types", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("sort_order")),
      this._selectAll("book_sets", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("sort_order")),
      this._selectAll("books", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("set_id").order("volume_number").order("created_at")),
      this._selectAll("orders", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("created_at", { ascending: false })),
      this._selectAll("order_items", (q) => q.eq("owner_id", uid).order("order_id")),
      this._selectAll("payment_records", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("paid_at")),
      this._selectAll("price_history", (q) => q.eq("owner_id", uid).order("recorded_on", { ascending: false, nullsFirst: false })),
      this._selectAll("achievements", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("sort_order")),
      this._selectAll("user_achievements", (q) => q.eq("owner_id", uid).order("unlocked_at", { ascending: false, nullsFirst: false })),
      this._selectAll("item_images", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("entity_type").order("entity_id").order("sort_order")),
      this._selectAll("sales", (q) => q.eq("owner_id", uid).is("deleted_at", null).order("created_at", { ascending: false })),
      this._selectAll("duplicate_candidates", (q) => q.eq("owner_id", uid).order("status").order("score", { ascending: false })),
      this._selectAll("status_history", (q) => q.eq("owner_id", uid).order("changed_at", { ascending: false }))
    ]);

    return {
      collectionTypes,
      statusDefinitions: statuses,
      mainCategoryPrefs: categoryPrefs,
      customMainCategories: customCategories,
      series,
      seriesItems,
      locations,
      fieldDefinitions: fieldDefs,
      fieldValues,
      bookTypes,
      bookSets,
      books,
      orders,
      orderItems,
      paymentRecords: payments,
      priceHistory,
      achievements,
      userAchievements,
      itemImages,
      sales,
      duplicateCandidates: duplicates,
      statusHistory
    };
  }

  async loadV6Snapshot() {
    const base = await this.loadSnapshot();
    try {
      const extras = await this.loadV6Extras();
      return { ...base, ...extras, v6Ready: true };
    } catch (e) {
      console.warn("V6 扩展表尚未就绪（可能还没执行 Migration），先按 V5 快照运行", e.message);
      return { ...base, ...emptyV6Extras(), v6Ready: false };
    }
  }

  /* 作品 / 角色 ------------------------------------------------------------ */
  async createWork(work) {
    const owner = this._assertUser().id;
    const row = {
      id: work.id || `W-${makeId().slice(0, 8)}`,
      title: work.title,
      sort_order: Number(work.sortOrder) || 0,
      owner_id: owner,
      is_builtin: false
    };
    const { data, error } = await this.client.from("works").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async updateWork(id, patch, expectedRevision) {
    const row = {};
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
    let query = this.client.from("works").update(row).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("作品已被其他设备修改，请刷新后重试。");
    return data;
  }

  async deleteWork(id, expectedRevision) {
    const owner = this._assertUser().id;
    let query = this.client.from("works").update({ deleted_at: new Date().toISOString() })
      .eq("id", id).eq("owner_id", owner).eq("is_builtin", false);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("只能删除自己新增的作品，或作品已被修改。");
    return true;
  }

  async getWorkAssociations(id) {
    const owner = this._assertUser().id;
    const [characters, products] = await Promise.all([
      this.client.from("characters").select("id", { count: "exact", head: true })
        .eq("owner_id", owner).eq("work_id", id).is("deleted_at", null),
      this.client.from("products").select("id", { count: "exact", head: true })
        .eq("owner_id", owner).eq("work_id", id).is("deleted_at", null)
    ]);
    if (characters.error) throw new Error(characters.error.message);
    if (products.error) throw new Error(products.error.message);
    return { characters: characters.count || 0, products: products.count || 0 };
  }

  async createCharacter(workId, character) {
    const owner = this._assertUser().id;
    const row = {
      work_id: workId,
      id: character.id || `C-${makeId().slice(0, 8)}`,
      name: character.name,
      theme: character.theme || {},
      catalog: character.catalog || null,
      total: Number(character.total) || 0,
      sort_order: Number(character.sortOrder) || 0,
      owner_id: owner,
      is_builtin: false
    };
    const { data, error } = await this.client.from("characters").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async updateCharacter(workId, id, patch, expectedRevision) {
    const row = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.theme !== undefined) row.theme = patch.theme;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
    let query = this.client.from("characters").update(row).eq("work_id", workId).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("角色已被其他设备修改，请刷新后重试。");
    return data;
  }

  async deleteCharacter(workId, id, expectedRevision) {
    const owner = this._assertUser().id;
    let query = this.client.from("characters").update({ deleted_at: new Date().toISOString() })
      .eq("work_id", workId).eq("id", id).eq("owner_id", owner).eq("is_builtin", false);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("只能删除自己新增的角色，或角色已被修改。");
    return true;
  }

  async getCharacterAssociations(workId, id) {
    const owner = this._assertUser().id;
    const { count, error } = await this.client.from("products")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", owner).eq("work_id", workId).eq("character_id", id).is("deleted_at", null);
    if (error) throw new Error(error.message);
    return { products: count || 0 };
  }

  /* 主分类：内置改覆盖 / 自定义 / 删除重归类 ----------------------------- */
  async countProductsByMainCategory(key) {
    const owner = this._assertUser().id;
    const { count, error } = await this.client.from("products")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", owner).eq("main_category_key", key).is("deleted_at", null);
    if (error) throw new Error(error.message);
    return count || 0;
  }

  async saveMainCategoryPref(categoryKey, patch) {
    const owner = this._assertUser().id;
    const row = {
      owner_id: owner,
      category_key: categoryKey,
      label: patch.label,
      sort_order: Number(patch.sortOrder) || 0
    };
    const { data, error } = await this.client.from("main_category_prefs")
      .upsert(row, { onConflict: "owner_id,category_key" })
      .select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async createCustomMainCategory(category) {
    const owner = this._assertUser().id;
    const row = {
      owner_id: owner,
      id: category.id || `custom-${makeId().slice(0, 8)}`,
      label: category.label,
      sort_order: Number(category.sortOrder) || 0
    };
    const { data, error } = await this.client.from("custom_main_categories").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async updateCustomMainCategory(id, patch, expectedRevision) {
    const owner = this._assertUser().id;
    const row = {};
    if (patch.label !== undefined) row.label = patch.label;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
    let query = this.client.from("custom_main_categories").update(row)
      .eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("分类已被其他设备修改，请刷新后重试。");
    return data;
  }

  async deleteCustomMainCategory(id, expectedRevision) {
    const owner = this._assertUser().id;
    let query = this.client.from("custom_main_categories")
      .update({ deleted_at: new Date().toISOString() })
      .eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("分类已被其他设备修改，请刷新后重试。");
    return true;
  }

  async reassignProductsMainCategory(fromKey, toKey, targetLabel = null) {
    const owner = this._assertUser().id;
    const patch = {
      main_category_key: toKey || null,
      main_category: targetLabel || null,
      category: toKey || "other",
      category_label: targetLabel || "其他"
    };
    const { error } = await this.client.from("products").update(patch)
      .eq("owner_id", owner).eq("main_category_key", fromKey);
    if (error) throw new Error(error.message);
    return true;
  }

  /* 系列 / 系列清单 -------------------------------------------------------- */
  async createSeries(series) {
    const owner = this._assertUser().id;
    const row = {
      owner_id: owner,
      id: series.id || undefined,
      type: series.type || "goods",
      name: series.name,
      work_id: series.workId || null,
      character_id: series.characterId || null,
      description: series.description || null,
      total_expected: series.totalExpected ?? null,
      sort_order: Number(series.sortOrder) || 0
    };
    const { data, error } = await this.client.from("series").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async updateSeries(id, patch, expectedRevision) {
    const owner = this._assertUser().id;
    const row = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.totalExpected !== undefined) row.total_expected = patch.totalExpected;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
    let query = this.client.from("series").update(row).eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("系列已被其他设备修改，请刷新后重试。");
    return data;
  }

  async deleteSeries(id, expectedRevision) {
    const owner = this._assertUser().id;
    let query = this.client.from("series").update({ deleted_at: new Date().toISOString() })
      .eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("系列已被其他设备修改，请刷新后重试。");
    return true;
  }

  async createSeriesItem(item) {
    const owner = this._assertUser().id;
    const row = {
      owner_id: owner,
      series_id: item.seriesId,
      entity_type: item.entityType || "manual",
      product_id: item.productId || null,
      book_id: item.bookId || null,
      display_name: item.displayName || null,
      official_no: item.officialNo || null,
      volume_label: item.volumeLabel || null,
      status_id: item.statusId || null,
      sort_order: Number(item.sortOrder) || 0,
      note: item.note || null
    };
    const { data, error } = await this.client.from("series_items").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async updateSeriesItem(id, patch, expectedRevision) {
    const owner = this._assertUser().id;
    const row = {};
    if (patch.displayName !== undefined) row.display_name = patch.displayName;
    if (patch.statusId !== undefined) row.status_id = patch.statusId;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
    if (patch.note !== undefined) row.note = patch.note;
    let query = this.client.from("series_items").update(row)
      .eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("清单项已被其他设备修改，请刷新后重试。");
    return data;
  }

  async deleteSeriesItem(id, expectedRevision) {
    const owner = this._assertUser().id;
    let query = this.client.from("series_items").update({ deleted_at: new Date().toISOString() })
      .eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("清单项已被其他设备修改，请刷新后重试。");
    return true;
  }

  /* 书籍类型 / 套书 / 卷 --------------------------------------------------- */
  async createBookType(type) {
    const owner = this._assertUser().id;
    const row = {
      owner_id: owner,
      id: type.id || `bt-${makeId().slice(0, 8)}`,
      label: type.label,
      sort_order: Number(type.sortOrder) || 0,
      is_builtin: false
    };
    const { data, error } = await this.client.from("book_types").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async updateBookType(id, patch, expectedRevision) {
    const owner = this._assertUser().id;
    const row = {};
    if (patch.label !== undefined) row.label = patch.label;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
    let query = this.client.from("book_types").update(row)
      .eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("书籍类型已被其他设备修改，请刷新后重试。");
    return data;
  }

  async deleteBookType(id, expectedRevision) {
    const owner = this._assertUser().id;
    const { count, error: countError } = await this.client.from("books")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", owner).eq("book_type_id", id).is("deleted_at", null);
    if (countError) throw new Error(countError.message);
    if ((count || 0) > 0) throw new Error(`该类型下还有 ${count} 本书，不能删除。`);
    let query = this.client.from("book_types").update({ deleted_at: new Date().toISOString() })
      .eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("书籍类型已被其他设备修改，请刷新后重试。");
    return true;
  }

  async createBookSet(set) {
    const owner = this._assertUser().id;
    const row = bookSetToRow(set, owner);
    delete row.id;
    const { data, error } = await this.client.from("book_sets").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async updateBookSet(id, patch, expectedRevision) {
    const owner = this._assertUser().id;
    const row = bookSetToRow({ ...patch, id }, owner);
    delete row.owner_id;
    delete row.id;
    let query = this.client.from("book_sets").update(row)
      .eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("套书已被其他设备修改，请刷新后重试。");
    return data;
  }

  async deleteBookSet(id, expectedRevision) {
    const owner = this._assertUser().id;
    const { count, error: countError } = await this.client.from("books")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", owner).eq("set_id", id).is("deleted_at", null);
    if (countError) throw new Error(countError.message);
    if ((count || 0) > 0) throw new Error(`套书下还有 ${count} 卷，不能删除。请先删除卷或改为独立书。`);
    let query = this.client.from("book_sets").update({ deleted_at: new Date().toISOString() })
      .eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("套书已被其他设备修改，请刷新后重试。");
    return true;
  }

  async createBook(book) {
    const owner = this._assertUser().id;
    const row = bookToRow(book, owner);
    delete row.id;
    const { data, error } = await this.client.from("books").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    return data;
  }

  async updateBook(id, patch, expectedRevision) {
    const owner = this._assertUser().id;
    const row = bookToRow({ ...patch, id }, owner);
    delete row.owner_id;
    delete row.id;
    let query = this.client.from("books").update(row)
      .eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("*").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("书籍已被其他设备修改，请刷新后重试。");
    return data;
  }

  async deleteBook(id, expectedRevision) {
    const owner = this._assertUser().id;
    const { count, error: countError } = await this.client.from("order_items")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", owner).eq("entity_type", "book").eq("entity_id", id);
    if (countError) throw new Error(countError.message);
    if ((count || 0) > 0) throw new Error("这本书已关联订单，不能直接删除；请先处理订单。");
    let query = this.client.from("books").update({ deleted_at: new Date().toISOString() })
      .eq("owner_id", owner).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("书籍已被其他设备修改，请刷新后重试。");
    return true;
  }

  async softDelete(table, id, ownerId = null, expectedRevision = null) {
    const uid = ownerId || this._assertUser().id;
    let query = this.client.from(table).update({ deleted_at: new Date().toISOString() })
      .eq("owner_id", uid).eq("id", id);
    if (Number.isInteger(expectedRevision)) query = query.eq("revision", expectedRevision);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }

  async restoreSoftDeleted(table, id) {
    const uid = this._assertUser().id;
    const { data, error } = await this.client.from(table)
      .update({ deleted_at: null }).eq("owner_id", uid).eq("id", id)
      .select("id").maybeSingle();
    if (error) throw error;
    return Boolean(data);
  }
}
