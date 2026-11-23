import {
  APP_VERSION, BOARD_RESERVED_NAMES, DEFAULT_CATEGORY_CONFIG,
  ERROR_CODES, PAGE_SIZE, SCHEMA_VERSION
} from "./constants.js";
import {
  $, $$, askText, confirmAction, debounce, downloadBlob, formatBytes,
  formatDateTime, formatMoney, formatShortMoney, isCloudConfigured, newBoardCategoryId,
  newProductId, normalizeDate, noticeDialog, parseNumberOrNull, safe, setButtonBusy,
  toast, toastError, uid, validateSupabaseConfig
} from "./utils.js";
import {
  applyBoardToProduct, applyCategoryToProduct, makeNewProduct, normalizeProduct,
  sortCategories
} from "./model.js";
import { SupabaseBackendV6 } from "./v6/cloud-supabase-v6.js";
import { LocalBackend } from "./cloud-local.js";
import {
  bookSetProgress, effectiveMainCategories, normalizeBook, normalizeBookSet, normalizeBookType,
  normalizeSeries, normalizeSeriesItem, normalizeStatus
} from "./v6/model.js";
import { prepareImage, validateImageFile } from "./images.js";
import {
  backupFileName, createBackup, inspectBackup, restoreBackup, restoreReportText
} from "./backup.js";
import {
  legacySummary, migrateToCloud, readLegacyLocalData,
  shouldOfferLocalMerge
} from "./migrate.js";
const config = window.XMX_CONFIG || {};
const state = {
  backend: null,
  mode: null,
  booted: false,
  booting: false,
  refreshing: false,
  refreshQueued: false,
  unsubscribeRealtime: null,
  unsubscribeAuth: null,
  pendingFile: null,
  pendingPreviewUrl: null,
  editingProduct: null,
  lastSnapshot: null,
  legacyPrompted: false
};

const store = {
  user: null,
  profile: null,
  products: [],
  productMap: new Map(),
  collections: new Map(),
  wishlist: new Set(),
  boardCategories: { collab: [], gift: [] },
  assignments: new Map(),
  images: new Map(),
  settings: {},
  settingsRevision: 1,
  mainCategories: DEFAULT_CATEGORY_CONFIG.main.map((c) => ({ ...c })),
  customMainCategories: [],
  mainCategoryPrefs: [],
  statusDefinitions: [],
  series: [],
  seriesItems: [],
  bookTypes: [],
  bookSets: [],
  books: [],
  v6Ready: false,
  works: [],
  characters: [],
  localCategories: DEFAULT_CATEGORY_CONFIG
};

const view = { q: "", cat: "", status: "", sort: "name", limit: PAGE_SIZE, boardCat: "all" };
let staticConfig = {
  categories: JSON.parse(JSON.stringify(DEFAULT_CATEGORY_CONFIG)),
  works: []
};
let baseCatalogPromise = null;

/* -------------------------------------------------------------------------- */
/* 启动                                                                       */
/* -------------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  start().catch((e) => {
    console.error(e);
    hideBoot();
    showFatal(e);
  });
});

async function start() {
  setupShell();
  bindStaticUI();
  await loadStaticConfig();
  const forceDemo = new URLSearchParams(location.search).get("demo") === "1";
  const cfgError = config.supabaseUrl || config.supabaseAnonKey ? validateSupabaseConfig(config) : null;
  if (forceDemo) {
    await startLocal(cfgError);
    return;
  }
  if (!isCloudConfigured(config)) {
    if (config.demoFallback === true) {
      await startLocal(cfgError);
    } else {
      hideBoot();
      showConfigGate(cfgError || "尚未配置 Supabase。请先在 config.js 或 Vercel 环境变量中填写 SUPABASE_URL 与 SUPABASE_ANON_KEY。");
    }
    return;
  }

  state.backend = new SupabaseBackendV6(config);
  state.mode = "cloud";
  try {
    const user = await state.backend.init();
    state.unsubscribeAuth = state.backend.onAuthChange(async (event, nextUser) => {
      if (event === "SIGNED_OUT") {
        teardownApp();
        showAuthGate();
        return;
      }
      if (event === "PASSWORD_RECOVERY") {
        const password = prompt("请输入新密码（至少 6 位）：", "");
        if (password && password.length >= 6) {
          try {
            await state.backend.updatePassword(password);
            toast("密码已更新，请重新登录。", "success", 4200);
            await state.backend.signOut();
          } catch (e) {
            toastError(e, "修改密码失败");
          }
        }
        return;
      }
      if (nextUser && !state.booted && !state.booting) {
        await bootApp().catch((e) => {
          console.error(e);
          hideBoot();
          showAuthGate(errorText(e));
        });
      }
    });
    if (user) {
      await bootApp();
    } else {
      hideBoot();
      showAuthGate();
    }
  } catch (e) {
    console.error(e);
    hideBoot();
    showAuthGate(errorText(e));
  }
}

async function startLocal(configError = null) {
  state.backend = new LocalBackend(config);
  state.mode = "local";
  await state.backend.init();
  showDemoBanner();
  if (configError) {
    setTimeout(() => toast("本地预览模式：Supabase 配置不完整，数据不会上云。", "warn", 5200), 600);
  }
  await bootApp();
}

async function loadStaticConfig() {
  try {
    const res = await fetch("data/categories.json", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.main) && data.main.length === 20) {
        staticConfig.categories = data;
      }
    }
  } catch (e) {
    console.warn("categories.json 读取失败，使用内置 20 分类", e);
  }
  try {
    const res = await fetch("data/works.json", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      staticConfig.works = Array.isArray(data) ? data : (data.works || []);
    }
  } catch (e) {
    console.warn("works.json 读取失败", e);
  }
}

async function fetchBaseCatalog() {
  if (!baseCatalogPromise) {
    baseCatalogPromise = (async () => {
      const res = await fetch("data/gyly/xmx/products.json", { cache: "no-store" });
      if (!res.ok) throw new Error("无法读取内置图鉴数据 data/gyly/xmx/products.json");
      return res.json();
    })().catch((e) => {
      baseCatalogPromise = null;
      throw e;
    });
  }
  return baseCatalogPromise;
}

async function loadBackendSnapshot() {
  if (typeof state.backend?.loadV6Snapshot === "function") return state.backend.loadV6Snapshot();
  return state.backend.loadSnapshot();
}

async function bootApp() {
  if (state.booted || state.booting) return;
  state.booting = true;
  showBoot("正在连接云端收藏室…");
  try {
    let snapshot = await loadBackendSnapshot();
    let autoMigrationReport = null;

    if (state.mode === "cloud" && snapshot.products.length === 0) {
      showBoot("首次使用，正在初始化 1537 件图鉴…");
      const legacy = readLegacyLocalData();
      const baseProducts = await fetchBaseCatalog();
      downloadLegacySnapshot(baseProducts, legacy, "auto");
      autoMigrationReport = await migrateToCloud(state.backend, {
        snapshot, baseProducts, legacy,
        onProgress: (p) => showBoot(p.message || "正在初始化云端图鉴…")
      });
      snapshot = await loadBackendSnapshot();
    }

    if (state.mode === "cloud" && !snapshot.products.length) {
      throw new Error("云端没有商品数据，初始化未完成。请检查 RLS 与迁移日志。");
    }

    // 旧账号：分类为空且未标记初始化时补默认满赠分类
    if (state.mode === "cloud" && snapshot.settings?.defaultsInitialized !== true && !snapshot.boardCategories.length) {
      const baseProducts = await fetchBaseCatalog();
      const legacy = readLegacyLocalData();
      await migrateToCloud(state.backend, {
        snapshot, baseProducts, legacy: { ...legacy, hasAny: false, hasBoards: false, customProducts: [] },
        onProgress: () => {}
      });
      snapshot = await loadBackendSnapshot();
    }

    applySnapshot(snapshot);
    await hydrateImages();
    state.lastSnapshot = snapshot;
    state.booted = true;
    state.booting = false;
    bindAppUI();
    subscribeRealtime();
    hideAuthGate();
    hideDemoIfCloud();
    await applyRoute();
    renderAll();
    hideBoot();
    updateAccountButton();
    updateSyncStatus("online");
    const deepDetail = new URLSearchParams(location.search).get("detail");
    if (deepDetail && store.productMap.has(deepDetail)) {
      setTimeout(() => openDetail(deepDetail), 350);
    }

    if (autoMigrationReport) {
      setTimeout(() => {
        noticeDialog({
          title: "云端图鉴已初始化",
          message: `已导入 ${autoMigrationReport.products} 件原始商品、${autoMigrationReport.customProducts} 件本机商品。`,
          details: `<ul class="confirm-list">
            <li>收藏：${autoMigrationReport.collections} 条</li>
            <li>愿望清单：${autoMigrationReport.wishlist} 条</li>
            <li>联动/满赠分类：${autoMigrationReport.categories} 个</li>
            <li>分类归属：${autoMigrationReport.assignments} 条</li>
          </ul><p class="form-hint">本机旧数据保留未删除。以后可以在“账户 → 从本机旧数据合并”再次检查。</p>`
        });
      }, 750);
    } else if (state.mode === "cloud" && shouldOfferLocalMerge(snapshot, readLegacyLocalData(), state.backend.user?.id)) {
      setTimeout(showLegacyBanner, 900);
    }
  } catch (e) {
    state.booting = false;
    state.booted = false;
    console.error(e);
    hideBoot();
    if (state.mode === "cloud") showAuthGate(errorText(e));
    else toastError(e, "本地预览加载失败");
    throw e;
  }
}

function applySnapshot(snapshot) {
  state.lastSnapshot = snapshot;
  store.user = snapshot.user;
  store.profile = snapshot.profile;
  store.products = (snapshot.products || []).map(normalizeProduct);
  store.productMap = new Map(store.products.map((p) => [p.id, p]));
  store.collections = new Map((snapshot.collections || []).map((c) => [c.productId, c]));
  store.wishlist = new Set(snapshot.wishlist || []);
  store.boardCategories = { collab: [], gift: [] };
  for (const category of sortCategories(snapshot.boardCategories || [])) {
    if (store.boardCategories[category.boardKey]) store.boardCategories[category.boardKey].push(category);
  }
  store.assignments = new Map();
  for (const assignment of snapshot.boardAssignments || []) {
    store.assignments.set(assignmentKey(assignment.boardKey, assignment.productId), assignment.categoryId);
  }
  store.images = new Map();
  for (const image of snapshot.productImages || []) {
    store.images.set(`${image.productId}::${image.kind}`, image);
  }
  for (const product of store.products) {
    product._images = {};
    for (const kind of ["highres", "cover"]) {
      const image = store.images.get(`${product.id}::${kind}`);
      if (image) product._images[kind] = image;
    }
  }
  store.settings = snapshot.settings || {};
  store.settingsRevision = snapshot.settingsRevision || 1;
  store.v6Ready = Boolean(snapshot.v6Ready);
  store.customMainCategories = snapshot.customMainCategories || [];
  store.mainCategoryPrefs = snapshot.mainCategoryPrefs || [];
  store.statusDefinitions = (snapshot.statusDefinitions || []).map(normalizeStatus);
  store.series = (snapshot.series || []).map(normalizeSeries).filter((s) => !s.deletedAt);
  store.seriesItems = (snapshot.seriesItems || []).map(normalizeSeriesItem).filter((s) => !s.deletedAt);
  store.bookTypes = (snapshot.bookTypes || []).map(normalizeBookType).filter((t) => !t.deletedAt);
  store.bookSets = (snapshot.bookSets || []).map(normalizeBookSet).filter((s) => !s.deletedAt);
  store.books = (snapshot.books || []).map(normalizeBook).filter((b) => !b.deletedAt);
  store.mainCategories = normalizeMainCategories(snapshot.mainCategories, store.mainCategoryPrefs, store.customMainCategories);
  store.works = normalizeWorks(snapshot.works, snapshot.characters);
  store.characters = store.works.flatMap((w) => w.characters || []);
  store.localCategories = staticConfig.categories;
}

function normalizeMainCategories(rows, prefs = [], custom = []) {
  const list = effectiveMainCategories(rows || [], prefs || [], custom || []).map((c) => ({
    key: c.key, label: c.label, order: c.sortOrder, sortOrder: c.sortOrder, isBuiltin: c.isBuiltin
  }));
  if (list.length >= 20) return list;
  return staticConfig.categories.main.map((c, i) => ({ ...c, order: i + 1, sortOrder: i + 1, isBuiltin: true }));
}

function normalizeWorks(cloudWorks, cloudCharacters) {
  const activeWorks = (cloudWorks || []).filter((w) => !w.deleted_at);
  if (Array.isArray(activeWorks) && activeWorks.length) {
    return activeWorks.map((w, wi) => ({
      ...w,
      id: w.id,
      title: w.title,
      sort_order: w.sort_order ?? wi + 1,
      sortOrder: w.sort_order ?? wi + 1,
      ownerId: w.owner_id || w.ownerId || null,
      isBuiltin: Boolean(w.is_builtin ?? w.isBuiltin),
      revision: Number(w.revision) || 1,
      characters: (cloudCharacters || []).filter((c) => c.work_id === w.id && !c.deleted_at).map((c, ci) => ({
        id: c.id, name: c.name, theme: c.theme || {}, total: c.total || 0,
        catalog: c.catalog || `data/${w.id}/${c.id}/products.json`,
        sort_order: c.sort_order ?? ci + 1,
        sortOrder: c.sort_order ?? ci + 1,
        ownerId: c.owner_id || c.ownerId || null,
        isBuiltin: Boolean(c.is_builtin ?? c.isBuiltin),
        revision: Number(c.revision) || 1
      }))
    }));
  }
  const works = staticConfig.works.length ? staticConfig.works : [{
    id: "gyly", title: "光与夜之恋",
    characters: [{ id: "xmx", name: "夏鸣星", theme: {}, total: 1537, catalog: "data/gyly/xmx/products.json" }]
  }];
  return works.map((w) => ({
    ...w,
    characters: (w.characters || []).map((c) => ({
      ...c, theme: c.theme || {}, total: c.total || 0,
      catalog: c.catalog || `data/${w.id}/${c.id}/products.json`
    }))
  }));
}

async function hydrateImages() {
  const paths = [];
  for (const image of store.images.values()) {
    if (image.storagePath) paths.push(image.storagePath);
    if (image.thumbPath) paths.push(image.thumbPath);
  }
  let urls = new Map();
  if (paths.length) {
    try {
      urls = await state.backend.signImageUrls(paths);
    } catch (e) {
      console.warn("图片签名失败", e);
    }
  }
  for (const image of store.images.values()) {
    image.url = urls.get(image.storagePath) || null;
    image.thumbUrl = image.thumbPath ? (urls.get(image.thumbPath) || null) : null;
  }
  for (const product of store.products) {
    const high = product._images?.highres;
    const cover = product._images?.cover;
    product._highResUrl = high?.url || null;
    product._highResThumbUrl = high?.thumbUrl || high?.url || null;
    product._coverUrl = cover?.url || null;
    product._coverThumbUrl = cover?.thumbUrl || cover?.url || null;
  }
}

/* -------------------------------------------------------------------------- */
/* 账户 / 登录                                                                */
/* -------------------------------------------------------------------------- */

let authMode = "signin";

function bindStaticUI() {
  $("menuToggle")?.addEventListener("click", () => $("mainNav")?.classList.toggle("open"));
  $("accountBtn")?.addEventListener("click", openAccountDialog);
  $("demoConfigBtn")?.addEventListener("click", () => {
    noticeDialog({
      title: "如何连接 Supabase",
      message: "把 Supabase 项目的 URL 和 anon public key 填入 config.js，或在 Vercel 配置环境变量后重新部署。",
      details: `<ol class="confirm-list">
        <li>在 Supabase SQL Editor 依次执行 supabase/migrations 下的 SQL。</li>
        <li>确认 Storage 已创建 product-images 私有桶。</li>
        <li>在 Vercel 配置 SUPABASE_URL、SUPABASE_ANON_KEY。</li>
        <li>重新部署，注册账号即可启用云端同步。</li>
      </ol><p class="form-hint">详细步骤见项目内 docs/云端部署与迁移.md。</p>`
    });
  });

  $$("[data-auth-tab]").forEach((btn) => btn.addEventListener("click", () => setAuthMode(btn.dataset.authTab)));
  $("authForm")?.addEventListener("submit", handleAuthSubmit);
  $("authForgot")?.addEventListener("click", handleForgotPassword);
  $("authResend")?.addEventListener("click", handleResendConfirmation);
  $("authDemo")?.addEventListener("click", async () => {
    hideAuthGate();
    await startLocal();
  });

  window.addEventListener("hashchange", () => { if (state.booted) applyRoute(); });
  window.addEventListener("online", () => {
    $("offlineBanner")?.classList.add("hidden");
    updateSyncStatus("online");
    if (state.booted) refreshData({ silent: true });
  });
  window.addEventListener("offline", () => {
    $("offlineBanner")?.classList.remove("hidden");
    updateSyncStatus("offline");
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.booted) refreshData({ silent: true });
  });
  window.addEventListener("focus", () => {
    if (state.booted && !document.hidden) refreshData({ silent: true });
  });
  const localRefresh = debounce(() => {
    if (state.mode === "local" && state.booted && !document.hidden) refreshData({ silent: true });
  }, 260);
  window.addEventListener("storage", (e) => {
    if (e.key?.startsWith("xmx.local.v5.")) localRefresh();
  });
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const fallback = img.dataset.fallback;
    if (fallback && img.src !== fallback) {
      img.dataset.fallback = "";
      img.src = fallback;
    }
  }, true);

  // 全局点击
  document.addEventListener("click", handleGlobalClick);
  document.addEventListener("change", (e) => {
    const assign = e.target.closest("[data-assign]");
    if (assign) {
      assignBoardProduct(assign.dataset.assign, assign.dataset.board, assign.value);
    }
  });

  ["searchInput", "categoryFilter", "statusFilter", "sortFilter"].forEach((id) => {
    $(id)?.addEventListener("input", handleFilterChange);
  });
}

function bindAppUI() {
  if ($("addProductBtn") && !$("addProductBtn").dataset.bound) {
    $("addProductBtn").dataset.bound = "1";
    $("addProductBtn").addEventListener("click", () => openProductForm());
  }
  if ($("emptyAddBtn") && !$("emptyAddBtn").dataset.bound) {
    $("emptyAddBtn").dataset.bound = "1";
    $("emptyAddBtn").addEventListener("click", () => openProductForm());
  }
}

function setAuthMode(mode) {
  authMode = mode === "signup" ? "signup" : "signin";
  $$("[data-auth-tab]").forEach((btn) => btn.classList.toggle("active", btn.dataset.authTab === authMode));
  $("authTitle").textContent = authMode === "signin" ? "登录云端收藏室" : "创建你的收藏室";
  $("authSub").textContent = authMode === "signin"
    ? "同一个账号，电脑、手机、平板共享同一份图鉴与收藏。"
    : "注册后会把内置 1537 件图鉴初始化到你的云端账号。";
  $("authSubmit").textContent = authMode === "signin" ? "登录" : "注册";
  $("authPassword").autocomplete = authMode === "signin" ? "current-password" : "new-password";
  $("authMessage").textContent = "";
  $("authMessage").className = "auth-message";
}

function showAuthGate(message = "") {
  hideBoot();
  $("authGate")?.classList.remove("hidden");
  $("accountBtn").hidden = true;
  $("demoBanner")?.classList.add("hidden");
  $("authForm").hidden = false;
  document.querySelector(".auth-tabs")?.classList.remove("hidden");
  document.querySelector(".auth-links")?.classList.remove("hidden");
  setAuthMode(authMode);
  if (message) {
    $("authMessage").textContent = message;
    $("authMessage").className = "auth-message";
  }
  if (config.demoFallback !== false) $("authDemo").hidden = false;
  setTimeout(() => $("authEmail")?.focus(), 100);
}

function hideAuthGate() {
  $("authGate")?.classList.add("hidden");
}

function showConfigGate(message) {
  hideBoot();
  $("authGate")?.classList.remove("hidden");
  $("accountBtn").hidden = true;
  $("authTitle").textContent = "还差一步：连接 Supabase";
  $("authSub").innerHTML = "这个版本以 Supabase 云端数据库为唯一数据源。请先完成项目配置，再登录使用。只想先看界面，可打开 <a href=\"?demo=1\">本地预览</a>（数据不会同步）。";
  $("authForm").hidden = true;
  document.querySelector(".auth-tabs")?.classList.add("hidden");
  document.querySelector(".auth-links")?.classList.add("hidden");
  $("authMessage").textContent = message;
  $("authMessage").className = "auth-message";
  $("authResend").hidden = true;
  $("authDemo").hidden = true;
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (!state.backend) return;
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const btn = $("authSubmit");
  if (!email || !password) return;
  setButtonBusy(btn, true, authMode === "signin" ? "登录中…" : "注册中…");
  $("authMessage").textContent = "";
  try {
    if (authMode === "signin") {
      await state.backend.signIn(email, password);
      hideAuthGate();
      await bootApp();
    } else {
      const res = await state.backend.signUp(email, password);
      if (res.needsEmailConfirm) {
        setAuthMode("signin");
        $("authMessage").textContent = "注册成功。请打开邮箱点击确认链接后再登录；如果没收到，请检查垃圾邮件。";
        $("authMessage").className = "auth-message ok";
        $("authResend").hidden = false;
      } else {
        hideAuthGate();
        await bootApp();
      }
    }
  } catch (e) {
    console.error(e);
    $("authMessage").textContent = authErrorText(e);
    $("authMessage").className = "auth-message";
  } finally {
    setButtonBusy(btn, false);
  }
}

async function handleForgotPassword() {
  const email = $("authEmail").value.trim();
  if (!email) {
    $("authMessage").textContent = "请先填写邮箱，再点“忘记密码”。";
    $("authEmail").focus();
    return;
  }
  try {
    await state.backend.resetPassword(email);
    $("authMessage").textContent = "重置密码邮件已发送，请查收邮箱。";
    $("authMessage").className = "auth-message ok";
  } catch (e) {
    $("authMessage").textContent = authErrorText(e);
    $("authMessage").className = "auth-message";
  }
}

async function handleResendConfirmation() {
  const email = $("authEmail").value.trim();
  if (!email) return;
  try {
    await state.backend.resendConfirmation(email);
    $("authMessage").textContent = "确认邮件已重新发送。";
    $("authMessage").className = "auth-message ok";
  } catch (e) {
    $("authMessage").textContent = authErrorText(e);
    $("authMessage").className = "auth-message";
  }
}

function authErrorText(error) {
  const msg = String(error?.message || "");
  if (/Invalid login credentials/i.test(msg)) return "邮箱或密码不正确。";
  if (/Email not confirmed/i.test(msg)) return "邮箱尚未确认，请先点击确认邮件中的链接。";
  if (/User already registered/i.test(msg)) return "这个邮箱已经注册，请直接登录或重置密码。";
  if (/Password should be at least/i.test(msg)) return "密码至少需要 6 位。";
  if (/Unable to validate email/i.test(msg)) return "邮箱格式不正确。";
  if (/rate limit|too many/i.test(msg)) return "操作太频繁，请稍后再试。";
  if (error?.userMessage) return error.userMessage;
  return msg || "操作失败，请稍后重试。";
}

function errorText(error) {
  return error?.userMessage || error?.message || "操作失败";
}

/* -------------------------------------------------------------------------- */
/* 页面渲染                                                                   */
/* -------------------------------------------------------------------------- */

function setupShell() {
  const home = $("page-home");
  if (home && !$("worksStrip")) {
    const section = document.createElement("section");
    section.className = "works-section";
    section.innerHTML = `<div class="section-heading">
      <div><span class="eyebrow">WORKS & CHARACTERS</span><h2>作品与角色</h2></div>
      <span class="muted"><button class="mini-btn" id="manageWorksBtn">管理作品/角色</button> <button class="mini-btn" id="openDataBtn">数据与备份</button></span>
    </div><div id="worksStrip" class="works-strip"></div>`;
    home.insertBefore(section, home.querySelector(".hero"));
    section.querySelector("#openDataBtn").addEventListener("click", openAccountDialog);
    section.querySelector("#manageWorksBtn").addEventListener("click", openWorksManager);
  }
  if ($("addProductBtn") && !$("manageCategoriesBtn")) {
    $("addProductBtn").insertAdjacentHTML("beforebegin",
      `<button class="outline-btn" id="manageCategoriesBtn">分类管理</button>
       <button class="outline-btn" id="manageSeriesBtn">系列清单</button> `);
    $("manageCategoriesBtn").addEventListener("click", openCategoryManager);
    $("manageSeriesBtn").addEventListener("click", openSeriesManager);
  }
  if ($("mainNav") && !$("mainNav").querySelector('[data-page="books"]')) {
    const before = $("mainNav").querySelector('[data-page="progress"]');
    if (before) before.insertAdjacentHTML("beforebegin", '<button class="nav-link" data-page="books">书籍收藏</button>');
    else $("mainNav").insertAdjacentHTML("beforeend", '<button class="nav-link" data-page="books">书籍收藏</button>');
  }
  if (!$("page-books")) {
    const page = document.createElement("section");
    page.className = "page";
    page.id = "page-books";
    page.innerHTML = `<div class="page-heading"><div><span class="eyebrow">BOOKS & VOLUMES</span><h1>书籍收藏</h1>
      <p>漫画、小说、画集、设定集；支持套书逐卷管理。</p></div>
      <div class="book-head-actions"><button class="outline-btn" id="manageBookTypesBtn">类型管理</button>
        <button class="outline-btn" id="addBookSetBtn">＋ 套书</button>
        <button class="primary-btn" id="addBookBtn">＋ 单本</button></div></div>
      <div class="toolbar">
        <label class="search-box"><span>⌕</span><input id="bookSearch" type="search" placeholder="搜索书名、作者、出版社、ISBN…"></label>
        <select id="bookTypeFilter"><option value="">全部类型</option></select>
        <select id="bookStatusFilter"><option value="">全部状态</option></select>
      </div>
      <div class="result-line"><span id="bookResultCount">0 本</span><span id="bookSyncHint">套书进度按已入手卷数计算</span></div>
      <div id="bookSetSection"><div class="section-heading"><div><span class="eyebrow">SETS</span><h2>套书</h2></div></div><div class="product-grid" id="bookSetGrid"></div></div>
      <div class="section-heading"><div><span class="eyebrow">ALL BOOKS</span><h2>全部书籍</h2></div></div>
      <div class="product-grid" id="bookGrid"></div>
      <div class="empty-state" id="bookEmpty"><div>▤</div><h3>还没有书籍</h3><p>先添加一本单本，或新建一套套书。</p><button class="primary-btn" id="emptyAddBookBtn">＋ 添加第一本书</button></div>`;
    const shell = document.querySelector("main.shell");
    shell.insertBefore(page, $("page-owned"));
    page.querySelector("#addBookBtn").addEventListener("click", () => openBookForm());
    page.querySelector("#emptyAddBookBtn").addEventListener("click", () => openBookForm());
    page.querySelector("#addBookSetBtn").addEventListener("click", () => openBookSetForm());
    page.querySelector("#manageBookTypesBtn").addEventListener("click", openBookTypeManager);
    page.querySelector("#bookSearch").addEventListener("input", () => renderBooks());
    page.querySelector("#bookTypeFilter").addEventListener("change", () => renderBooks());
    page.querySelector("#bookStatusFilter").addEventListener("change", () => renderBooks());
  }
  if ($("productGrid") && !$("loadMoreBtn")) {
    const btn = document.createElement("button");
    btn.id = "loadMoreBtn";
    btn.className = "outline-btn load-more";
    btn.textContent = "加载更多";
    btn.addEventListener("click", () => { view.limit += PAGE_SIZE; renderCatalog(); });
    $("productGrid").after(btn);
  }
}

function currentCharacterProducts() {
  const workId = state.currentWork?.id;
  const charId = state.currentChar?.id;
  return store.products.filter((p) => (!workId || p.workId === workId) && (!charId || p.characterId === charId) && !p.deletedAt);
}

function countForCharacter(workId, charId) {
  return store.products.filter((p) => p.workId === workId && p.characterId === charId && !p.deletedAt).length;
}

function renderAll() {
  if (!state.booted) return;
  const scoped = currentCharacterProducts();
  const total = scoped.length;
  const ownedKinds = scoped.filter((p) => store.collections.has(p.id)).length;
  const ownedPieces = scoped.reduce((sum, p) => sum + (Number(store.collections.get(p.id)?.quantity) || 0), 0);
  $("totalCount").textContent = total;
  $("ownedCount").textContent = ownedKinds;
  $("wishCount").textContent = scoped.filter((p) => store.wishlist.has(p.id)).length;
  $("rateCount").textContent = (total ? Math.round((ownedKinds / total) * 100) : 0) + "%";
  if ($("homeTotal")) $("homeTotal").textContent = total;
  const hint = state.mode === "cloud"
    ? `云端账号 · 已拥有 ${ownedPieces} 件`
    : "本地预览 · 未开启跨设备同步";
  if ($("homeSyncHint")) $("homeSyncHint").textContent = hint;
  if ($("catalogSyncHint")) {
    $("catalogSyncHint").textContent = state.mode === "cloud"
      ? "20 个主分类 · 云端实时同步"
      : "20 个主分类 · 本地预览模式";
  }
  renderWorksStrip();
  renderBoardBar();
  fillCategoryFilter();
  renderCatalog();
  renderGrid("ownedGrid", scoped.filter((p) => store.collections.has(p.id)), "ownedEmpty", true);
  renderGrid("wishlistGrid", scoped.filter((p) => store.wishlist.has(p.id)), "wishlistEmpty", false);
  renderProgress();
  renderBooks();
  renderOwnedSummary();
  updateAccountButton();
}

function renderWorksStrip() {
  const el = $("worksStrip");
  if (!el) return;
  el.innerHTML = (store.works || []).map((w) => `
    <div class="work-block">
      <div class="work-head"><b>${safe(w.title)}</b><span>${w.characters?.length || 0} 位角色</span></div>
      <div class="char-row">${(w.characters || []).map((c) => {
        const active = state.currentChar?.id === c.id && state.currentWork?.id === w.id;
        return `<a class="char-chip ${active ? "active" : ""}" href="#/w/${safe(w.id)}/c/${safe(c.id)}">
          <span class="char-avatar" style="background:${safe(c.theme?.["--pink"] || "#e8b9c9")}">${safe((c.name || "?").slice(0, 1))}</span>
          <span><b>${safe(c.name)}</b><small>${countForCharacter(w.id, c.id)} 件</small></span></a>`;
      }).join("")}</div>
    </div>`).join("");
}

function renderOwnedSummary() {
  const el = $("ownedSummary");
  if (!el) return;
  let pieces = 0;
  let spent = 0;
  let market = 0;
  for (const [id, entry] of store.collections) {
    const qty = Math.max(1, Number(entry.quantity) || 1);
    pieces += qty;
    if (entry.purchasePrice != null) spent += Number(entry.purchasePrice);
    const p = store.productMap.get(id);
    if (p?.marketPrice != null) market += Number(p.marketPrice) * qty;
  }
  el.innerHTML = `<div class="osum"><small>收藏种类</small><b>${store.collections.size}</b><span>件不同商品</span></div>
    <div class="osum"><small>拥有件数</small><b>${pieces}</b><span>含重复数量</span></div>
    <div class="osum"><small>实际花费</small><b>${formatShortMoney(spent)}</b><span>已填写购入价合计</span></div>
    <div class="osum"><small>当前市价</small><b>${formatShortMoney(market)}</b><span>已填写市场价合计</span></div>`;
}

function renderCatalog() {
  const list = filteredProducts();
  const shown = list.slice(0, view.limit);
  $("productGrid").innerHTML = shown.map((p) => cardHTML(p, { boardView: true })).join("");
  $("catalogEmpty").classList.toggle("hidden", list.length > 0);
  const more = $("loadMoreBtn");
  if (more) {
    more.classList.toggle("hidden", shown.length >= list.length);
    more.textContent = `加载更多（${shown.length}/${list.length}）`;
  }
  $("resultCount").textContent = `${list.length} 件商品`;
}

function renderGrid(id, items, emptyId, showPurchase) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = items.map((p) => cardHTML(p, { showPurchase })).join("");
  $(emptyId)?.classList.toggle("hidden", items.length > 0);
}

function renderProgress() {
  const scoped = currentCharacterProducts();
  const total = scoped.length;
  const owned = scoped.filter((p) => store.collections.has(p.id)).length;
  const rate = total ? Math.round((owned / total) * 100) : 0;
  $("progressText").innerHTML = `${rate}% <small>COLLECTED</small>`;
  $("progressDetail").textContent = `已拥有 ${owned} / ${total} 种商品，共 ${scoped.reduce((s, p) => s + (Number(store.collections.get(p.id)?.quantity) || 0), 0)} 件`;
  $("bigProgressBar").style.width = rate + "%";
  const groups = [
    ...store.mainCategories.map((c) => ({
      key: `main:${c.key}`, label: c.label,
      match: (p) => p.mainCategoryKey === c.key
    })),
    ...DEFAULT_CATEGORY_CONFIG.boards.map((b) => ({
      key: `board:${b.key}`, label: `${b.label}（板块）`,
      match: (p) => p.boardKey === b.key
    })),
    {
      key: "pending", label: staticConfig.categories.pending?.label || "待核对",
      match: (p) => p.classificationStatus === "待核对"
    }
  ];
  $("categoryProgressList").innerHTML = groups.map((g) => {
    const all = scoped.filter(g.match);
    const got = all.filter((p) => store.collections.has(p.id)).length;
    const pct = all.length ? Math.round((got / all.length) * 100) : 0;
    return `<div class="progress-row ${g.key.startsWith("board:") ? "board-row" : ""}" data-jump-cat="${safe(g.key)}"><span>${safe(g.label)}</span><div class="progress-track"><span style="width:${pct}%"></span></div><span>${got}/${all.length}</span></div>`;
  }).join("");
}

function fillCategoryFilter() {
  const sel = $("categoryFilter");
  if (!sel) return;
  const option = (value, label) => `<option value="${safe(value)}">${safe(label)}</option>`;
  const mainOptions = store.mainCategories.map((c) => option(`main:${c.key}`, c.label)).join("");
  const boardOptions = DEFAULT_CATEGORY_CONFIG.boards.map((b) => option(`board:${b.key}`, b.label)).join("");
  const pending = staticConfig.categories.pending?.label || "待核对";
  sel.innerHTML = '<option value="">全部商品</option>' +
    `<optgroup label="主分类">${mainOptions}</optgroup>` +
    `<optgroup label="独立板块">${boardOptions}</optgroup>` +
    `<optgroup label="分类核对">${option("pending", pending)}</optgroup>`;
  sel.value = view.cat || "";
  if (sel.value !== (view.cat || "")) sel.value = "";
}

function filteredProducts() {
  const q = view.q.toLowerCase();
  const [kind, key] = String(view.cat || "").split(":");
  let list = store.products.filter((p) => {
    if (p.deletedAt) return false;
    if (state.currentWork?.id && p.workId !== state.currentWork.id) return false;
    if (state.currentChar?.id && p.characterId !== state.currentChar.id) return false;
    if (q) {
      const hay = [p.name, p.series, p.productCode, p.notes, p.folder, p.variety,
        p.mainCategory, p.board, p.classificationBasis, p.marketPrice]
        .join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (view.cat) {
      if (view.cat === "pending") {
        if (p.classificationStatus !== "待核对") return false;
      } else if (kind === "main" && p.mainCategoryKey !== key) return false;
      else if (kind === "board" && p.boardKey !== key) return false;
      else if (kind === "board") {
        const assigned = store.assignments.get(assignmentKey(key, p.id));
        if (view.boardCat === "uncat") {
          if (assigned) return false;
        } else if (view.boardCat && view.boardCat !== "all") {
          if (assigned !== view.boardCat) return false;
        }
      }
    }
    if (view.status === "owned" && !store.collections.has(p.id)) return false;
    if (view.status === "wish" && !store.wishlist.has(p.id)) return false;
    if (view.status === "none" && (store.collections.has(p.id) || store.wishlist.has(p.id))) return false;
    return true;
  });
  if (view.sort === "price") list.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
  else if (view.sort === "market") list.sort((a, b) => (a.marketPrice ?? 1e9) - (b.marketPrice ?? 1e9));
  else if (view.sort === "newest") list.sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
  else list.sort((a, b) => {
    if (!a.name && b.name) return 1;
    if (a.name && !b.name) return -1;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
  });
  return list;
}

function cardHTML(product, opts = {}) {
  const owned = store.collections.get(product.id);
  const wish = store.wishlist.has(product.id);
  const tag = productCategoryLabel(product);
  const boardKey = opts.boardView ? currentBoardKey() : null;
  const qty = owned ? Math.max(1, Number(owned.quantity) || 1) : 0;
  const market = product.marketPrice != null ? formatShortMoney(product.marketPrice) : "";
  const purchase = opts.showPurchase && owned?.purchasePrice != null
    ? `<div class="card-purchase">购入 ${formatShortMoney(owned.purchasePrice)}${owned.purchaseDate ? ` · ${safe(owned.purchaseDate)}` : ""}</div>` : "";
  return `<article class="product-card" data-open="${safe(product.id)}">
    <div class="product-image crop-box">${mediaHTML(product)}
      <span class="${productTagClass(product)}">${safe(tag)}</span>
      ${product.verificationStatus === "pending" && product.classificationStatus !== "待核对" ? '<span class="pending-tag">待核实</span>' : ""}
      ${qty > 1 ? `<span class="qty-badge">×${qty}</span>` : ""}
    </div>
    <div class="product-info"><h3>${safe(product.name || "待识别")}</h3>
      <div class="product-meta">${safe(product.series || product.folder || "未填写系列")}${product.productCode ? ` · ${safe(product.productCode)}` : ""}</div>
      <div class="product-price">${market ? `市价 ${market}` : priceLabel(product)}</div>
      ${market && product.price != null ? `<div class="market-line">原价 <b>${formatShortMoney(product.price)}</b></div>` : ""}
      ${purchase}
      ${boardKey && product.boardKey === boardKey ? boardAssignHTML(product, boardKey) : ""}</div>
    <div class="card-actions">
      <button class="mini-btn ${owned ? "active" : ""}" data-action="owned" data-id="${safe(product.id)}">${owned ? (qty > 1 ? `✓ ×${qty}` : "✓ 已拥有") : "+ 已拥有"}</button>
      <button class="mini-btn ${wish ? "active" : ""}" data-action="wish" data-id="${safe(product.id)}">${wish ? "★ 已心愿" : "☆ 想要"}</button>
      <button class="mini-btn" data-action="detail" data-id="${safe(product.id)}" aria-label="详情">⋯</button>
    </div>
  </article>`;
}

function productCategoryLabel(p) {
  if (p.classificationStatus === "待核对") return staticConfig.categories.pending?.label || "待核对";
  const category = store.mainCategories.find((c) => c.key === p.mainCategoryKey);
  return category?.label || p.mainCategory || p.board || p.categoryLabel || "其他";
}

function productTagClass(p) {
  if (p.classificationStatus === "待核对") return "product-tag tag-pending";
  if (p.boardKey) return "product-tag tag-board";
  return "product-tag";
}

function priceLabel(p) {
  if (p.price != null) return `¥ ${Number(p.price).toFixed(2)}`;
  if (p.priceText) return safe(p.priceText);
  return "价格待补充";
}

function mediaHTML(p) {
  const high = p._highResThumbUrl || p._coverThumbUrl;
  if (high) {
    const fallback = p.image?.thumb || p.image?.src || "";
    return `<img class="thumb-img" src="${safe(high)}" data-fallback="${safe(fallback)}" alt="${safe(p.name || "商品图片")}" loading="lazy">`;
  }
  const im = p.image || {};
  if (!im.src) return `<div class="image-placeholder">✧</div>`;
  if (im.sharp && im.thumb) {
    return `<img class="thumb-img" src="${safe(im.thumb)}" alt="${safe(p.name || "待识别")}" loading="lazy">`;
  }
  const iw = im.imageWidth, ih = im.imageHeight;
  if (!iw || !ih) return `<img class="thumb-img" src="${safe(im.src)}" alt="${safe(p.name || "待识别")}" loading="lazy">`;
  const box = `left:${(im.x / iw) * 100}%;top:${(im.y / ih) * 100}%;width:${(im.width / iw) * 100}%;height:${(im.height / ih) * 100}%`;
  return `<div class="locator"><div class="locator-inner" style="aspect-ratio:${iw}/${ih}">
    <img src="${safe(im.src)}" alt="合集图定位" loading="lazy"><span class="locator-box" style="${box}"></span>
  </div><span class="locator-tag">合集定位</span></div>`;
}

/* -------------------------------------------------------------------------- */
/* 筛选 / 通用点击                                                            */
/* -------------------------------------------------------------------------- */

function handleFilterChange() {
  const prevCat = view.cat;
  view.q = $("searchInput").value.trim();
  view.cat = $("categoryFilter").value;
  view.status = $("statusFilter").value;
  view.sort = $("sortFilter").value;
  if (prevCat !== view.cat) view.boardCat = "all";
  view.limit = PAGE_SIZE;
  renderBoardBar();
  renderCatalog();
}

function handleGlobalClick(event) {
  const nav = event.target.closest("[data-page]");
  if (nav) { go(nav.dataset.page); return; }
  const boardEnter = event.target.closest("[data-board-enter]");
  if (boardEnter) { openBoard(boardEnter.dataset.boardEnter); return; }
  const boardTab = event.target.closest("[data-board-tab]");
  if (boardTab) {
    view.boardCat = boardTab.dataset.boardTab || "all";
    view.limit = PAGE_SIZE;
    renderBoardBar();
    renderCatalog();
    return;
  }
  const boardNew = event.target.closest("[data-board-new]");
  if (boardNew) { createBoardCategory(currentBoardKey()); return; }
  const boardRename = event.target.closest("[data-board-rename]");
  if (boardRename) { renameBoardCategory(currentBoardKey(), boardRename.dataset.boardRename); return; }
  const boardDelete = event.target.closest("[data-board-delete]");
  if (boardDelete) { deleteBoardCategory(currentBoardKey(), boardDelete.dataset.boardDelete); return; }
  const goBtn = event.target.closest("[data-go]");
  if (goBtn) { go(goBtn.dataset.go); return; }
  const jump = event.target.closest("[data-jump-cat]");
  if (jump) {
    view.cat = jump.dataset.jumpCat;
    view.boardCat = "all";
    view.limit = PAGE_SIZE;
    go("catalog");
    setTimeout(() => { fillCategoryFilter(); renderBoardBar(); renderCatalog(); }, 60);
    return;
  }
  if (event.target.closest("select, input, textarea, label")) return;
  const action = event.target.closest("[data-action]");
  if (action) {
    const id = action.dataset.id;
    if (action.dataset.action === "owned") toggleOwned(id);
    if (action.dataset.action === "wish") toggleWish(id);
    if (action.dataset.action === "detail") openDetail(id);
    return;
  }
  const bookSetCard = event.target.closest("[data-book-set-open]");
  if (bookSetCard) { openBookSetDetail(bookSetCard.dataset.bookSetOpen); return; }
  const bookCard = event.target.closest("[data-book-open]");
  if (bookCard) { openBookDetail(bookCard.dataset.bookOpen); return; }
  const card = event.target.closest("[data-open]");
  if (card) openDetail(card.dataset.open);
}

function go(page) {
  location.hash = currentCharRoute(page);
  if (state.booted) setTimeout(() => { showPage(page); renderAll(); }, 20);
}

function showPage(page) {
  const map = { home: "home", catalog: "catalog", books: "books", owned: "owned", wishlist: "wishlist", progress: "progress" };
  const target = "page-" + (map[page] || "home");
  $$(".page").forEach((el) => el.classList.toggle("active", el.id === target));
  $$(".nav-link").forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  $("mainNav")?.classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* -------------------------------------------------------------------------- */
/* 路由                                                                       */
/* -------------------------------------------------------------------------- */

function currentCharRoute(page) {
  let w = state.currentWork, c = state.currentChar;
  if (!w || !c) {
    w = store.works[0];
    c = w?.characters?.[0];
  }
  if (!w || !c) return "#/";
  return page ? `#/w/${w.id}/c/${c.id}/${page}` : `#/w/${w.id}/c/${c.id}`;
}

function parseHash() {
  const m = location.hash.match(/^#\/w\/([^/]+)(?:\/c\/([^/]+))?(?:\/(\w+))?/);
  return m ? { workId: m[1], charId: m[2] || null, page: m[3] || "" } : null;
}

async function applyRoute() {
  if (!state.booted) return;
  const route = parseHash();
  const work = route ? (store.works.find((w) => w.id === route.workId) || store.works[0]) : store.works[0];
  const char = work ? (work.characters.find((c) => c.id === route?.charId) || work.characters[0]) : null;
  if (!work || !char) { showPage("home"); return; }
  state.currentWork = work;
  state.currentChar = char;
  view.limit = PAGE_SIZE;
  const [catKind, catKey] = String(view.cat || "").split(":");
  if (catKind === "main" && !store.mainCategories.some((c) => c.key === catKey)) view.cat = "";
  applyTheme(char);
  fillCategoryFilter();
  showPage(route ? (route.page || "home") : "home");
  renderAll();
}

function applyTheme(char) {
  const root = document.documentElement;
  Object.entries(char.theme || {}).forEach(([k, v]) => root.style.setProperty(k, v));
  const name = char.name || "";
  document.title = `${name}谷子图鉴 · 星愿收藏室`;
  $$(".hero-card-name").forEach((el) => { el.textContent = name; });
  const heroP = document.querySelector(".hero-copy p");
  if (heroP) heroP.textContent = `每一份心动都有自己的位置。欢迎来到专属于你的${name}收藏室。`;
}

function openBoard(boardKey) {
  view.cat = `board:${boardKey}`;
  view.boardCat = "all";
  view.limit = PAGE_SIZE;
  const target = currentCharRoute("catalog");
  if (location.hash === target) {
    fillCategoryFilter();
    renderBoardBar();
    showPage("catalog");
    renderCatalog();
  } else {
    location.hash = target;
  }
}

/* -------------------------------------------------------------------------- */
/* 联动 / 满赠分类                                                             */
/* -------------------------------------------------------------------------- */

function currentBoardKey() {
  if (view.cat === "board:collab") return "collab";
  if (view.cat === "board:gift") return "gift";
  return null;
}

function assignmentKey(boardKey, productId) {
  return `${boardKey}::${productId}`;
}

function boardCategories(boardKey) {
  return store.boardCategories[boardKey] || [];
}

function boardAssignment(boardKey, productId) {
  return store.assignments.get(assignmentKey(boardKey, productId)) || "";
}

function boardAssignHTML(product, boardKey) {
  const cats = boardCategories(boardKey);
  if (!cats.length) return `<div class="board-assign board-assign-empty"><span>归类</span><em>先新建分类后归类</em></div>`;
  const cur = boardAssignment(boardKey, product.id);
  return `<div class="board-assign"><span>归类</span><select data-assign="${safe(product.id)}" data-board="${safe(boardKey)}" aria-label="商品归类"><option value="">未分类</option>${cats.map((c) => `<option value="${safe(c.id)}"${c.id === cur ? " selected" : ""}>${safe(c.name)}</option>`).join("")}</select></div>`;
}

function renderBoardBar() {
  const el = $("boardBar");
  if (!el) return;
  const boardKey = currentBoardKey();
  if (!boardKey) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const cats = boardCategories(boardKey);
  if (view.boardCat !== "all" && view.boardCat !== "uncat" && !cats.some((c) => c.id === view.boardCat)) {
    view.boardCat = "all";
  }
  const items = store.products.filter((p) => p.boardKey === boardKey);
  const total = items.length;
  const uncat = items.filter((p) => !boardAssignment(boardKey, p.id)).length;
  const count = (catId) => items.filter((p) => boardAssignment(boardKey, p.id) === catId).length;
  const activeCat = cats.find((c) => c.id === view.boardCat);
  const newLabel = boardKey === "collab" ? "＋ 新建联动" : "＋ 新增类别";
  const tabs = [
    `<button class="board-tab ${view.boardCat === "all" ? "active" : ""}" data-board-tab="all">全部<span class="board-count">${total}</span></button>`,
    `<button class="board-tab board-new" data-board-new="1">${newLabel}</button>`,
    ...cats.map((c) => `<button class="board-tab ${view.boardCat === c.id ? "active" : ""}" data-board-tab="${safe(c.id)}">${safe(c.name)}<span class="board-count">${count(c.id)}</span></button>`),
    `<button class="board-tab board-uncat ${view.boardCat === "uncat" ? "active" : ""}" data-board-tab="uncat">未分类<span class="board-count">${uncat}</span></button>`
  ];
  const actions = activeCat
    ? `<div class="board-actions"><button class="board-action" data-board-rename="${safe(activeCat.id)}">重命名</button><button class="board-action danger" data-board-delete="${safe(activeCat.id)}">删除</button></div>`
    : "";
  const note = state.mode === "cloud"
    ? "分类与商品归属已同步到云端；删除分类会把商品转入未分类，不删除商品。"
    : "本地预览模式：分类与商品归属只保存在当前浏览器。";
  el.innerHTML = `<div class="board-bar-head">
    <div class="board-bar-title">${boardKey === "collab" ? "联动分类" : "满赠分类"}<small class="${state.mode === "cloud" ? "cloud-note" : ""}">${note}</small></div>
    ${actions}
  </div><div class="board-tabs">${tabs.join("")}</div>`;
  el.classList.remove("hidden");
}

function validateCategoryName(name, boardKey, excludeId = null) {
  if (!name) return "分类名称不能为空";
  if ([...name].length > 20) return "分类名称最多 20 个字符";
  if (BOARD_RESERVED_NAMES.has(name)) return "“全部”“未分类”为系统保留名称";
  if (boardCategories(boardKey).some((c) => c.id !== excludeId && c.name === name)) return "分类名称已存在";
  return null;
}

async function createBoardCategory(boardKey) {
  if (!boardKey) return;
  const label = boardKey === "collab" ? "联动" : "满赠";
  const name = await askText({ title: `新建${label}分类`, label: "分类名称", maxLength: 20, confirmLabel: "新建" });
  if (name === null) return;
  const trimmed = name.trim();
  const error = validateCategoryName(trimmed, boardKey);
  if (error) { toast(error, "warn"); return; }
  const maxOrder = Math.max(0, ...boardCategories(boardKey).map((c) => c.sortOrder || 0));
  const category = {
    id: newBoardCategoryId(), name: trimmed, boardKey, workId: "gyly", characterId: "xmx",
    sortOrder: maxOrder + 1, isDefault: false
  };
  try {
    await state.backend.createBoardCategory(category);
    await refreshData({ silent: true });
    view.boardCat = category.id;
    renderBoardBar();
    renderCatalog();
    toast(`已新建分类「${trimmed}」`, "success");
  } catch (e) {
    toastError(e, "新建分类失败");
  }
}

async function renameBoardCategory(boardKey, categoryId) {
  const cat = boardCategories(boardKey).find((c) => c.id === categoryId);
  if (!cat) return;
  const name = await askText({ title: "重命名分类", label: "分类名称", value: cat.name, maxLength: 20 });
  if (name === null) return;
  const trimmed = name.trim();
  const error = validateCategoryName(trimmed, boardKey, categoryId);
  if (error) { toast(error, "warn"); return; }
  if (trimmed === cat.name) return;
  try {
    await state.backend.updateBoardCategory(categoryId, { name: trimmed }, cat.revision || 1);
    await refreshData({ silent: true });
    toast(`已重命名为「${trimmed}」`, "success");
  } catch (e) {
    if (e.code === ERROR_CODES.CONFLICT || e.code === ERROR_CODES.DELETED) {
      await refreshData({ silent: true });
      toastError(e, "分类已被其他设备修改，已刷新");
    } else toastError(e, "重命名失败");
  }
}

async function deleteBoardCategory(boardKey, categoryId) {
  const cat = boardCategories(boardKey).find((c) => c.id === categoryId);
  if (!cat) return;
  const count = store.products.filter((p) => p.boardKey === boardKey && boardAssignment(boardKey, p.id) === categoryId).length;
  const ok = await confirmAction({
    title: `删除分类「${cat.name}」？`,
    message: `该分类下有 ${count} 件商品。删除分类不会删除商品，它们会转入“未分类”。`,
    confirmLabel: "继续删除",
    danger: true
  });
  if (!ok) return;
  const again = await confirmAction({
    title: "再次确认删除",
    message: `删除「${cat.name}」后不可恢复。商品与收藏不会被删除。`,
    confirmLabel: "确认删除",
    danger: true
  });
  if (!again) return;
  try {
    await state.backend.deleteBoardCategory(categoryId, cat.revision || 1);
    if (view.boardCat === categoryId) view.boardCat = "uncat";
    await refreshData({ silent: true });
    toast(`已删除分类「${cat.name}」，商品已转入未分类`, "success");
  } catch (e) {
    if (e.code === ERROR_CODES.CONFLICT || e.code === ERROR_CODES.DELETED) {
      await refreshData({ silent: true });
      toastError(e, "分类已被其他设备修改，已刷新");
    } else toastError(e, "删除分类失败");
  }
}

async function assignBoardProduct(productId, boardKey, categoryId) {
  if (!boardKey) return;
  try {
    await state.backend.setBoardAssignment(productId, boardKey, categoryId || null);
    if (categoryId) store.assignments.set(assignmentKey(boardKey, productId), categoryId);
    else store.assignments.delete(assignmentKey(boardKey, productId));
    renderBoardBar();
    renderCatalog();
    if ($("detailDialog")?.open) openDetail(productId);
    toast(categoryId ? "已归类" : "已移到未分类", "success");
  } catch (e) {
    toastError(e, "归类失败");
    await refreshData({ silent: true });
  }
}

/* -------------------------------------------------------------------------- */
/* 作品 / 角色管理                                                            */
/* -------------------------------------------------------------------------- */

function ensureWorksManager() {
  let dlg = $("worksManagerDialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "worksManagerDialog";
  dlg.className = "xmx-modal";
  dlg.innerHTML = `<div class="xmx-modal-inner">
    <div class="xmx-modal-head"><div><span class="eyebrow">WORKS & CHARACTERS</span><h2>作品与角色管理</h2>
      <p>新增、编辑、删除作品和角色；有商品关联时禁止删除。</p></div>
      <button class="close-btn" id="wmClose" aria-label="关闭">×</button></div>
    <div class="xmx-modal-body" id="wmBody"></div>
    <div class="xmx-modal-actions"><button class="outline-btn" id="wmAddWork">＋ 新增作品</button>
      <button class="primary-btn" id="wmDone">完成</button></div></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector("#wmClose").addEventListener("click", () => dlg.close());
  dlg.querySelector("#wmDone").addEventListener("click", () => dlg.close());
  dlg.querySelector("#wmAddWork").addEventListener("click", addWorkFromManager);
  dlg.querySelector("#wmBody").addEventListener("click", handleWorksManagerClick);
  return dlg;
}

function openWorksManager() {
  if (state.mode !== "cloud") { toast("作品/角色管理需要云端账号。", "warn"); return; }
  if (!store.v6Ready) { toast("V6 数据库尚未就绪，请先执行增量 Migration。", "warn", 5000); return; }
  const dlg = ensureWorksManager();
  renderWorksManager();
  if (!dlg.open) dlg.showModal();
}

function renderWorksManager() {
  const el = $("wmBody");
  if (!el) return;
  if (!store.works.length) {
    el.innerHTML = `<div class="empty-state"><div>✦</div><h3>还没有作品</h3><p>先新增一个作品，再添加角色。</p></div>`;
    return;
  }
  el.innerHTML = store.works.map((w) => `
    <div class="work-manage" data-work="${safe(w.id)}">
      <div class="work-manage-head">
        <div><b>${safe(w.title)}</b><small>${w.isBuiltin ? "内置作品" : "自定义作品"} · ${w.characters?.length || 0} 位角色</small></div>
        <div class="work-manage-actions">
          <button class="mini-btn" data-wm-action="work-open" data-work-id="${safe(w.id)}">查看</button>
          <button class="mini-btn" data-wm-action="work-edit" data-work-id="${safe(w.id)}">改名</button>
          <button class="mini-btn" data-wm-action="char-add" data-work-id="${safe(w.id)}">＋ 角色</button>
          ${w.isBuiltin ? "" : `<button class="mini-btn danger" data-wm-action="work-delete" data-work-id="${safe(w.id)}">删除作品</button>`}
        </div>
      </div>
      <div class="char-manage-list">
        ${(w.characters || []).map((c) => `
          <div class="char-manage-row">
            <span class="char-avatar" style="background:${safe(c.theme?.["--pink"] || "#e8b9c9")}">${safe((c.name || "?").slice(0, 1))}</span>
            <span><b>${safe(c.name)}</b><small>${countForCharacter(w.id, c.id)} 件商品</small></span>
            <span class="char-manage-actions">
              <button class="mini-btn" data-wm-action="char-edit" data-work-id="${safe(w.id)}" data-char-id="${safe(c.id)}">改名</button>
              ${c.isBuiltin ? "" : `<button class="mini-btn danger" data-wm-action="char-delete" data-work-id="${safe(w.id)}" data-char-id="${safe(c.id)}">删除角色</button>`}
            </span>
          </div>`).join("") || `<p class="form-hint">这个作品还没有角色。</p>`}
      </div>
    </div>`).join("");
}

function findWork(id) {
  return store.works.find((w) => w.id === id);
}

function findCharacter(work, id) {
  return work?.characters?.find((c) => c.id === id);
}

async function addWorkFromManager() {
  const title = await askText({ title: "新增作品", label: "作品名称", maxLength: 60, confirmLabel: "新增" });
  if (title === null) return;
  try {
    await state.backend.createWork({ title: title.trim(), sortOrder: store.works.length + 1 });
    await refreshData({ silent: true });
    renderWorksManager();
    toast("作品已新增", "success");
  } catch (e) { toastError(e, "新增作品失败"); }
}

async function handleWorksManagerClick(event) {
  const btn = event.target.closest("[data-wm-action]");
  if (!btn) return;
  const action = btn.dataset.wmAction;
  const work = findWork(btn.dataset.workId);
  if (!work) return;
  if (action === "work-open") {
    const first = work.characters?.[0];
    if (first) location.hash = `#/w/${work.id}/c/${first.id}/catalog`;
    $("worksManagerDialog")?.close();
    return;
  }
  if (action === "char-add") {
    const name = await askText({ title: `在「${work.title}」下新增角色`, label: "角色名称", maxLength: 40, confirmLabel: "新增" });
    if (name === null) return;
    try {
      await state.backend.createCharacter(work.id, { name: name.trim(), sortOrder: (work.characters?.length || 0) + 1 });
      await refreshData({ silent: true });
      renderWorksManager();
      toast("角色已新增", "success");
    } catch (e) { toastError(e, "新增角色失败"); }
    return;
  }
  if (action === "work-edit") {
    const title = await askText({ title: "修改作品名", label: "作品名称", value: work.title, maxLength: 60 });
    if (title === null || title.trim() === work.title) return;
    try {
      await state.backend.updateWork(work.id, { title: title.trim() }, work.revision);
      await refreshData({ silent: true });
      renderWorksManager();
      toast("作品已更新", "success");
    } catch (e) { toastError(e, "修改作品失败"); }
    return;
  }
  if (action === "work-delete") {
    try {
      const associations = await state.backend.getWorkAssociations(work.id);
      if (associations.characters > 0 || associations.products > 0) {
        toast(`该作品下还有 ${associations.characters} 位角色、${associations.products} 件商品，不能删除。请先处理关联。`, "warn", 6000);
        return;
      }
      const ok = await confirmAction({
        title: `删除作品「${work.title}」？`,
        message: "删除后可在回收站/备份中恢复；当前版本先做软删除。",
        confirmLabel: "删除作品", danger: true
      });
      if (!ok) return;
      await state.backend.deleteWork(work.id, work.revision);
      if (state.currentWork?.id === work.id) location.hash = "#/";
      await refreshData({ silent: true });
      renderWorksManager();
      toast("作品已删除", "success");
    } catch (e) { toastError(e, "删除作品失败"); }
    return;
  }
  if (action === "char-edit") {
    const char = findCharacter(work, btn.dataset.charId);
    if (!char) return;
    const name = await askText({ title: "修改角色名", label: "角色名称", value: char.name, maxLength: 40 });
    if (name === null || name.trim() === char.name) return;
    try {
      await state.backend.updateCharacter(work.id, char.id, { name: name.trim() }, char.revision);
      await refreshData({ silent: true });
      renderWorksManager();
      toast("角色已更新", "success");
    } catch (e) { toastError(e, "修改角色失败"); }
    return;
  }
  if (action === "char-delete") {
    const char = findCharacter(work, btn.dataset.charId);
    if (!char) return;
    try {
      const associations = await state.backend.getCharacterAssociations(work.id, char.id);
      if (associations.products > 0) {
        toast(`该角色下还有 ${associations.products} 件商品，不能删除。请先把商品改到其他角色。`, "warn", 6000);
        return;
      }
      const ok = await confirmAction({
        title: `删除角色「${char.name}」？`,
        message: "删除后可在回收站/备份中恢复；当前版本先做软删除。",
        confirmLabel: "删除角色", danger: true
      });
      if (!ok) return;
      await state.backend.deleteCharacter(work.id, char.id, char.revision);
      if (state.currentChar?.id === char.id && state.currentWork?.id === work.id) {
        const next = work.characters.find((c) => c.id !== char.id);
        location.hash = next ? `#/w/${work.id}/c/${next.id}/catalog` : "#/";
      }
      await refreshData({ silent: true });
      renderWorksManager();
      toast("角色已删除", "success");
    } catch (e) { toastError(e, "删除角色失败"); }
  }
}

/* -------------------------------------------------------------------------- */
/* 主分类管理（20 内置改名/排序 + 自定义分类）                                */
/* -------------------------------------------------------------------------- */

function ensureCategoryManager() {
  let dlg = $("categoryManagerDialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "categoryManagerDialog";
  dlg.className = "xmx-modal";
  dlg.innerHTML = `<div class="xmx-modal-inner">
    <div class="xmx-modal-head"><div><span class="eyebrow">CATEGORY MANAGER</span><h2>分类管理</h2>
      <p>20 个内置分类只能改名/排序；自定义分类可删除，删除前必须把商品重新归类。</p></div>
      <button class="close-btn" id="cmClose" aria-label="关闭">×</button></div>
    <div class="xmx-modal-body" id="cmBody"></div>
    <div class="xmx-modal-actions"><button class="outline-btn" id="cmAdd">＋ 新建自定义分类</button>
      <button class="primary-btn" id="cmDone">完成</button></div></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector("#cmClose").addEventListener("click", () => dlg.close());
  dlg.querySelector("#cmDone").addEventListener("click", () => dlg.close());
  dlg.querySelector("#cmAdd").addEventListener("click", addCustomCategory);
  dlg.querySelector("#cmBody").addEventListener("click", handleCategoryManagerClick);
  return dlg;
}

function openCategoryManager() {
  if (state.mode !== "cloud") { toast("分类管理需要云端账号。", "warn"); return; }
  if (!store.v6Ready) { toast("V6 数据库尚未就绪，请先执行增量 Migration。", "warn", 5000); return; }
  const dlg = ensureCategoryManager();
  renderCategoryManager();
  if (!dlg.open) dlg.showModal();
}

function renderCategoryManager() {
  const el = $("cmBody");
  if (!el) return;
  el.innerHTML = store.mainCategories.map((c, index) => `
    <div class="category-manage-row" data-cat="${safe(c.key)}">
      <span class="cat-order">${index + 1}</span>
      <span class="cat-name"><b>${safe(c.label)}</b><small>${c.isBuiltin ? "内置分类 · 不可删除" : "自定义分类"} · ${c.key}</small></span>
      <span class="cat-actions">
        <button class="mini-btn" data-cm-action="up" data-key="${safe(c.key)}" ${index === 0 ? "disabled" : ""}>↑</button>
        <button class="mini-btn" data-cm-action="down" data-key="${safe(c.key)}" ${index === store.mainCategories.length - 1 ? "disabled" : ""}>↓</button>
        <button class="mini-btn" data-cm-action="rename" data-key="${safe(c.key)}">改名</button>
        ${c.isBuiltin ? "" : `<button class="mini-btn danger" data-cm-action="delete" data-key="${safe(c.key)}">删除</button>`}
      </span>
    </div>`).join("");
}

function findCategory(key) {
  return store.mainCategories.find((c) => c.key === key);
}

async function addCustomCategory() {
  const label = await askText({ title: "新建自定义主分类", label: "分类名称", maxLength: 20, confirmLabel: "新建" });
  if (label === null) return;
  try {
    await state.backend.createCustomMainCategory({ label: label.trim(), sortOrder: store.mainCategories.length + 1 });
    await refreshData({ silent: true });
    renderCategoryManager();
    toast("自定义分类已新建", "success");
  } catch (e) { toastError(e, "新建分类失败"); }
}

async function persistCategoryOrder(sorted) {
  for (let i = 0; i < sorted.length; i += 1) {
    const c = sorted[i];
    if (c.isBuiltin) await state.backend.saveMainCategoryPref(c.key, { label: c.label, sortOrder: i + 1 });
    else await state.backend.updateCustomMainCategory(c.key, { sortOrder: i + 1 }, c.revision);
  }
}

async function moveCategory(key, delta) {
  const sorted = [...store.mainCategories];
  const index = sorted.findIndex((c) => c.key === key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= sorted.length) return;
  [sorted[index], sorted[target]] = [sorted[target], sorted[index]];
  try {
    await persistCategoryOrder(sorted);
    await refreshData({ silent: true });
    renderCategoryManager();
    toast("分类顺序已更新", "success");
  } catch (e) { toastError(e, "调整顺序失败"); }
}

async function renameCategory(key) {
  const c = findCategory(key);
  if (!c) return;
  const label = await askText({ title: "修改分类名称", label: "分类名称", value: c.label, maxLength: 20 });
  if (label === null || label.trim() === c.label) return;
  try {
    if (c.isBuiltin) await state.backend.saveMainCategoryPref(key, { label: label.trim(), sortOrder: c.sortOrder });
    else await state.backend.updateCustomMainCategory(key, { label: label.trim() }, c.revision);
    await refreshData({ silent: true });
    renderCategoryManager();
    toast("分类名称已更新", "success");
  } catch (e) { toastError(e, "修改分类失败"); }
}

async function deleteCategory(key) {
  const c = findCategory(key);
  if (!c || c.isBuiltin) return;
  try {
    const count = await state.backend.countProductsByMainCategory(key);
    if (count > 0) {
      openCategoryReassignDialog(c, count);
      return;
    }
    const ok = await confirmAction({
      title: `删除分类「${c.label}」？`,
      message: "当前没有商品使用这个分类。删除为软删除，可恢复。",
      confirmLabel: "删除分类", danger: true
    });
    if (!ok) return;
    await state.backend.deleteCustomMainCategory(key, c.revision);
    await refreshData({ silent: true });
    renderCategoryManager();
    toast("分类已删除", "success");
  } catch (e) { toastError(e, "删除分类失败"); }
}

function openCategoryReassignDialog(category, count) {
  let dlg = $("categoryReassignDialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "categoryReassignDialog";
    dlg.className = "xmx-modal";
    dlg.innerHTML = `<div class="xmx-modal-inner">
      <div class="xmx-modal-head"><div><span class="eyebrow">REASSIGN</span><h2>删除前重新归类</h2></div></div>
      <div class="xmx-modal-body" id="crBody"></div>
      <div class="xmx-modal-actions"><button class="outline-btn" id="crCancel">取消</button>
        <button class="primary-btn" id="crConfirm">重新归类并删除</button></div></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector("#crCancel").addEventListener("click", () => dlg.close());
  }
  $("crBody").innerHTML = `<p>分类「<b>${safe(category.label)}</b>」下有 <b>${count}</b> 件商品，必须先把它们移到另一个分类或“未分类”。</p>
    <label>目标分类<select id="crTarget">
      <option value="">未分类</option>
      ${store.mainCategories.filter((c) => c.key !== category.key).map((c) => `<option value="${safe(c.key)}">${safe(c.label)}</option>`).join("")}
    </select></label>`;
  const confirm = async () => {
    const targetKey = $("crTarget").value || null;
    const target = targetKey ? findCategory(targetKey) : null;
    try {
      if (count > 0) await state.backend.reassignProductsMainCategory(category.key, targetKey, target?.label || null);
      await state.backend.deleteCustomMainCategory(category.key, category.revision);
      dlg.close();
      await refreshData({ silent: true });
      renderCategoryManager();
      toast(`已把 ${count} 件商品移到「${target?.label || "未分类"}」，分类已删除`, "success", 5000);
    } catch (e) { toastError(e, "重新归类失败"); }
  };
  $("crConfirm").onclick = confirm;
  if (!dlg.open) dlg.showModal();
}

async function handleCategoryManagerClick(event) {
  const btn = event.target.closest("[data-cm-action]");
  if (!btn) return;
  const key = btn.dataset.key;
  if (btn.dataset.cmAction === "up") await moveCategory(key, -1);
  if (btn.dataset.cmAction === "down") await moveCategory(key, 1);
  if (btn.dataset.cmAction === "rename") await renameCategory(key);
  if (btn.dataset.cmAction === "delete") await deleteCategory(key);
}

/* -------------------------------------------------------------------------- */
/* 系列清单                                                                   */
/* -------------------------------------------------------------------------- */

function ensureSeriesManager() {
  let dlg = $("seriesManagerDialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "seriesManagerDialog";
  dlg.className = "xmx-modal";
  dlg.innerHTML = `<div class="xmx-modal-inner">
    <div class="xmx-modal-head"><div><span class="eyebrow">SERIES CHECKLIST</span><h2>系列全收集清单</h2>
      <p>可以关联已有商品，也可以手工补充官方款；已拥有按收藏状态计算。</p></div>
      <button class="close-btn" id="smClose" aria-label="关闭">×</button></div>
    <div class="xmx-modal-body" id="smBody"></div>
    <div class="xmx-modal-actions"><button class="outline-btn" id="smAddSeries">＋ 新建系列</button>
      <button class="primary-btn" id="smDone">完成</button></div></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector("#smClose").addEventListener("click", () => dlg.close());
  dlg.querySelector("#smDone").addEventListener("click", () => dlg.close());
  dlg.querySelector("#smAddSeries").addEventListener("click", addSeriesFromManager);
  dlg.querySelector("#smBody").addEventListener("click", handleSeriesManagerClick);
  dlg.querySelector("#smBody").addEventListener("change", handleSeriesStatusChange);
  return dlg;
}

function openSeriesManager() {
  if (state.mode !== "cloud") { toast("系列清单需要云端账号。", "warn"); return; }
  if (!store.v6Ready) { toast("V6 数据库尚未就绪，请先执行增量 Migration。", "warn", 5000); return; }
  const dlg = ensureSeriesManager();
  renderSeriesManager();
  if (!dlg.open) dlg.showModal();
}

function seriesProgress(series) {
  const items = store.seriesItems.filter((i) => i.seriesId === series.id);
  const statusMap = new Map((store.statusDefinitions || []).map((s) => [s.id, s]));
  const owned = items.filter((i) => {
    if (i.productId) return store.collections.has(i.productId);
    if (i.bookId) return (store.books || []).some((b) => b.id === i.bookId && statusMap.get(b.statusId)?.countsAsOwned);
    return statusMap.get(i.statusId)?.countsAsOwned;
  }).length;
  return { total: items.length, owned, rate: items.length ? Math.round((owned / items.length) * 100) : 0 };
}

function renderSeriesManager() {
  const el = $("smBody");
  if (!el) return;
  if (!store.series.length) {
    el.innerHTML = `<div class="empty-state"><div>✦</div><h3>还没有系列清单</h3><p>新建系列后，可以关联商品或手工补官方款。</p></div>`;
    return;
  }
  el.innerHTML = store.series.map((s) => {
    const progress = seriesProgress(s);
    const items = store.seriesItems.filter((i) => i.seriesId === s.id);
    const linked = new Set(items.map((i) => i.productId).filter(Boolean));
    const candidates = currentCharacterProducts().filter((p) => !linked.has(p.id)).slice(0, 200);
    return `<div class="series-manage" data-series="${safe(s.id)}">
      <div class="work-manage-head">
        <div><b>${safe(s.name)}</b><small>${progress.owned}/${progress.total} 已拥有 · ${progress.rate}%${s.totalExpected ? ` · 官方 ${s.totalExpected} 款` : ""}</small></div>
        <div class="work-manage-actions">
          <button class="mini-btn" data-sm-action="add-item" data-series-id="${safe(s.id)}">＋ 手工项</button>
          <button class="mini-btn" data-sm-action="delete-series" data-series-id="${safe(s.id)}">删除系列</button>
        </div>
      </div>
      <div class="series-progress-track"><span style="width:${progress.rate}%"></span></div>
      <div class="series-items">
        ${items.map((i) => {
          const product = i.productId ? store.productMap.get(i.productId) : null;
          const currentStatus = i.productId ? (store.collections.get(i.productId)?.statusId || "want") : (i.statusId || "want");
          return `<div class="series-item-row">
            <span>${product ? safe(product.name) : safe(i.displayName || i.officialNo || "未命名")}</span>
            <small>${product ? safe(product.productCode || product.id) : "手工项"}</small>
            <select data-sm-status data-item-id="${safe(i.id)}">
              ${(store.statusDefinitions.length ? store.statusDefinitions : []).map((st) => `<option value="${safe(st.id)}" ${st.id === currentStatus ? "selected" : ""}>${safe(st.label)}</option>`).join("")}
            </select>
            <button class="mini-btn danger" data-sm-action="delete-item" data-series-id="${safe(s.id)}" data-item-id="${safe(i.id)}">删除</button>
          </div>`;
        }).join("") || `<p class="form-hint">还没有清单项。</p>`}
      </div>
      <div class="series-link-row">
        <select data-series-product="${safe(s.id)}"><option value="">选择要关联的商品…</option>${candidates.map((p) => `<option value="${safe(p.id)}">${safe(p.name)} · ${safe(p.productCode || p.id)}</option>`).join("")}</select>
        <button class="mini-btn" data-sm-action="link-product" data-series-id="${safe(s.id)}">关联商品</button>
      </div>
    </div>`;
  }).join("");
}

async function addSeriesFromManager() {
  const name = await askText({ title: "新建系列", label: "系列名称", maxLength: 80, confirmLabel: "新建" });
  if (name === null) return;
  try {
    await state.backend.createSeries({
      name: name.trim(), type: "goods",
      workId: state.currentWork?.id || "gyly",
      characterId: state.currentChar?.id || "xmx",
      sortOrder: store.series.length + 1
    });
    await refreshData({ silent: true });
    renderSeriesManager();
    toast("系列已新建", "success");
  } catch (e) { toastError(e, "新建系列失败"); }
}

async function addSeriesItem(seriesId) {
  const name = await askText({ title: "新增清单项", label: "官方款/商品名", maxLength: 80, confirmLabel: "新增" });
  if (name === null) return;
  try {
    await state.backend.createSeriesItem({
      seriesId, entityType: "manual", displayName: name.trim(), statusId: "want",
      sortOrder: store.seriesItems.filter((i) => i.seriesId === seriesId).length + 1
    });
    await refreshData({ silent: true });
    renderSeriesManager();
    toast("清单项已新增", "success");
  } catch (e) { toastError(e, "新增清单项失败"); }
}

async function linkSeriesProduct(seriesId) {
  const select = document.querySelector(`[data-series-product="${CSS.escape(seriesId)}"]`);
  const productId = select?.value;
  if (!productId) { toast("请先选择商品。", "warn"); return; }
  const product = store.productMap.get(productId);
  try {
    await state.backend.createSeriesItem({
      seriesId, entityType: "product", productId, displayName: product?.name || productId,
      statusId: store.collections.get(productId)?.statusId || "want",
      sortOrder: store.seriesItems.filter((i) => i.seriesId === seriesId).length + 1
    });
    await refreshData({ silent: true });
    renderSeriesManager();
    toast("商品已加入系列清单", "success");
  } catch (e) { toastError(e, "关联商品失败"); }
}

async function handleSeriesManagerClick(event) {
  const btn = event.target.closest("[data-sm-action]");
  if (!btn) return;
  const seriesId = btn.dataset.seriesId;
  const itemId = btn.dataset.itemId;
  if (btn.dataset.smAction === "add-item") return addSeriesItem(seriesId);
  if (btn.dataset.smAction === "link-product") return linkSeriesProduct(seriesId);
  if (btn.dataset.smAction === "delete-item") {
    const item = store.seriesItems.find((i) => i.id === itemId);
    if (!item) return;
    const ok = await confirmAction({ title: "删除清单项？", message: "只删除清单项，不会删除商品或收藏。", confirmLabel: "删除", danger: true });
    if (!ok) return;
    try {
      await state.backend.deleteSeriesItem(itemId, item.revision);
      await refreshData({ silent: true });
      renderSeriesManager();
      toast("清单项已删除", "success");
    } catch (e) { toastError(e, "删除清单项失败"); }
    return;
  }
  if (btn.dataset.smAction === "delete-series") {
    const series = store.series.find((s) => s.id === seriesId);
    if (!series) return;
    const count = store.seriesItems.filter((i) => i.seriesId === seriesId).length;
    if (count > 0) { toast(`系列下还有 ${count} 个清单项，请先删除清单项。`, "warn"); return; }
    const ok = await confirmAction({ title: `删除系列「${series.name}」？`, message: "只删除系列，不影响商品/收藏。", confirmLabel: "删除系列", danger: true });
    if (!ok) return;
    try {
      await state.backend.deleteSeries(seriesId, series.revision);
      await refreshData({ silent: true });
      renderSeriesManager();
      toast("系列已删除", "success");
    } catch (e) { toastError(e, "删除系列失败"); }
  }
}

async function handleSeriesStatusChange(event) {
  const select = event.target.closest("[data-sm-status]");
  if (!select) return;
  const item = store.seriesItems.find((i) => i.id === select.dataset.itemId);
  if (!item) return;
  try {
    if (item.productId) {
      const entry = store.collections.get(item.productId);
      if (entry) await state.backend.updateCollection(item.productId, { statusId: select.value }, entry.revision);
      else await state.backend.addCollection(item.productId, { quantity: 1, statusId: select.value });
    } else {
      await state.backend.updateSeriesItem(item.id, { statusId: select.value }, item.revision);
    }
    await refreshData({ silent: true });
    renderSeriesManager();
  } catch (e) { toastError(e, "更新状态失败"); }
}

/* -------------------------------------------------------------------------- */
/* 书籍收藏                                                                   */
/* -------------------------------------------------------------------------- */

function bookTypeLabel(id) {
  return store.bookTypes.find((t) => t.id === id)?.label || "未分类";
}

function bookStatusLabel(id) {
  return store.statusDefinitions.find((s) => s.id === id)?.label || "想要";
}

function bookStatusCountsAsOwned(id) {
  return Boolean(store.statusDefinitions.find((s) => s.id === id)?.countsAsOwned);
}

function bookSetTitle(setId) {
  return store.bookSets.find((s) => s.id === setId)?.title || "";
}

function renderBooks() {
  const grid = $("bookGrid");
  if (!grid) return;
  const typeSel = $("bookTypeFilter");
  const statusSel = $("bookStatusFilter");
  const types = store.bookTypes;
  const statuses = store.statusDefinitions;
  if (typeSel) {
    const current = typeSel.value;
    typeSel.innerHTML = `<option value="">全部类型</option>` + types.map((t) => `<option value="${safe(t.id)}">${safe(t.label)}</option>`).join("");
    typeSel.value = current;
  }
  if (statusSel) {
    const current = statusSel.value;
    statusSel.innerHTML = `<option value="">全部状态</option>` + statuses.map((s) => `<option value="${safe(s.id)}">${safe(s.label)}</option>`).join("");
    statusSel.value = current;
  }
  const q = ($("bookSearch")?.value || "").trim().toLowerCase();
  const type = typeSel?.value || "";
  const status = statusSel?.value || "";
  const books = store.books.filter((b) => {
    if (type && b.bookTypeId !== type) return false;
    if (status && b.statusId !== status) return false;
    if (q) {
      const hay = [b.title, b.subtitle, b.author, b.illustrator, b.publisher, b.isbn, b.language, b.edition, b.binding, b.notes, bookTypeLabel(b.bookTypeId), bookSetTitle(b.setId)]
        .join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const sets = store.bookSets.filter((s) => {
    if (type && s.bookTypeId !== type) return false;
    if (q && ![s.title, s.language, s.publisher, s.edition, s.binding].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });
  $("bookSetGrid").innerHTML = sets.map((s) => {
    const volumes = store.books.filter((b) => b.setId === s.id);
    const progress = bookSetProgress(s, volumes, statuses);
    return `<article class="product-card" data-book-set-open="${safe(s.id)}">
      <div class="product-image book-cover"><span class="book-cover-icon">▤</span><span class="product-tag">套书</span></div>
      <div class="product-info"><h3>${safe(s.title)}</h3>
        <div class="product-meta">${safe([s.language, s.publisher, s.edition, s.binding].filter(Boolean).join(" · ") || "未填写版本")}</div>
        <div class="book-progress"><span style="width:${progress.rate}%"></span></div>
        <div class="product-price">${progress.ownedVolumes}/${progress.totalVolumes} 卷 · ${progress.rate}%</div>
        <div class="market-line">缺失：${safe(progress.missingVolumes.slice(0, 8).join("、") || "无")}${progress.missingVolumes.length > 8 ? "…" : ""}</div>
      </div>
      <div class="card-actions"><button class="mini-btn" data-book-set-open="${safe(s.id)}">查看套书</button></div>
    </article>`;
  }).join("");
  $("bookGrid").innerHTML = books.map((b) => {
    const owned = bookStatusCountsAsOwned(b.statusId);
    return `<article class="product-card" data-book-open="${safe(b.id)}">
      <div class="product-image book-cover"><span class="book-cover-icon">${owned ? "✓" : "▤"}</span>
        <span class="${owned ? "product-tag" : "pending-tag"}">${safe(bookStatusLabel(b.statusId))}</span></div>
      <div class="product-info"><h3>${safe(b.title)}</h3>
        <div class="product-meta">${safe([b.volumeLabel || (b.volumeNumber != null ? `第${b.volumeNumber}卷` : ""), b.language, b.publisher, b.edition, b.binding].filter(Boolean).join(" · ") || "未填写版本")}</div>
        <div class="product-price">${b.marketPrice != null ? `市价 ${formatShortMoney(b.marketPrice)}` : "未填市场价"}${b.purchasePrice != null ? ` · 购入 ${formatShortMoney(b.purchasePrice)}` : ""}</div>
        <div class="market-line">${safe(bookTypeLabel(b.bookTypeId))}${b.isbn ? ` · ISBN ${safe(b.isbn)}` : ""}${b.setId ? ` · ${safe(bookSetTitle(b.setId))}` : ""}</div>
      </div>
      <div class="card-actions"><button class="mini-btn" data-book-open="${safe(b.id)}">查看</button></div>
    </article>`;
  }).join("");
  const total = books.length + sets.length;
  $("bookResultCount").textContent = `${books.length} 本书 · ${sets.length} 套书`;
  $("bookEmpty").classList.toggle("hidden", total > 0);
}

function ensureBookForm() {
  let dlg = $("bookFormDialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "bookFormDialog";
  dlg.className = "xmx-modal";
  dlg.innerHTML = `<form id="bookForm" class="xmx-modal-inner" novalidate>
    <div class="xmx-modal-head"><div><span class="eyebrow">BOOK EDITOR</span><h2 id="bookFormTitle">添加书籍</h2>
      <p>单本可不选套书；套书逐卷记录。</p></div><button type="button" class="close-btn" id="bookFormClose">×</button></div>
    <div class="xmx-modal-body"><div id="bookFormError" class="form-error hidden"></div>
      <div class="form-grid-2">
        <label class="wide">书名 *<input id="bfTitle" maxlength="160"></label>
        <label>所属套书<select id="bfSet"><option value="">独立单本</option></select></label>
        <label>书籍类型<select id="bfType"></select></label>
        <label>作者<input id="bfAuthor" maxlength="80"></label>
        <label>编绘<input id="bfIllustrator" maxlength="80"></label>
        <label>出版社<input id="bfPublisher" maxlength="80"></label>
        <label>语言/版本<input id="bfLanguage" maxlength="40" placeholder="简体/繁体/日文"></label>
        <label>版次<input id="bfEdition" maxlength="40" placeholder="初版/再版/特装"></label>
        <label>装帧<input id="bfBinding" maxlength="40" placeholder="平装/精装/盒装"></label>
        <label>卷标签<input id="bfVolumeLabel" maxlength="40" placeholder="第1卷/番外"></label>
        <label>卷号<input id="bfVolumeNumber" type="number" step="0.1"></label>
        <label>ISBN<input id="bfIsbn" maxlength="40"></label>
        <label>收藏状态<select id="bfStatus"></select></label>
        <label>市场价格<input id="bfMarketPrice" type="number" min="0" step="0.01"></label>
        <label>市场价记录日期<input id="bfMarketDate" type="date"></label>
        <label>实际购买价<input id="bfPurchasePrice" type="number" min="0" step="0.01"></label>
        <label>购买日期<input id="bfPurchaseDate" type="date"></label>
        <label>购买渠道<input id="bfChannel" maxlength="60"></label>
        <label class="wide">备注<textarea id="bfNotes" rows="3" maxlength="500"></textarea></label>
      </div></div>
    <div class="xmx-modal-actions"><button type="button" class="ghost-danger hidden" id="bfDelete">删除书籍</button>
      <span class="left"></span><button type="button" class="outline-btn" id="bfCancel">取消</button>
      <button type="submit" class="primary-btn" id="bfSave">保存书籍</button></div></form>`;
  document.body.appendChild(dlg);
  dlg.querySelector("#bookFormClose").addEventListener("click", () => dlg.close());
  dlg.querySelector("#bfCancel").addEventListener("click", () => dlg.close());
  dlg.querySelector("#bookForm").addEventListener("submit", saveBookForm);
  dlg.querySelector("#bfDelete").addEventListener("click", async () => {
    const book = dlg._book;
    if (!book) return;
    const ok = await confirmAction({ title: `删除「${book.title}」？`, message: "关联订单时不能删除；删除为软删除。", confirmLabel: "删除书籍", danger: true });
    if (!ok) return;
    try {
      await state.backend.deleteBook(book.id, book.revision);
      dlg.close();
      await refreshData({ silent: true });
      renderBooks();
      toast("书籍已删除", "success");
    } catch (e) { toastError(e, "删除书籍失败"); }
  });
  return dlg;
}

function openBookForm(book = null, setId = null) {
  if (state.mode !== "cloud") { toast("书籍管理需要云端账号。", "warn"); return; }
  if (!store.v6Ready) { toast("V6 数据库尚未就绪，请先执行增量 Migration。", "warn"); return; }
  const dlg = ensureBookForm();
  dlg._book = book;
  $("bookFormTitle").textContent = book ? "编辑书籍" : "添加书籍";
  $("bfDelete").classList.toggle("hidden", !book);
  $("bfSet").innerHTML = `<option value="">独立单本</option>` + store.bookSets.map((s) => `<option value="${safe(s.id)}">${safe(s.title)}</option>`).join("");
  $("bfSet").value = book?.setId || setId || "";
  $("bfType").innerHTML = store.bookTypes.map((t) => `<option value="${safe(t.id)}">${safe(t.label)}</option>`).join("");
  $("bfType").value = book?.bookTypeId || store.bookTypes[0]?.id || "";
  $("bfStatus").innerHTML = store.statusDefinitions.map((s) => `<option value="${safe(s.id)}">${safe(s.label)}</option>`).join("");
  $("bfStatus").value = book?.statusId || "want";
  $("bfTitle").value = book?.title || "";
  $("bfAuthor").value = book?.author || "";
  $("bfIllustrator").value = book?.illustrator || "";
  $("bfPublisher").value = book?.publisher || "";
  $("bfLanguage").value = book?.language || "";
  $("bfEdition").value = book?.edition || "";
  $("bfBinding").value = book?.binding || "";
  $("bfVolumeLabel").value = book?.volumeLabel || "";
  $("bfVolumeNumber").value = book?.volumeNumber ?? "";
  $("bfIsbn").value = book?.isbn || "";
  $("bfMarketPrice").value = book?.marketPrice ?? "";
  $("bfMarketDate").value = book?.marketPriceDate || "";
  $("bfPurchasePrice").value = book?.purchasePrice ?? "";
  $("bfPurchaseDate").value = book?.purchaseDate || "";
  $("bfChannel").value = book?.purchaseChannel || "";
  $("bfNotes").value = book?.notes || "";
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $("bfTitle")?.focus(), 80);
}

async function saveBookForm(event) {
  event.preventDefault();
  const dlg = $("bookFormDialog");
  const existing = dlg._book;
  const title = $("bfTitle").value.trim();
  if (!title) { $("bookFormError").textContent = "请填写书名。"; $("bookFormError").classList.remove("hidden"); return; }
  const book = {
    id: existing?.id,
    setId: $("bfSet").value || null,
    bookTypeId: $("bfType").value || null,
    title,
    author: $("bfAuthor").value.trim(),
    illustrator: $("bfIllustrator").value.trim(),
    publisher: $("bfPublisher").value.trim(),
    language: $("bfLanguage").value.trim(),
    edition: $("bfEdition").value.trim(),
    binding: $("bfBinding").value.trim(),
    volumeLabel: $("bfVolumeLabel").value.trim(),
    volumeNumber: $("bfVolumeNumber").value,
    isbn: $("bfIsbn").value.trim(),
    statusId: $("bfStatus").value,
    marketPrice: $("bfMarketPrice").value,
    marketPriceDate: $("bfMarketDate").value || null,
    purchasePrice: $("bfPurchasePrice").value,
    purchaseDate: $("bfPurchaseDate").value || null,
    purchaseChannel: $("bfChannel").value.trim(),
    notes: $("bfNotes").value.trim(),
    quantity: existing?.quantity || 1
  };
  try {
    if (existing) await state.backend.updateBook(existing.id, book, existing.revision);
    else await state.backend.createBook(book);
    dlg.close();
    await refreshData({ silent: true });
    renderBooks();
    toast(existing ? "书籍已更新" : "书籍已新增", "success");
  } catch (e) { toastError(e, "保存书籍失败"); }
}

function ensureBookSetForm() {
  let dlg = $("bookSetFormDialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "bookSetFormDialog";
  dlg.className = "xmx-modal";
  dlg.innerHTML = `<form id="bookSetForm" class="xmx-modal-inner" novalidate>
    <div class="xmx-modal-head"><div><span class="eyebrow">SET EDITOR</span><h2 id="bookSetFormTitle">新建套书</h2></div>
      <button type="button" class="close-btn" id="bsfClose">×</button></div>
    <div class="xmx-modal-body"><div id="bookSetFormError" class="form-error hidden"></div>
      <div class="form-grid-2">
        <label class="wide">套书名 *<input id="bsfTitle" maxlength="120"></label>
        <label>书籍类型<select id="bsfType"></select></label>
        <label>语言/版本<input id="bsfLanguage" maxlength="40"></label>
        <label>出版社<input id="bsfPublisher" maxlength="80"></label>
        <label>版次<input id="bsfEdition" maxlength="40"></label>
        <label>装帧<input id="bsfBinding" maxlength="40"></label>
        <label>总卷数<input id="bsfTotal" type="number" min="1" step="1"></label>
        <label class="wide">说明<textarea id="bsfDescription" rows="3" maxlength="500"></textarea></label>
      </div></div>
    <div class="xmx-modal-actions"><button type="button" class="outline-btn" id="bsfCancel">取消</button>
      <button type="submit" class="primary-btn" id="bsfSave">保存套书</button></div></form>`;
  document.body.appendChild(dlg);
  dlg.querySelector("#bsfClose").addEventListener("click", () => dlg.close());
  dlg.querySelector("#bsfCancel").addEventListener("click", () => dlg.close());
  dlg.querySelector("#bookSetForm").addEventListener("submit", saveBookSetForm);
  return dlg;
}

function openBookSetForm(set = null) {
  if (state.mode !== "cloud") { toast("套书管理需要云端账号。", "warn"); return; }
  if (!store.v6Ready) { toast("V6 数据库尚未就绪，请先执行增量 Migration。", "warn"); return; }
  const dlg = ensureBookSetForm();
  dlg._set = set;
  $("bookSetFormTitle").textContent = set ? "编辑套书" : "新建套书";
  $("bsfType").innerHTML = store.bookTypes.map((t) => `<option value="${safe(t.id)}">${safe(t.label)}</option>`).join("");
  $("bsfType").value = set?.bookTypeId || store.bookTypes[0]?.id || "";
  $("bsfTitle").value = set?.title || "";
  $("bsfLanguage").value = set?.language || "";
  $("bsfPublisher").value = set?.publisher || "";
  $("bsfEdition").value = set?.edition || "";
  $("bsfBinding").value = set?.binding || "";
  $("bsfTotal").value = set?.totalVolumes ?? "";
  $("bsfDescription").value = set?.description || "";
  if (!dlg.open) dlg.showModal();
}

async function saveBookSetForm(event) {
  event.preventDefault();
  const dlg = $("bookSetFormDialog");
  const existing = dlg._set;
  const title = $("bsfTitle").value.trim();
  if (!title) { $("bookSetFormError").textContent = "请填写套书名。"; $("bookSetFormError").classList.remove("hidden"); return; }
  const set = {
    id: existing?.id,
    title,
    bookTypeId: $("bsfType").value || null,
    language: $("bsfLanguage").value.trim(),
    publisher: $("bsfPublisher").value.trim(),
    edition: $("bsfEdition").value.trim(),
    binding: $("bsfBinding").value.trim(),
    totalVolumes: $("bsfTotal").value || null,
    description: $("bsfDescription").value.trim()
  };
  try {
    if (existing) await state.backend.updateBookSet(existing.id, set, existing.revision);
    else await state.backend.createBookSet(set);
    dlg.close();
    await refreshData({ silent: true });
    renderBooks();
    toast(existing ? "套书已更新" : "套书已新建", "success");
  } catch (e) { toastError(e, "保存套书失败"); }
}

function openBookDetail(id) {
  const book = store.books.find((b) => b.id === id);
  if (!book) return;
  let dlg = $("bookDetailDialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "bookDetailDialog";
    dlg.className = "xmx-modal";
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = `<div class="xmx-modal-inner">
    <div class="xmx-modal-head"><div><span class="eyebrow">BOOK DETAIL</span><h2>${safe(book.title)}</h2></div>
      <button class="close-btn" id="bookDetailClose">×</button></div>
    <div class="xmx-modal-body">
      <div class="detail-price-grid">
        <div class="price-box"><small>市场价格</small><b>${book.marketPrice != null ? formatMoney(book.marketPrice) : "未填写"}</b><em>${book.marketPriceDate ? `记录：${safe(book.marketPriceDate)}` : "记录日期为空"}</em></div>
        <div class="price-box purchase"><small>实际购买价</small><b>${book.purchasePrice != null ? formatMoney(book.purchasePrice) : "未填写"}</b><em>${book.purchaseDate ? `购买：${safe(book.purchaseDate)}` : "购买日期为空"}</em></div>
      </div>
      <div class="detail-fields">
        ${[
          ["状态", bookStatusLabel(book.statusId)],
          ["类型", bookTypeLabel(book.bookTypeId)],
          ["套书", bookSetTitle(book.setId) || "独立单本"],
          ["卷", book.volumeLabel || (book.volumeNumber != null ? `第${book.volumeNumber}卷` : "—")],
          ["作者", book.author || "—"],
          ["编绘", book.illustrator || "—"],
          ["出版社", book.publisher || "—"],
          ["语言/版本", book.language || "—"],
          ["版次", book.edition || "—"],
          ["装帧", book.binding || "—"],
          ["ISBN", book.isbn || "—"],
          ["数量", `${book.quantity} 本`],
          ["备注", book.notes || "—"]
        ].map(([k, v]) => `<div class="field"><span>${safe(k)}</span><b>${safe(v)}</b></div>`).join("")}
      </div>
    </div>
    <div class="xmx-modal-actions"><button class="mini-btn" id="bookDetailEdit">✎ 编辑</button>
      <button class="ghost-danger" id="bookDetailDelete">删除书籍</button>
      <span class="left"></span><button class="primary-btn" id="bookDetailDone">完成</button></div></div>`;
  dlg.querySelector("#bookDetailClose").addEventListener("click", () => dlg.close());
  dlg.querySelector("#bookDetailDone").addEventListener("click", () => dlg.close());
  dlg.querySelector("#bookDetailEdit").addEventListener("click", () => { dlg.close(); openBookForm(book); });
  dlg.querySelector("#bookDetailDelete").addEventListener("click", async () => {
    const ok = await confirmAction({ title: `删除「${book.title}」？`, message: "关联订单时不能删除；删除为软删除。", confirmLabel: "删除书籍", danger: true });
    if (!ok) return;
    try {
      await state.backend.deleteBook(book.id, book.revision);
      dlg.close();
      await refreshData({ silent: true });
      renderBooks();
      toast("书籍已删除", "success");
    } catch (e) { toastError(e, "删除书籍失败"); }
  });
  if (!dlg.open) dlg.showModal();
}

function openBookSetDetail(id) {
  const set = store.bookSets.find((s) => s.id === id);
  if (!set) return;
  const volumes = store.books.filter((b) => b.setId === id);
  const progress = bookSetProgress(set, volumes, store.statusDefinitions);
  let dlg = $("bookSetDetailDialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "bookSetDetailDialog";
    dlg.className = "xmx-modal";
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = `<div class="xmx-modal-inner">
    <div class="xmx-modal-head"><div><span class="eyebrow">SET DETAIL</span><h2>${safe(set.title)}</h2>
      <p>${safe([set.language, set.publisher, set.edition, set.binding].filter(Boolean).join(" · ") || "未填写版本")}</p></div>
      <button class="close-btn" id="bookSetDetailClose">×</button></div>
    <div class="xmx-modal-body">
      <div class="backup-stats"><div class="backup-stat"><small>应有卷数</small><b>${progress.totalVolumes}</b></div>
        <div class="backup-stat"><small>已拥有</small><b>${progress.ownedVolumes}</b></div>
        <div class="backup-stat"><small>完成率</small><b>${progress.rate}%</b></div>
        <div class="backup-stat"><small>缺卷</small><b>${progress.missingVolumes.length}</b></div></div>
      <p class="form-hint">缺卷：${safe(progress.missingVolumes.join("、") || "无")}</p>
      <div class="series-items">${volumes.map((b) => `<div class="series-item-row"><span>${safe(b.volumeLabel || b.title)}</span><small>${safe(bookStatusLabel(b.statusId))}</small><span>${b.purchasePrice != null ? formatShortMoney(b.purchasePrice) : ""}</span><button class="mini-btn" data-book-open="${safe(b.id)}">查看</button></div>`).join("") || `<p class="form-hint">还没有卷。</p>`}</div>
    </div>
    <div class="xmx-modal-actions"><button class="mini-btn" id="bookSetAddVolume">＋ 添加卷</button>
      <button class="mini-btn" id="bookSetEdit">✎ 编辑套书</button>
      <button class="ghost-danger" id="bookSetDelete">删除套书</button>
      <span class="left"></span><button class="primary-btn" id="bookSetDone">完成</button></div></div>`;
  dlg.querySelector("#bookSetDetailClose").addEventListener("click", () => dlg.close());
  dlg.querySelector("#bookSetDone").addEventListener("click", () => dlg.close());
  dlg.querySelector("#bookSetAddVolume").addEventListener("click", () => { dlg.close(); openBookForm(null, set.id); });
  dlg.querySelector("#bookSetEdit").addEventListener("click", () => { dlg.close(); openBookSetForm(set); });
  dlg.querySelector("#bookSetDelete").addEventListener("click", async () => {
    try {
      await state.backend.deleteBookSet(set.id, set.revision);
      dlg.close();
      await refreshData({ silent: true });
      renderBooks();
      toast("套书已删除", "success");
    } catch (e) { toastError(e, "删除套书失败"); }
  });
  if (!dlg.open) dlg.showModal();
}

function openBookTypeManager() {
  if (state.mode !== "cloud" || !store.v6Ready) { toast("书籍类型管理需要 V6 云端数据库。", "warn"); return; }
  let dlg = $("bookTypeDialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "bookTypeDialog";
    dlg.className = "xmx-modal";
    dlg.innerHTML = `<div class="xmx-modal-inner"><div class="xmx-modal-head"><div><span class="eyebrow">BOOK TYPES</span><h2>书籍类型</h2></div>
      <button class="close-btn" id="bookTypeClose">×</button></div><div class="xmx-modal-body" id="bookTypeBody"></div>
      <div class="xmx-modal-actions"><button class="outline-btn" id="bookTypeAdd">＋ 新增类型</button><button class="primary-btn" id="bookTypeDone">完成</button></div></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector("#bookTypeClose").addEventListener("click", () => dlg.close());
    dlg.querySelector("#bookTypeDone").addEventListener("click", () => dlg.close());
    dlg.querySelector("#bookTypeAdd").addEventListener("click", async () => {
      const label = await askText({ title: "新增书籍类型", label: "类型名称", maxLength: 20 });
      if (label === null) return;
      try {
        await state.backend.createBookType({ label: label.trim(), sortOrder: store.bookTypes.length + 1 });
        await refreshData({ silent: true });
        renderBookTypeManager();
        toast("书籍类型已新增", "success");
      } catch (e) { toastError(e, "新增类型失败"); }
    });
    dlg.querySelector("#bookTypeBody").addEventListener("click", async (event) => {
      const btn = event.target.closest("[data-book-type-action]");
      if (!btn) return;
      const type = store.bookTypes.find((t) => t.id === btn.dataset.id);
      if (!type) return;
      if (btn.dataset.bookTypeAction === "rename") {
        const label = await askText({ title: "修改书籍类型", label: "类型名称", value: type.label, maxLength: 20 });
        if (label === null || label.trim() === type.label) return;
        try {
          await state.backend.updateBookType(type.id, { label: label.trim() }, type.revision);
          await refreshData({ silent: true }); renderBookTypeManager(); toast("类型已更新", "success");
        } catch (e) { toastError(e, "修改类型失败"); }
      }
      if (btn.dataset.bookTypeAction === "delete") {
        const ok = await confirmAction({ title: `删除类型「${type.label}」？`, message: "有书籍使用该类型时不能删除。", confirmLabel: "删除类型", danger: true });
        if (!ok) return;
        try {
          await state.backend.deleteBookType(type.id, type.revision);
          await refreshData({ silent: true }); renderBookTypeManager(); toast("类型已删除", "success");
        } catch (e) { toastError(e, "删除类型失败"); }
      }
    });
  }
  renderBookTypeManager();
  if (!dlg.open) dlg.showModal();
}

function renderBookTypeManager() {
  $("bookTypeBody").innerHTML = store.bookTypes.map((t) => `<div class="category-manage-row">
    <span class="cat-name"><b>${safe(t.label)}</b><small>${store.books.filter((b) => b.bookTypeId === t.id).length} 本书</small></span>
    <span class="cat-actions"><button class="mini-btn" data-book-type-action="rename" data-id="${safe(t.id)}">改名</button>
      <button class="mini-btn danger" data-book-type-action="delete" data-id="${safe(t.id)}">删除</button></span></div>`).join("");
}

/* -------------------------------------------------------------------------- */
/* 收藏 / 愿望                                                                */
/* -------------------------------------------------------------------------- */

async function toggleOwned(id) {
  const entry = store.collections.get(id);
  if (entry) {
    const hasInfo = entry.purchasePrice != null || entry.note || entry.purchaseDate;
    if (hasInfo) {
      const ok = await confirmAction({
        title: "从收藏中移除？",
        message: "这条收藏包含购入价格或备注，移除后这些记录也会从云端删除。",
        confirmLabel: "移除收藏",
        danger: true
      });
      if (!ok) return;
    }
    await removeCollection(id);
  } else {
    try {
      await state.backend.addCollection(id, { quantity: 1 });
      if (store.wishlist.has(id)) {
        await state.backend.deleteWishlist(id);
        store.wishlist.delete(id);
      }
      await refreshData({ silent: true });
      toast("已加入我的收藏", "success");
    } catch (e) {
      toastError(e, "加入收藏失败");
    }
  }
}

async function removeCollection(id, expectedRevision = null) {
  const entry = store.collections.get(id);
  try {
    await state.backend.deleteCollection(id, expectedRevision ?? entry?.revision);
    await refreshData({ silent: true });
    toast("已从收藏中移除", "success");
  } catch (e) {
    if (e.code === ERROR_CODES.CONFLICT && e.current) {
      await resolveCollectionConflict(e.current, { productId: id }, "delete");
    } else toastError(e, "移除收藏失败");
  }
}

async function toggleWish(id) {
  try {
    if (store.wishlist.has(id)) {
      await state.backend.deleteWishlist(id);
      store.wishlist.delete(id);
      toast("已移出愿望清单", "success");
    } else {
      await state.backend.addWishlist(id);
      store.wishlist.add(id);
      toast("已加入愿望清单", "success");
    }
    await refreshData({ silent: true });
  } catch (e) {
    toastError(e, "愿望清单操作失败");
  }
}

async function saveCollection(productId, values) {
  const entry = store.collections.get(productId);
  const patch = {
    quantity: Math.max(1, Number(values.quantity) || 1),
    purchasePrice: parseNumberOrNull(values.purchasePrice),
    purchaseDate: normalizeDate(values.purchaseDate) || "",
    note: values.note || ""
  };
  try {
    if (entry) {
      await state.backend.updateCollection(productId, patch, entry.revision);
    } else {
      await state.backend.addCollection(productId, patch);
      if (store.wishlist.has(productId)) {
        await state.backend.deleteWishlist(productId);
        store.wishlist.delete(productId);
      }
    }
    await refreshData({ silent: true });
    if ($("detailDialog")?.open) openDetail(productId);
    toast(entry ? "收藏信息已保存" : "已加入我的收藏", "success");
  } catch (e) {
    if (e.code === ERROR_CODES.CONFLICT && e.current) {
      await resolveCollectionConflict(e.current, { productId, patch }, entry ? "update" : "add");
    } else if (e.code === ERROR_CODES.DUPLICATE) {
      await refreshData({ silent: true });
      toast("这件商品已经在收藏中，已刷新为最新数据", "warn");
    } else toastError(e, "保存收藏信息失败");
  }
}

async function resolveCollectionConflict(current, local, mode, after = null) {
  await showConflictDialog({
    title: "收藏信息在其他设备被修改",
    current,
    local: local.patch || {},
    fields: [
      { key: "quantity", label: "拥有数量", format: (v) => `${v ?? 1} 件` },
      { key: "purchasePrice", label: "实际购买价", format: (v) => formatMoney(v) },
      { key: "purchaseDate", label: "购买日期", format: (v) => v || "—" },
      { key: "note", label: "备注", format: (v) => v || "—" }
    ],
    onUseCloud: async () => {
      await refreshData({ silent: true });
      if ($("detailDialog")?.open) openDetail(current.productId || local.productId);
      after?.(false);
    },
    onKeepMine: async () => {
      const patch = {
        quantity: Math.max(1, Number(local.patch?.quantity) || 1),
        purchasePrice: local.patch?.purchasePrice ?? null,
        purchaseDate: local.patch?.purchaseDate || "",
        note: local.patch?.note || ""
      };
      if (mode === "delete") await state.backend.deleteCollection(local.productId, current.revision);
      else await state.backend.updateCollection(local.productId, patch, current.revision);
      await refreshData({ silent: true });
      if ($("detailDialog")?.open) openDetail(local.productId);
      after?.(true);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 商品详情                                                                   */
/* -------------------------------------------------------------------------- */

function ensureDetailDialog() {
  if ($("detailDialog")) return;
  const el = document.createElement("dialog");
  el.id = "detailDialog";
  el.className = "xmx-modal detail-modal";
  el.innerHTML = `<div class="detail-wrap">
    <button class="close-btn" id="detailClose" aria-label="关闭">×</button>
    <div class="detail-image" id="detailImage"></div>
    <div class="detail-body">
      <div class="eyebrow">PRODUCT DETAIL</div>
      <h2 id="detailName"></h2>
      <div id="detailMeta" class="detail-meta"></div>
      <div id="detailBoardAssign" class="detail-board-assign"></div>
      <div id="detailPriceCards" class="detail-price-grid"></div>
      <div id="detailNote"></div>
      <div id="detailFields" class="detail-fields"></div>
      <div class="detail-own" id="detailOwn"></div>
      <div class="detail-actions" id="detailActions"></div>
      <div class="form-hint" id="detailUpdated"></div>
    </div></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (e) => { if (e.target === el) el.close(); });
  el.querySelector("#detailClose").addEventListener("click", () => el.close());
}

function openDetail(id) {
  const product = store.productMap.get(id);
  if (!product) {
    toast("商品不存在或已被删除", "warn");
    return;
  }
  ensureDetailDialog();
  const dlg = $("detailDialog");
  dlg.dataset.productId = product.id;
  renderDetailImage(product);
  $("detailName").textContent = product.name || "待识别";
  const tags = [`<span class="${productTagClass(product)}">${safe(productCategoryLabel(product))}</span>`];
  if (product.verificationStatus === "pending" && product.classificationStatus !== "待核对") tags.push('<span class="pending-tag">待核实</span>');
  $("detailMeta").innerHTML = tags.join("");

  if (product.boardKey) {
    const cats = boardCategories(product.boardKey);
    const cur = boardAssignment(product.boardKey, product.id);
    $("detailBoardAssign").innerHTML = cats.length
      ? `<span>所属分类</span><select id="detailAssign"><option value="">未分类</option>${cats.map((c) => `<option value="${safe(c.id)}"${c.id === cur ? " selected" : ""}>${safe(c.name)}</option>`).join("")}</select>`
      : `<span>所属分类</span><em>尚未创建${product.boardKey === "collab" ? "联动" : "满赠"}分类</em>`;
    $("detailAssign")?.addEventListener("change", (e) => assignBoardProduct(product.id, product.boardKey, e.target.value));
  } else {
    $("detailBoardAssign").innerHTML = "";
  }

  const entry = store.collections.get(product.id);
  $("detailPriceCards").innerHTML = `
    <div class="price-box"><small>市场价格</small><b>${product.marketPrice != null ? formatMoney(product.marketPrice) : "未填写"}</b></div>
    <div class="price-box purchase"><small>实际购买价格</small><b>${entry?.purchasePrice != null ? formatMoney(entry.purchasePrice) : "未填写"}</b></div>`;

  const high = product._highResUrl || product._coverUrl;
  $("detailNote").innerHTML = high
    ? `<div class="detail-note">当前展示高清独立图。可切换到合集定位查看原始红框位置。</div>`
    : (product.image?.src && !product.image?.sharp)
      ? `<div class="detail-note">该商品在原合集中可见像素较少，按清晰度规则不单独放大裁剪；合集图红框是它的位置。</div>` : "";

  const rows = [
    ["商品 ID", product.id],
    ["主分类", productCategoryLabel(product)],
    ["独立板块", product.board || "—"],
    ["品种", product.variety || "—"],
    ["商品版本", product.version || "—"],
    ["发售日期", product.releaseDate || "—"],
    ["商品编号", product.productCode || "—"],
    ["系列", product.series || "—"],
    ["原始标价", product.price != null ? `¥${product.price}` : (product.priceText || "—")],
    ["分类状态", product.classificationStatus || "—"],
    ["分类依据", product.classificationBasis || "—"],
    ["来源", product.folder || "—"],
    ["备注", product.notes || "—"],
    ["更新时间", formatDateTime(product.updatedAt)]
  ];
  $("detailFields").innerHTML = rows.map(([k, v]) => `<div class="field"><span>${safe(k)}</span><b>${safe(v)}</b></div>`).join("");

  $("detailOwn").innerHTML = entry ? ownedFormHTML(product, entry) : ownedFormHTML(product, null);
  bindOwnedForm(product, entry);
  $("detailActions").innerHTML = `
    <button class="mini-btn" id="detailEdit">✎ 编辑商品</button>
    <button class="mini-btn" id="detailImageManage">▣ 图片管理</button>
    <button class="mini-btn ${store.wishlist.has(product.id) ? "active" : ""}" id="detailWish">${store.wishlist.has(product.id) ? "★ 已心愿" : "☆ 想要"}</button>
    <button class="ghost-danger" id="detailDelete">删除商品</button>`;
  $("detailEdit").addEventListener("click", () => { dlg.close(); openProductForm(product); });
  $("detailImageManage").addEventListener("click", () => openImageManager(product));
  $("detailWish").addEventListener("click", () => toggleWish(product.id));
  $("detailDelete").addEventListener("click", () => confirmDeleteProduct(product));
  $("detailUpdated").textContent = `最后同步：${formatDateTime(product.updatedAt)}${state.mode === "local" ? " · 本地预览" : " · 已同步到云端"}`;

  if (!dlg.open) dlg.showModal();
}

function renderDetailImage(product, preferred = null) {
  const el = $("detailImage");
  if (!el) return;
  const high = product._highResUrl || product._coverUrl;
  const base = product.image?.src;
  let mode = preferred || (high ? "high" : "base");
  if (mode === "high" && !high) mode = "base";
  if (mode === "base" && !base) mode = high ? "high" : "empty";
  const tabs = high && base
    ? `<div class="detail-image-toggle"><button class="${mode === "high" ? "active" : ""}" data-img-tab="high">高清图</button><button class="${mode === "base" ? "active" : ""}" data-img-tab="base">合集定位</button></div>`
    : "";
  if (mode === "empty") {
    el.innerHTML = `${tabs}<div class="detail-image-empty">暂无图片<br>可在“图片管理”中上传</div>`;
  } else if (mode === "high") {
    el.innerHTML = `${tabs}<div class="detail-highres"><img src="${safe(high)}" data-fallback="${safe(base || "")}" alt="${safe(product.name)}"></div>`;
  } else {
    const im = product.image || {};
    const mark = im.imageWidth ? `<div class="detail-mark" id="detailMark"></div>` : "";
    el.innerHTML = `${tabs}<div class="detail-highres" style="display:block"><img src="${safe(base)}" alt="${safe(product.name)}" id="detailImg">${mark}</div>`;
    const img = $("detailImg");
    if (img && im.imageWidth) {
      const place = () => {
        const m = $("detailMark");
        if (!m || !img.clientWidth) return;
        const scale = img.clientWidth / im.imageWidth;
        m.style.left = `${im.x * scale}px`;
        m.style.top = `${im.y * scale}px`;
        m.style.width = `${im.width * scale}px`;
        m.style.height = `${im.height * scale}px`;
      };
      img.onload = place;
      if (img.complete) place();
      setTimeout(place, 100);
    }
  }
  el.querySelectorAll("[data-img-tab]").forEach((btn) => btn.addEventListener("click", () => renderDetailImage(product, btn.dataset.imgTab)));
}

function ownedFormHTML(product, entry) {
  if (!entry) {
    return `<div class="owned-status"><b>尚未收藏</b><span>填写数量与购入信息后加入收藏</span></div>
      <div class="owned-form">
        <div class="row"><label>拥有数量 <input type="number" id="ownQty" min="1" step="1" value="1"></label>
          <label>实际购买价（元） <input type="number" id="ownPrice" min="0" step="0.01" placeholder="可留空"></label></div>
        <div class="row"><label>购买日期 <input type="date" id="ownDate"></label>
          <label>备注 <input id="ownNote" placeholder="购买渠道、状态等"></label></div>
        <div class="actions"><button class="primary-btn" id="saveOwn">加入我的收藏</button></div>
      </div>`;
  }
  return `<div class="owned-status"><b>已在收藏中 ×${Math.max(1, Number(entry.quantity) || 1)}</b><span>数量、购入价与备注可随时修改</span></div>
    <div class="owned-form">
      <div class="row"><label>拥有数量 <input type="number" id="ownQty" min="1" step="1" value="${Math.max(1, Number(entry.quantity) || 1)}"></label>
        <label>实际购买价（元） <input type="number" id="ownPrice" min="0" step="0.01" value="${entry.purchasePrice ?? ""}" placeholder="与市场价独立"></label></div>
      <div class="row"><label>购买日期 <input type="date" id="ownDate" value="${safe(entry.purchaseDate || "")}"></label>
        <label>备注 <input id="ownNote" value="${safe(entry.note || "")}" placeholder="购买渠道、状态等"></label></div>
      <div class="actions"><button class="primary-btn" id="saveOwn">保存收藏信息</button>
        <button class="outline-btn" id="removeOwn">从收藏移除</button></div>
    </div>`;
}

function bindOwnedForm(product, entry) {
  $("saveOwn")?.addEventListener("click", () => saveCollection(product.id, {
    quantity: $("ownQty").value,
    purchasePrice: $("ownPrice").value,
    purchaseDate: $("ownDate").value,
    note: $("ownNote").value
  }));
  $("removeOwn")?.addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "从收藏中移除？",
      message: entry.purchasePrice != null || entry.note ? "这条收藏包含购入价格或备注，移除后不可恢复。" : "移除后可以重新加入。",
      confirmLabel: "移除收藏",
      danger: true
    });
    if (ok) await removeCollection(product.id, entry.revision);
  });
}

/* -------------------------------------------------------------------------- */
/* 商品新增 / 编辑 / 删除                                                      */
/* -------------------------------------------------------------------------- */

function ensureProductForm() {
  if ($("productFormDialog")) return;
  const dlg = document.createElement("dialog");
  dlg.id = "productFormDialog";
  dlg.className = "xmx-modal product-modal";
  dlg.innerHTML = `<form id="productForm" class="xmx-modal-inner" novalidate>
    <div class="xmx-modal-head">
      <div><span class="eyebrow">PRODUCT EDITOR</span><h2 id="productFormTitle">添加商品</h2>
        <p>商品会立即保存到云端，并出现在对应分类中。</p></div>
      <button type="button" class="close-btn" id="productFormClose" aria-label="关闭">×</button>
    </div>
    <div class="xmx-modal-body">
      <div id="productFormError" class="form-error hidden"></div>
      <div class="product-form">
        <section class="form-section">
          <div class="form-section-title"><b>基本信息</b><small>带 * 为必填</small></div>
          <div class="form-grid-2">
            <label class="wide">商品名称 *<input id="pfName" maxlength="80" placeholder="例如：夏鸣星·主题徽章"></label>
            <label>所属作品<select id="pfWork"></select></label>
            <label>所属角色<select id="pfCharacter"></select></label>
            <label>主分类<select id="pfMainCategory"></select></label>
            <label>独立板块<select id="pfBoard"><option value="">无（普通商品）</option><option value="collab">联动</option><option value="gift">满赠</option></select></label>
            <label>联动/满赠子分类<select id="pfBoardCategory" disabled><option value="">未分类</option></select></label>
            <label>品种<input id="pfVariety" maxlength="40" placeholder="例如：吧唧、立牌、小卡"></label>
            <label>商品版本<input id="pfVersion" maxlength="40" placeholder="例如：初版、再版、特典"></label>
            <label>发售日期<input id="pfReleaseDate" type="date"></label>
            <label>市场价格（元）<input id="pfMarketPrice" type="number" min="0" step="0.01" placeholder="可留空，不影响购买价"></label>
            <label>商品编号<input id="pfProductCode" maxlength="60" placeholder="可留空"></label>
            <label>系列<input id="pfSeries" maxlength="80" placeholder="可留空"></label>
            <label class="wide">备注/描述<textarea id="pfNotes" rows="3" maxlength="500" placeholder="尺寸、材质、购买渠道、状态等"></textarea></label>
          </div>
        </section>
        <section class="form-section">
          <div class="form-section-title"><b>商品图片</b><small>JPG / PNG / WebP / AVIF，≤12MB</small></div>
          <div class="image-upload" id="pfImageUpload">
            <div class="image-upload-head"><b id="pfImageTitle">上传独立图片</b>
              <div class="image-upload-actions">
                <button type="button" class="mini-btn" id="pfPickImage">选择图片</button>
                <button type="button" class="mini-btn danger hidden" id="pfRemoveImage">删除高清图 / 恢复合集图</button>
              </div></div>
            <input type="file" id="pfImageFile" class="file-input-hidden" accept="image/jpeg,image/png,image/webp,image/avif">
            <div class="image-preview" id="pfImagePreview"></div>
            <p class="form-note">不选图片时，已有商品继续使用原始合集图红框定位；新商品会显示占位图。上传会自动生成缩略图，加快列表加载。</p>
          </div>
        </section>
      </div>
    </div>
    <div class="xmx-modal-actions">
      <button type="button" class="ghost-danger hidden" id="pfDelete">删除商品</button>
      <span class="left"></span>
      <button type="button" class="outline-btn" id="pfCancel">取消</button>
      <button type="submit" class="primary-btn" id="pfSave">保存商品</button>
    </div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.querySelector("#productFormClose").addEventListener("click", closeProductForm);
  dlg.querySelector("#pfCancel").addEventListener("click", closeProductForm);
  dlg.querySelector("#productForm").addEventListener("submit", saveProductForm);
  dlg.querySelector("#pfPickImage").addEventListener("click", () => $("pfImageFile").click());
  dlg.querySelector("#pfImageFile").addEventListener("change", handleProductFileChange);
  dlg.querySelector("#pfWork").addEventListener("change", updateCharacterOptions);
  dlg.querySelector("#pfBoard").addEventListener("change", updateBoardCategoryOptions);
  dlg.querySelector("#pfRemoveImage").addEventListener("click", removeCurrentImageFromForm);
  dlg.querySelector("#pfDelete").addEventListener("click", async () => {
    if (state.editingProduct) {
      const p = state.editingProduct;
      const done = await confirmDeleteProduct(p);
      if (done) closeProductForm();
    }
  });
}

function openProductForm(product = null) {
  ensureProductForm();
  state.editingProduct = product ? { ...product } : null;
  cleanupPendingFile();
  const dlg = $("productFormDialog");
  $("productFormError").classList.add("hidden");
  $("productFormError").textContent = "";
  $("productFormTitle").textContent = product ? "编辑商品" : "添加商品";
  $("pfDelete").classList.toggle("hidden", !product);
  $("pfSave").textContent = product ? "保存修改" : "保存商品";

  const workSel = $("pfWork");
  workSel.innerHTML = (store.works || []).map((w) => `<option value="${safe(w.id)}">${safe(w.title)}</option>`).join("") || '<option value="gyly">光与夜之恋</option>';
  const defaultWork = product?.workId || state.currentWork?.id || workSel.options[0]?.value || "gyly";
  workSel.value = defaultWork;
  updateCharacterOptions(product?.characterId || state.currentChar?.id);

  $("pfMainCategory").innerHTML = `<option value="">— 不设主分类（联动/满赠商品可留空）—</option>` +
    store.mainCategories.map((c) => `<option value="${safe(c.key)}">${safe(c.label)}</option>`).join("");
  $("pfMainCategory").value = product?.mainCategoryKey || "";
  $("pfBoard").value = product?.boardKey || "";
  updateBoardCategoryOptions();
  $("pfBoardCategory").value = product?.boardKey ? boardAssignment(product.boardKey, product.id) : "";
  $("pfName").value = product?.name || "";
  $("pfVariety").value = product?.variety || "";
  $("pfVersion").value = product?.version || "";
  $("pfReleaseDate").value = product?.releaseDate || "";
  $("pfMarketPrice").value = product?.marketPrice ?? "";
  $("pfProductCode").value = product?.productCode || "";
  $("pfSeries").value = product?.series || "";
  $("pfNotes").value = product?.notes || "";
  renderProductFormImage(product);
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $("pfName")?.focus(), 80);
}

function closeProductForm() {
  cleanupPendingFile();
  $("productFormDialog")?.close();
  state.editingProduct = null;
}

function updateCharacterOptions(preferred = null) {
  const workId = $("pfWork").value;
  const work = store.works.find((w) => w.id === workId);
  const characters = work?.characters?.length ? work.characters : [{ id: "xmx", name: "夏鸣星" }];
  $("pfCharacter").innerHTML = characters.map((c) => `<option value="${safe(c.id)}">${safe(c.name)}</option>`).join("");
  $("pfCharacter").value = preferred && characters.some((c) => c.id === preferred) ? preferred : characters[0].id;
}

function updateBoardCategoryOptions() {
  const boardKey = $("pfBoard").value;
  const sel = $("pfBoardCategory");
  const cats = boardKey ? boardCategories(boardKey) : [];
  sel.disabled = !boardKey;
  sel.innerHTML = `<option value="">未分类</option>` + cats.map((c) => `<option value="${safe(c.id)}">${safe(c.name)}</option>`).join("");
}

function renderProductFormImage(product) {
  const wrap = $("pfImagePreview");
  const upload = $("pfImageUpload");
  const existingImg = product?._images?.highres || product?._images?.cover;
  const highUrl = product?._highResUrl || product?._coverUrl;
  const baseThumb = product?.image?.thumb || product?.image?.src;
  $("pfRemoveImage").classList.toggle("hidden", !existingImg);
  $("pfImageTitle").textContent = existingImg ? "当前独立图片" : (product?.image?.src ? "当前使用原始合集图" : "上传独立图片");
  if (state.pendingFile) {
    upload.classList.add("has-image");
    wrap.innerHTML = `<img src="${safe(state.pendingPreviewUrl)}" alt="待上传预览"><div class="image-preview-meta"><b>${safe(state.pendingFile.name)}</b>${formatBytes(state.pendingFile.size)} · 保存商品后上传</div>`;
    return;
  }
  if (highUrl) {
    upload.classList.add("has-image");
    wrap.innerHTML = `<img src="${safe(product._highResThumbUrl || highUrl)}" alt="当前图片"><div class="image-preview-meta"><b>高清独立图</b>${existingImg?.width || "—"}×${existingImg?.height || "—"} · ${formatBytes(existingImg?.sizeBytes || 0)}<br>卡片使用缩略图，详情展示高清图</div>`;
    return;
  }
  upload.classList.remove("has-image");
  if (baseThumb) {
    wrap.innerHTML = `<img src="${safe(baseThumb)}" alt="合集图"><div class="image-preview-meta"><b>原始合集图定位</b>未上传独立高清图时，卡片和详情使用原图红框定位。</div>`;
  } else {
    wrap.innerHTML = `<div class="image-placeholder-box">✧</div><div class="image-preview-meta"><b>暂无图片</b>可以选择一张图片上传，或先保存后补充。</div>`;
  }
}

function handleProductFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    validateImageFile(file);
  } catch (e) {
    toastError(e, "图片不符合要求");
    event.target.value = "";
    return;
  }
  cleanupPendingFile();
  state.pendingFile = file;
  state.pendingPreviewUrl = URL.createObjectURL(file);
  renderProductFormImage(state.editingProduct);
  toast("图片已选择，保存商品后上传", "info");
}

function cleanupPendingFile() {
  if (state.pendingPreviewUrl) URL.revokeObjectURL(state.pendingPreviewUrl);
  state.pendingPreviewUrl = null;
  state.pendingFile = null;
  const input = $("pfImageFile");
  if (input) input.value = "";
}

async function saveProductForm(event) {
  event.preventDefault();
  if (!state.booted) return;
  const name = $("pfName").value.trim();
  if (!name) {
    showFormError("请填写商品名称。");
    $("pfName").focus();
    return;
  }
  const workId = $("pfWork").value;
  const characterId = $("pfCharacter").value;
  const mainCategoryKey = $("pfMainCategory").value || null;
  const boardKey = $("pfBoard").value || null;
  const boardCategoryId = $("pfBoardCategory").value || null;
  const existing = state.editingProduct;
  let product = existing ? normalizeProduct(existing) : makeNewProduct({
    id: newProductId(), name: name, workId, characterId, mainCategoryKey: mainCategoryKey || "other"
  });
  product.name = name;
  product.workId = workId;
  product.characterId = characterId;
  product.variety = $("pfVariety").value.trim() || null;
  product.version = $("pfVersion").value.trim() || null;
  product.releaseDate = $("pfReleaseDate").value || null;
  product.marketPrice = parseNumberOrNull($("pfMarketPrice").value);
  product.productCode = $("pfProductCode").value.trim() || null;
  product.series = $("pfSeries").value.trim() || null;
  product.notes = $("pfNotes").value.trim() || null;
  product = applyCategoryToProduct(product, mainCategoryKey);
  const chosenCategory = mainCategoryKey ? store.mainCategories.find((c) => c.key === mainCategoryKey) : null;
  if (chosenCategory) {
    product.mainCategory = chosenCategory.label;
    product.categoryLabel = chosenCategory.label;
  }
  product = applyBoardToProduct(product, boardKey);
  product.updatedAt = new Date().toISOString();
  if (!existing) product.createdAt = product.updatedAt;

  const btn = $("pfSave");
  setButtonBusy(btn, true, "保存中…");
  $("productFormError").classList.add("hidden");
  try {
    let saved;
    if (existing) {
      saved = await state.backend.updateProduct(product, existing._revision || 1);
    } else {
      saved = await state.backend.createProduct(product);
    }
    if (existing?.boardKey && existing.boardKey !== boardKey) {
      try {
        await state.backend.setBoardAssignment(saved.id, existing.boardKey, null);
      } catch (clearError) {
        console.warn("清理旧板块归类失败", clearError);
      }
    }
    if (boardKey) {
      try {
        await state.backend.setBoardAssignment(saved.id, boardKey, boardCategoryId || null);
      } catch (assignError) {
        console.warn("商品已保存，但归类失败", assignError);
        toast(`商品已保存，但分类归属失败：${errorText(assignError)}`, "warn", 5000);
      }
    }
    if (state.pendingFile) {
      try {
        await uploadProductImage(saved, state.pendingFile, uploadedKindFor(saved));
        state.pendingFile = null;
      } catch (e) {
        console.error(e);
        toast(`商品已保存，但图片上传失败：${errorText(e)}`, "error", 5000);
      }
    }
    closeProductForm();
    await refreshData({ silent: true });
    toast(existing ? "商品修改已保存" : "商品已新增", "success");
  } catch (e) {
    if (e.code === ERROR_CODES.CONFLICT && e.current) {
      await resolveProductConflict(e.current, product, existing ? "update" : "create");
    } else if (e.code === ERROR_CODES.DELETED) {
      showFormError("这件商品已在其他设备被删除，无法保存。");
    } else {
      console.error(e);
      showFormError(errorText(e));
      toastError(e, "保存商品失败");
    }
  } finally {
    setButtonBusy(btn, false);
  }
}

function showFormError(message) {
  const el = $("productFormError");
  el.textContent = message;
  el.classList.remove("hidden");
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function resolveProductConflict(current, local, mode, after = null) {
  await showConflictDialog({
    title: "商品在其他设备被修改",
    current,
    local,
    fields: [
      { key: "name", label: "名称", format: (v) => v || "—" },
      { key: "mainCategory", label: "主分类", format: (v) => v || "—" },
      { key: "board", label: "板块", format: (v) => v || "—" },
      { key: "variety", label: "品种", format: (v) => v || "—" },
      { key: "version", label: "版本", format: (v) => v || "—" },
      { key: "releaseDate", label: "发售日期", format: (v) => v || "—" },
      { key: "marketPrice", label: "市场价", format: (v) => formatMoney(v) },
      { key: "productCode", label: "编号", format: (v) => v || "—" },
      { key: "notes", label: "备注", format: (v) => v || "—" }
    ],
    onUseCloud: async () => {
      await refreshData({ silent: true });
      closeProductForm();
      after?.(false);
    },
    onKeepMine: async () => {
      let saved;
      if (mode === "create") saved = await state.backend.createProduct({ ...local, id: current.id });
      else saved = await state.backend.updateProduct(local, current._revision);
      await refreshData({ silent: true });
      closeProductForm();
      after?.(true);
      toast("已用你的版本覆盖云端", "success");
      return saved;
    }
  });
}

async function removeCurrentImageFromForm() {
  const product = state.editingProduct;
  if (!product) return;
  const existing = product._images?.highres || product._images?.cover;
  if (!existing) return;
  const ok = await confirmAction({
    title: "删除当前高清图？",
    message: "删除后会恢复使用原始合集图（如果存在），此操作会同步到云端。",
    confirmLabel: "删除高清图",
    danger: true
  });
  if (!ok) return;
  try {
    await deleteProductImage(product, existing);
    await refreshData({ silent: true });
    state.editingProduct = store.productMap.get(product.id) || null;
    renderProductFormImage(state.editingProduct);
    toast("已删除高清图，恢复默认合集图", "success");
  } catch (e) {
    toastError(e, "删除图片失败");
  }
}

async function confirmDeleteProduct(product) {
  const associations = await state.backend.getProductAssociations(product.id).catch(() => ({ collection: 0, wishlist: 0 }));
  const isOriginal = !product.isUserCreated;
  const detail = `<div class="confirm-warning">
    删除后会同时移除：<br>
    · 收藏记录 ${associations.collection} 条（含购买价格、数量、备注）<br>
    · 愿望清单 ${associations.wishlist} 条<br>
    · 该商品的高清图片与分类归属
  </div>${isOriginal ? '<p class="form-hint">这是原始 1537 件图鉴中的商品，删除需要二次确认。删除后只能通过完整备份恢复。</p>' : ""}`;
  const first = await confirmAction({
    title: `删除「${product.name}」？`,
    message: "商品会从云端图鉴中永久删除，且不会自动恢复。",
    details: detail,
    confirmLabel: "继续删除",
    danger: true
  });
  if (!first) return false;
  if (isOriginal) {
    const second = await confirmAction({
      title: "原始商品删除确认",
      message: `请确认删除原始商品「${product.name}」。此操作无法撤销。`,
      details: `<p class="form-hint">建议先在“账户 → 完整备份”导出一份备份。</p>`,
      confirmLabel: "确认永久删除",
      danger: true,
      requireText: "删除"
    });
    if (!second) return false;
  }
  try {
    await state.backend.deleteProduct(product.id, product._revision || 1);
    if ($("detailDialog")?.open) $("detailDialog").close();
    await refreshData({ silent: true });
    toast(`已删除「${product.name}」`, "success");
    return true;
  } catch (e) {
    if (e.code === ERROR_CODES.CONFLICT && e.current) {
      await showConflictDialog({
        title: "商品刚被其他设备修改",
        current: e.current,
        local: product,
        fields: [
          { key: "name", label: "名称", format: (v) => v || "—" },
          { key: "marketPrice", label: "市场价", format: (v) => formatMoney(v) }
        ],
        onUseCloud: async () => { await refreshData({ silent: true }); },
        onKeepMine: async () => {
          await state.backend.deleteProduct(product.id, e.current._revision);
          await refreshData({ silent: true });
          toast("已删除商品", "success");
        }
      });
    } else toastError(e, "删除商品失败");
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* 图片管理                                                                   */
/* -------------------------------------------------------------------------- */

function uploadedKindFor(product) {
  return product.image?.src ? "highres" : "cover";
}

async function uploadProductImage(product, file, kind) {
  const prepared = await prepareImage(file);
  const ownerId = state.backend.user?.id || "local-user";
  const existing = store.images.get(`${product.id}::${kind}`) || await state.backend.getProductImage(product.id, kind).catch(() => null);
  const base = `${ownerId}/${product.id}/${kind}-${Date.now()}-${uid().slice(0, 6)}`;
  const storagePath = `${base}.${prepared.ext}`;
  const thumbPath = `${base}-thumb.webp`;
  let uploadedMain = false;
  let uploadedThumb = false;
  try {
    await state.backend.uploadStorage(storagePath, prepared.mainBlob, prepared.mimeType);
    uploadedMain = true;
    await state.backend.uploadStorage(thumbPath, prepared.thumbBlob, "image/webp");
    uploadedThumb = true;
    const record = await state.backend.saveProductImageRecord({
      productId: product.id,
      kind,
      storagePath,
      thumbPath,
      fileName: prepared.fileName,
      mimeType: prepared.mimeType,
      sizeBytes: prepared.mainBlob.size,
      width: prepared.width,
      height: prepared.height
    }, existing);
    if (existing?.storagePath) {
      await state.backend.removeStorage([existing.storagePath, existing.thumbPath]);
    }
    return record;
  } catch (e) {
    if (uploadedMain || uploadedThumb) {
      await state.backend.removeStorage([uploadedMain ? storagePath : null, uploadedThumb ? thumbPath : null]).catch(() => {});
    }
    throw e;
  }
}

async function deleteProductImage(product, image) {
  const ok = await state.backend.deleteProductImageRecord(image.id, image.revision || 1);
  await state.backend.removeStorage([ok.storagePath, ok.thumbPath]);
  return ok;
}

function openImageManager(product) {
  let dlg = $("imageManagerDialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "imageManagerDialog";
    dlg.className = "xmx-modal";
    dlg.innerHTML = `<div class="xmx-modal-inner">
      <div class="xmx-modal-head"><div><span class="eyebrow">IMAGE MANAGER</span><h2 id="imgMgrTitle">图片管理</h2>
        <p>高清图会同步到云端；删除后自动恢复原始合集图。</p></div>
        <button class="close-btn" id="imgMgrClose" aria-label="关闭">×</button></div>
      <div class="xmx-modal-body" id="imgMgrBody"></div>
      <div class="xmx-modal-actions">
        <input type="file" id="imgMgrFile" class="file-input-hidden" accept="image/jpeg,image/png,image/webp,image/avif">
        <button class="outline-btn" id="imgMgrPick">上传/替换高清图</button>
        <button class="ghost-danger hidden" id="imgMgrDelete">删除高清图并恢复合集图</button>
        <button class="primary-btn" id="imgMgrDone">完成</button>
      </div></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector("#imgMgrClose").addEventListener("click", () => dlg.close());
    dlg.querySelector("#imgMgrDone").addEventListener("click", () => dlg.close());
    dlg.querySelector("#imgMgrPick").addEventListener("click", () => $("imgMgrFile").click());
    dlg.querySelector("#imgMgrFile").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const p = store.productMap.get(dlg.dataset.productId);
      if (!p) return;
      try {
        validateImageFile(file);
        toast("正在处理图片…", "info");
        await uploadProductImage(p, file, uploadedKindFor(p));
        await refreshData({ silent: true });
        renderImageManager(store.productMap.get(p.id));
        toast("图片已上传并同步", "success");
      } catch (err) {
        toastError(err, "图片上传失败");
      } finally {
        e.target.value = "";
      }
    });
    dlg.querySelector("#imgMgrDelete").addEventListener("click", async () => {
      const p = store.productMap.get(dlg.dataset.productId);
      const image = p?._images?.highres || p?._images?.cover;
      if (!p || !image) return;
      const ok = await confirmAction({
        title: "删除高清图？",
        message: "删除后会恢复默认合集图（如果存在），并同步到其他设备。",
        confirmLabel: "删除高清图",
        danger: true
      });
      if (!ok) return;
      try {
        await deleteProductImage(p, image);
        await refreshData({ silent: true });
        renderImageManager(store.productMap.get(p.id));
        toast("高清图已删除", "success");
      } catch (err) { toastError(err, "删除图片失败"); }
    });
  }
  dlg.dataset.productId = product.id;
  renderImageManager(product);
  if (!dlg.open) dlg.showModal();
}

function renderImageManager(product) {
  if (!product) return;
  $("imgMgrTitle").textContent = `图片管理 · ${product.name}`;
  const high = product._images?.highres || product._images?.cover;
  const highUrl = product._highResUrl || product._coverUrl;
  const base = product.image?.thumb || product.image?.src;
  $("imgMgrDelete").classList.toggle("hidden", !high);
  $("imgMgrBody").innerHTML = `
    <div class="image-preview" style="align-items:flex-start">
      ${highUrl ? `<img src="${safe(product._highResThumbUrl || highUrl)}" alt="高清图">` : base ? `<img src="${safe(base)}" alt="合集图">` : `<div class="image-placeholder-box">✧</div>`}
      <div class="image-preview-meta">
        <b>${high ? "高清独立图" : (base ? "原始合集图（红框定位）" : "暂无图片")}</b>
        ${high ? `${high.width || "—"}×${high.height || "—"} · ${formatBytes(high.sizeBytes || 0)}<br>文件：${safe(high.fileName || "")}` : "上传高清图后，卡片和详情优先显示高清图；删除后自动回到合集定位。"}
        <br><span style="color:#b09da5">支持 JPG / PNG / WebP / AVIF，≤12MB；自动生成列表缩略图。</span>
      </div>
    </div>
    ${product.image?.src ? `<div class="backup-option" style="margin-top:14px"><span>原始合集图：${safe(product.image.src)}（红框位置 x:${product.image.x ?? "—"} y:${product.image.y ?? "—"}）</span></div>` : ""}
    <div class="form-hint">高清图片存储在 Supabase Storage 私有桶中，仅当前账号可访问；其他设备登录后会生成临时签名地址。</div>`;
}

/* -------------------------------------------------------------------------- */
/* 冲突弹窗                                                                   */
/* -------------------------------------------------------------------------- */

function showConflictDialog({ title, current, local, fields, onUseCloud, onKeepMine }) {
  let dlg = $("conflictDialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "conflictDialog";
    dlg.className = "xmx-modal";
    dlg.innerHTML = `<div class="xmx-modal-inner">
      <div class="xmx-modal-head"><div><span class="eyebrow">SYNC CONFLICT</span><h2 id="conflictTitle">数据冲突</h2></div></div>
      <div class="xmx-modal-body">
        <div class="conflict-box">检测到同一份数据在两台设备上被先后修改。网站不会静默覆盖，请选择保留哪一个版本。</div>
        <div class="conflict-compare">
          <div class="conflict-col"><b>云端当前版本</b><div id="conflictCloud"></div></div>
          <div class="conflict-col"><b>你刚才的修改</b><div id="conflictLocal"></div></div>
        </div>
      </div>
      <div class="xmx-modal-actions">
        <button class="outline-btn" id="conflictUseCloud">保留云端版本</button>
        <button class="primary-btn" id="conflictKeepMine">用我的版本覆盖</button>
      </div></div>`;
    document.body.appendChild(dlg);
  }
  $("conflictTitle").textContent = title;
  const compare = (obj, other) => fields.map((f) => {
    const val = f.format ? f.format(obj?.[f.key]) : (obj?.[f.key] ?? "—");
    const otherVal = f.format ? f.format(other?.[f.key]) : (other?.[f.key] ?? "—");
    const diff = String(val) !== String(otherVal) ? " diff" : "";
    return `<div><span>${safe(f.label)}：</span><span class="${diff.trim()}">${safe(val)}</span></div>`;
  }).join("");
  $("conflictCloud").innerHTML = compare(current, local);
  $("conflictLocal").innerHTML = compare(local, current);
  return new Promise((resolve) => {
    const finish = async (handler) => {
      dlg.close();
      try { await handler(); } catch (e) { toastError(e, "冲突处理失败"); }
      resolve(true);
    };
    $("conflictUseCloud").onclick = () => finish(onUseCloud);
    $("conflictKeepMine").onclick = () => finish(onKeepMine);
    dlg.addEventListener("close", () => resolve(false), { once: true });
    dlg.showModal();
  });
}

/* -------------------------------------------------------------------------- */
/* 数据刷新 / 实时同步                                                        */
/* -------------------------------------------------------------------------- */

async function refreshData({ silent = false } = {}) {
  if (!state.backend || !state.booted) return;
  if (state.refreshing) { state.refreshQueued = true; return; }
  state.refreshing = true;
  if (!silent) updateSyncStatus("syncing");
  try {
    const snapshot = await loadBackendSnapshot();
    applySnapshot(snapshot);
    await hydrateImages();
    renderAll();
    if ($("detailDialog")?.open) {
      const id = $("detailDialog").dataset.productId;
      if (id && store.productMap.has(id)) openDetail(id);
      else $("detailDialog").close();
    }
    updateSyncStatus("online");
  } catch (e) {
    console.error(e);
    updateSyncStatus("error");
    if (!silent) toastError(e, "同步失败");
  } finally {
    state.refreshing = false;
    if (state.refreshQueued) {
      state.refreshQueued = false;
      setTimeout(() => refreshData({ silent: true }), 250);
    }
  }
}

function subscribeRealtime() {
  state.unsubscribeRealtime?.();
  if (state.mode !== "cloud") return;
  const refresh = debounce(() => {
    if (document.hidden) return;
    refreshData({ silent: true });
  }, 900);
  state.unsubscribeRealtime = state.backend.subscribe(() => refresh());
}

function updateSyncStatus(status) {
  const dot = $("syncDot");
  if (!dot) return;
  dot.className = "sync-dot " + status;
  dot.title = status === "syncing" ? "正在同步…" : status === "error" ? "同步失败" : status === "offline" ? "离线" : (state.mode === "cloud" ? "云端已连接" : "本地预览");
}

function updateAccountButton() {
  const btn = $("accountBtn");
  if (!btn) return;
  if (!state.booted) { btn.hidden = true; return; }
  btn.hidden = false;
  const label = state.mode === "cloud" ? (store.user?.email || "云端账号") : "本地预览";
  $("accountLabel").textContent = label;
  $("accountAvatar").textContent = (store.user?.email || "星").slice(0, 1).toUpperCase();
  btn.title = state.mode === "cloud" ? `已登录：${store.user?.email || ""}` : "本地预览模式";
}

/* -------------------------------------------------------------------------- */
/* 账户 / 备份 / 恢复                                                         */
/* -------------------------------------------------------------------------- */

function openAccountDialog() {
  let dlg = $("accountDialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "accountDialog";
    dlg.className = "xmx-modal";
    dlg.innerHTML = `<div class="xmx-modal-inner">
      <div class="xmx-modal-head"><div><span class="eyebrow">ACCOUNT & DATA</span><h2>账户与数据</h2></div>
        <button class="close-btn" id="accountClose" aria-label="关闭">×</button></div>
      <div class="xmx-modal-body" id="accountBody"></div>
      <div class="xmx-modal-actions"><button class="outline-btn" id="accountSync">立即同步</button>
        <button class="primary-btn" id="accountBackup">完整备份</button></div></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector("#accountClose").addEventListener("click", () => dlg.close());
    dlg.querySelector("#accountSync").addEventListener("click", async () => {
      const btn = $("accountSync");
      setButtonBusy(btn, true, "同步中…");
      await refreshData({ silent: false });
      setButtonBusy(btn, false);
      toast("已获取最新云端数据", "success");
    });
    dlg.querySelector("#accountBackup").addEventListener("click", () => openBackupDialog());
    dlg.querySelector("#accountBody").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-account-action]");
      if (!btn) return;
      const action = btn.dataset.accountAction;
      if (action === "restore") $("globalRestoreFile").click();
      if (action === "migrate") openMigrationDialog();
      if (action === "signout") {
        const ok = await confirmAction({ title: "退出登录？", message: "退出后本机不会保留云端数据缓存，下次登录会重新从云端读取。", confirmLabel: "退出登录", danger: true });
        if (!ok) return;
        await state.backend.signOut();
        teardownApp();
        dlg.close();
        showAuthGate("已退出登录。");
      }
      if (action === "backup") openBackupDialog();
      if (action === "export-collection") exportCollectionJSON();
      if (action === "import-collection") $("legacyCollectionFile").click();
      if (action === "demo-reset") {
        const ok = await confirmAction({ title: "重置本地预览数据？", message: "会清除本地预览的收藏、分类和站内新增商品，并重新从内置 1537 件图鉴初始化。", confirmLabel: "重置", danger: true, requireText: "重置" });
        if (!ok) return;
        ["products", "collections", "wishlist", "board_categories", "assignments", "images", "settings", "initialized"].forEach((k) => localStorage.removeItem(`xmx.local.v5.${k}`));
        location.reload();
      }
    });
  }
  const counts = {
    products: store.products.length,
    userProducts: store.products.filter((p) => p.isUserCreated).length,
    collections: store.collections.size,
    wishlist: store.wishlist.size,
    categories: boardCategories("collab").length + boardCategories("gift").length,
    images: store.images.size
  };
  $("accountBody").innerHTML = `
    <div class="account-hero"><div class="big-avatar">${safe((store.user?.email || "星").slice(0, 1).toUpperCase())}</div>
      <div><b>${state.mode === "cloud" ? safe(store.user?.email || "云端账号") : "本地预览模式"}</b>
        <small>${state.mode === "cloud" ? "Supabase 云端同步已启用" : "仅当前浏览器，不会跨设备同步"}</small></div></div>
    <div class="account-meta">
      <div>图鉴商品<b>${counts.products}</b></div>
      <div>站内新增<b>${counts.userProducts}</b></div>
      <div>收藏种类<b>${counts.collections}</b></div>
      <div>愿望清单<b>${counts.wishlist}</b></div>
      <div>自定义分类<b>${counts.categories}</b></div>
      <div>高清图片<b>${counts.images}</b></div>
    </div>
    <div class="account-menu">
      <button data-account-action="backup"><span>完整备份（含图片）<small>导出 JSON + ZIP 图片包</small></span><b>导出 →</b></button>
      <button data-account-action="restore"><span>从备份恢复<small>校验格式、图片与重复 ID</small></span><b>恢复 →</b></button>
      <button data-account-action="export-collection"><span>导出收藏 JSON（兼容 V4）<small>只含收藏/愿望/购买记录</small></span><b>导出 →</b></button>
      <button data-account-action="import-collection"><span>导入 V4 收藏 JSON<small>合并旧版导出的收藏文件</small></span><b>导入 →</b></button>
      ${state.mode === "cloud" ? `<button data-account-action="migrate"><span>从本机旧数据合并<small>V4 收藏、愿望、联动/满赠分类</small></span><b>合并 →</b></button>` : ""}
      ${state.mode === "cloud" ? `<button data-account-action="signout"><span>退出登录<small>不会删除云端数据</small></span><b>退出</b></button>` : `<button data-account-action="demo-reset"><span>重置本地预览数据<small>重新初始化 1537 件图鉴</small></span><b>重置</b></button>`}
    </div>
    <p class="form-hint">数据库版本：${SCHEMA_VERSION} · 网站版本：v${APP_VERSION}${store.settings?.lastBackupAt ? ` · 上次备份：${formatDateTime(store.settings.lastBackupAt)}` : ""}</p>
    <input type="file" id="globalRestoreFile" class="file-input-hidden" accept=".zip,application/zip">
    <input type="file" id="legacyCollectionFile" class="file-input-hidden" accept="application/json,.json">`;
  $("globalRestoreFile")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) handleRestoreFile(file, dlg);
  });
  $("legacyCollectionFile")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) importLegacyCollectionJSON(file);
  });
  if (!dlg.open) dlg.showModal();
}

/* -------------------------------------------------------------------------- */
/* V4 收藏 JSON 兼容                                                          */
/* -------------------------------------------------------------------------- */

function exportCollectionJSON() {
  const owned = {};
  for (const [id, entry] of store.collections) {
    owned[id] = {
      price: entry.purchasePrice ?? null,
      date: entry.purchaseDate || "",
      note: entry.note || "",
      quantity: Math.max(1, Number(entry.quantity) || 1)
    };
  }
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    collection: { version: 1, owned, wishlist: [...store.wishlist] }
  };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }), `xmx-collection-backup-${Date.now()}.json`);
  toast("收藏 JSON 已导出", "success");
}

async function importLegacyCollectionJSON(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast("文件不是有效的 JSON", "error");
    return;
  }
  const c = data.collection || data.state || data;
  if (!c || !c.owned || typeof c.owned !== "object" || !Array.isArray(c.wishlist)) {
    toast("不是 V4 收藏备份格式", "error");
    return;
  }
  const owned = Object.entries(c.owned).filter(([id]) => store.productMap.has(id));
  const wishlist = c.wishlist.map(String).filter((id) => store.productMap.has(id));
  const ok = await confirmAction({
    title: "导入 V4 收藏 JSON？",
    message: "只补充云端尚未存在的收藏与愿望，不会覆盖已有购买价。",
    details: `<ul class="confirm-list"><li>可导入收藏：${owned.length} 条</li><li>可导入愿望：${wishlist.length} 条</li><li>不在当前图鉴中的 ID 会自动跳过</li></ul>`,
    confirmLabel: "开始导入"
  });
  if (!ok) return;
  try {
    const entries = owned.map(([productId, entry]) => ({
      productId,
      quantity: Math.max(1, Number(entry?.quantity) || 1),
      purchasePrice: entry?.price == null ? null : Number(entry.price),
      purchaseDate: normalizeDate(entry?.date) || "",
      note: entry?.note || ""
    }));
    await state.backend.insertCollections(entries);
    await state.backend.insertWishlist(wishlist);
    await refreshData({ silent: true });
    toast(`已导入 ${entries.length} 条收藏、${wishlist.length} 条愿望（已有记录保持不变）`, "success", 4200);
  } catch (e) {
    toastError(e, "导入收藏失败");
  }
}

/* -------------------------------------------------------------------------- */
/* 完整备份                                                                   */
/* -------------------------------------------------------------------------- */

function openBackupDialog() {
  let dlg = $("backupDialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "backupDialog";
    dlg.className = "xmx-modal";
    dlg.innerHTML = `<div class="xmx-modal-inner">
      <div class="xmx-modal-head"><div><span class="eyebrow">FULL BACKUP</span><h2>完整备份</h2>
        <p>数据、收藏、分类、购买记录与图片打成一个 ZIP。</p></div>
        <button class="close-btn" id="backupClose" aria-label="关闭">×</button></div>
      <div class="xmx-modal-body" id="backupBody"></div>
      <div class="xmx-modal-actions"><button class="outline-btn" id="backupCancel">关闭</button>
        <button class="primary-btn" id="backupStart">开始导出</button></div></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector("#backupClose").addEventListener("click", () => { if (!dlg.dataset.busy) dlg.close(); });
    dlg.querySelector("#backupCancel").addEventListener("click", () => { if (!dlg.dataset.busy) dlg.close(); });
    dlg.querySelector("#backupStart").addEventListener("click", startBackupExport);
  }
  const uploads = [...store.images.values()];
  const uploadBytes = uploads.reduce((s, i) => s + (i.sizeBytes || 0), 0);
  $("backupBody").innerHTML = `
    <div class="backup-stats">
      <div class="backup-stat"><small>商品</small><b>${store.products.length}</b></div>
      <div class="backup-stat"><small>收藏</small><b>${store.collections.size}</b></div>
      <div class="backup-stat"><small>愿望</small><b>${store.wishlist.size}</b></div>
      <div class="backup-stat"><small>分类</small><b>${boardCategories("collab").length + boardCategories("gift").length}</b></div>
      <div class="backup-stat"><small>高清图</small><b>${uploads.length}</b></div>
      <div class="backup-stat"><small>图片体积</small><b>${formatBytes(uploadBytes)}</b></div>
    </div>
    <label class="backup-option"><input type="checkbox" id="backupBase" checked><span><b>包含原始合集图与缩略图</b><br>完整归档约 55MB，手机端可能较慢；取消后仍会包含所有用户上传的高清图。</span></label>
    <label class="backup-option"><input type="checkbox" id="backupThumbs" checked><span><b>包含列表缩略图</b><br>缩略图用于恢复后快速显示；取消可减小备份体积。</span></label>
    <div class="backup-progress hidden" id="backupProgress"><div class="backup-progress-track"><span id="backupProgressBar"></span></div><div class="backup-progress-text" id="backupProgressText"></div></div>
    <p class="form-hint">备份包含个人购买价格与备注，请妥善保管。恢复时需要选择同一个备份包，网站会先校验 manifest 与 SHA-256。</p>`;
  if (!dlg.open) dlg.showModal();
}

async function startBackupExport() {
  const dlg = $("backupDialog");
  if (dlg.dataset.busy) return;
  dlg.dataset.busy = "1";
  const btn = $("backupStart");
  setButtonBusy(btn, true, "打包中…");
  $("backupProgress").classList.remove("hidden");
  const includeBaseImages = $("backupBase").checked;
  const includeThumbs = $("backupThumbs").checked;
  const setProgress = (p) => {
    const percent = p.percent ?? (p.total ? Math.round((p.current / p.total) * 100) : 0);
    $("backupProgressBar").style.width = `${Math.min(100, percent)}%`;
    $("backupProgressText").textContent = p.message || "正在处理…";
  };
  try {
    const result = await createBackup(state.backend, state.lastSnapshot, { includeBaseImages, includeThumbs }, setProgress);
    downloadBlob(result.blob, backupFileName());
    await state.backend.logBackup(result.data.counts, "export");
    await state.backend.mergeSettings({ lastBackupAt: new Date().toISOString() }).catch(() => {});
    $("backupProgressBar").style.width = "100%";
    $("backupProgressText").innerHTML = `<span style="color:#55815b">备份已下载：${formatBytes(result.blob.size)}，共 ${result.manifest.images.length} 个图片文件${result.warnings.length ? `；${result.warnings.length} 条警告` : ""}。</span>`;
    toast("完整备份已导出", "success");
    if (result.warnings.length) {
      $("backupProgressText").innerHTML += `<br><span style="color:#a85264">${result.warnings.slice(0, 3).map(safe).join("<br>")}${result.warnings.length > 3 ? "<br>…" : ""}</span>`;
    }
  } catch (e) {
    console.error(e);
    $("backupProgressText").textContent = `备份失败：${errorText(e)}`;
    toastError(e, "备份失败");
  } finally {
    delete dlg.dataset.busy;
    setButtonBusy(btn, false);
  }
}

async function handleRestoreFile(file, fromDialog = null) {
  if (!file) return;
  let dlg = $("restoreDialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "restoreDialog";
    dlg.className = "xmx-modal";
    dlg.innerHTML = `<div class="xmx-modal-inner">
      <div class="xmx-modal-head"><div><span class="eyebrow">RESTORE</span><h2>恢复备份</h2>
        <p>恢复前会校验格式、版本、图片完整性与重复 ID。</p></div>
        <button class="close-btn" id="restoreClose" aria-label="关闭">×</button></div>
      <div class="xmx-modal-body" id="restoreBody"><div class="loading-block"><div class="loading-spinner"></div><span>正在校验备份包…</span></div></div>
      <div class="xmx-modal-actions"><button class="outline-btn" id="restoreCancel">取消</button>
        <button class="primary-btn" id="restoreStart" disabled>开始恢复</button></div></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector("#restoreClose").addEventListener("click", () => { if (!dlg.dataset.busy) dlg.close(); });
    dlg.querySelector("#restoreCancel").addEventListener("click", () => { if (!dlg.dataset.busy) dlg.close(); });
  }
  dlg.dataset.busy = "";
  $("restoreStart").disabled = true;
  $("restoreBody").innerHTML = `<div class="loading-block"><div class="loading-spinner"></div><span>正在校验备份包与图片 SHA-256…</span></div>`;
  if (!dlg.open) dlg.showModal();
  let inspection;
  try {
    inspection = await inspectBackup(file, (p) => {
      $("restoreBody").innerHTML = `<div class="loading-block"><div class="loading-spinner"></div><span>${safe(p.message || "校验中…")}</span></div>`;
    });
  } catch (e) {
    console.error(e);
    $("restoreBody").innerHTML = `<div class="backup-warning">备份校验失败：${safe(errorText(e))}</div>`;
    return;
  }
  dlg._inspection = inspection;
  const s = inspection.summary;
  const missing = inspection.missingFiles.length;
  const mismatch = inspection.hashMismatches.length;
  $("restoreBody").innerHTML = `
    <div class="backup-stats">
      <div class="backup-stat"><small>商品</small><b>${s.products}</b></div>
      <div class="backup-stat"><small>收藏</small><b>${s.collections}</b></div>
      <div class="backup-stat"><small>愿望</small><b>${s.wishlist}</b></div>
      <div class="backup-stat"><small>分类</small><b>${s.categories}</b></div>
      <div class="backup-stat"><small>高清图</small><b>${s.uploads}</b></div>
      <div class="backup-stat"><small>原始图</small><b>${s.baseImages}</b></div>
    </div>
    <p class="form-hint">备份导出时间：${safe(formatDateTime(s.exportedAt))} · 数据结构：${safe(inspection.data.schemaVersion || "—")} · 文件体积：${formatBytes(s.totalImageBytes)}</p>
    ${missing ? `<div class="backup-warning">备份包缺少 ${missing} 个图片文件，恢复后这些图片会缺失。</div>` : ""}
    ${mismatch ? `<div class="backup-warning">有 ${mismatch} 个图片 SHA-256 校验不一致，备份可能被修改过。建议先保留原文件。</div>` : ""}
    <div class="restore-mode">
      <label><input type="radio" name="restoreMode" value="merge" checked><span><b>合并（推荐）</b><br>只补充云端缺失的商品、收藏、分类和图片；不覆盖已有记录，不会重复导入。</span></label>
      <label><input type="radio" name="restoreMode" value="overwrite"><span><b>覆盖同 ID 记录</b><br>用备份中的商品、收藏与图片覆盖云端现有同 ID 记录；适合迁移到新账号或回滚。</span></label>
    </div>
    <label class="backup-option"><input type="checkbox" id="restoreIgnoreMissing" ${missing ? "" : "checked"}><span><b>忽略缺失图片继续恢复</b><br>商品、收藏和分类仍会恢复，缺失的图片会在报告中列出。</span></label>
    <div id="restoreReport" class="restore-report hidden"></div>`;
  $("restoreStart").disabled = missing > 0 && !$("restoreIgnoreMissing").checked;
  $("restoreIgnoreMissing").addEventListener("change", (e) => {
    $("restoreStart").disabled = (missing > 0 && !e.target.checked) || Boolean(dlg.dataset.busy);
  });
  $("restoreStart").onclick = () => runRestore(dlg, inspection);
}

async function runRestore(dlg, inspection) {
  const overwrite = dlg.querySelector('input[name="restoreMode"]:checked')?.value === "overwrite";
  const ignoreMissing = $("restoreIgnoreMissing").checked;
  if (inspection.missingFiles.length && !ignoreMissing) {
    toast("请先勾选“忽略缺失图片继续恢复”，或换一个完整备份。", "warn");
    return;
  }
  const first = await confirmAction({
    title: "开始恢复备份？",
    message: state.mode === "cloud"
      ? `将把备份恢复到当前云端账号（${store.user?.email || ""}）。当前模式：${overwrite ? "覆盖同 ID 记录" : "只补充缺失"}。`
      : "将把备份恢复到当前本地预览数据。",
    details: `<ul class="confirm-list">
      <li>商品：${inspection.data.data.products.length} 条</li>
      <li>收藏：${inspection.data.data.collections?.length || 0} 条，愿望：${inspection.data.data.wishlist?.length || 0} 条</li>
      <li>分类：${inspection.data.data.boardCategories?.length || 0} 个，归属：${inspection.data.data.boardAssignments?.length || 0} 条</li>
      <li>图片：${inspection.images.length} 个文件</li>
    </ul><p class="form-hint">恢复不会删除备份中不存在的现有商品；覆盖模式只影响同 ID 记录。</p>`,
    confirmLabel: "继续",
    danger: overwrite
  });
  if (!first) return;
  const second = await confirmAction({
    title: "再次确认恢复",
    message: "恢复过程可能持续数十秒，请不要关闭页面。完成后会显示逐项结果与错误报告。",
    confirmLabel: "确认恢复",
    danger: true,
    requireText: "恢复"
  });
  if (!second) return;

  dlg.dataset.busy = "1";
  $("restoreStart").disabled = true;
  $("restoreCancel").disabled = true;
  $("restoreClose").disabled = true;
  $("restoreBody").innerHTML = `<div class="backup-progress"><div class="backup-progress-track"><span id="restoreBar" style="width:2%"></span></div><div class="backup-progress-text" id="restoreProgressText">正在恢复…</div></div>`;
  try {
    const report = await restoreBackup({
      backend: state.backend,
      inspection,
      overwrite,
      onProgress: (p) => {
        const percent = p.total ? Math.round((p.current / p.total) * 100) : 0;
        const bar = $("restoreBar");
        if (bar) bar.style.width = `${Math.max(2, percent)}%`;
        const txt = $("restoreProgressText");
        if (txt) txt.textContent = p.message || "正在恢复…";
      }
    });
    await refreshData({ silent: true });
    const text = restoreReportText(report, inspection.summary);
    $("restoreBody").innerHTML = `<div class="backup-success">恢复完成：商品 ${report.products}，收藏 ${report.collections}，愿望 ${report.wishlist}，分类 ${report.categories}，图片 ${report.images}${report.failed ? `，失败 ${report.failed}` : ""}。</div>
      <div class="restore-report" style="margin-top:12px">${safe(text)}</div>
      <div class="xmx-modal-actions" style="padding:12px 0 0;border:0"><button class="outline-btn" id="downloadRestoreReport">下载恢复报告</button></div>`;
    $("downloadRestoreReport").addEventListener("click", () => {
      downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `xmx-restore-report-${Date.now()}.txt`);
    });
    $("restoreCancel").disabled = false;
    $("restoreClose").disabled = false;
    toast("备份恢复完成", "success");
  } catch (e) {
    console.error(e);
    $("restoreBody").innerHTML = `<div class="backup-warning">恢复失败：${safe(errorText(e))}<br>已恢复的数据不会自动回滚，请保留备份并查看浏览器控制台。</div>`;
    $("restoreCancel").disabled = false;
    $("restoreClose").disabled = false;
    toastError(e, "恢复失败");
  } finally {
    delete dlg.dataset.busy;
  }
}

/* -------------------------------------------------------------------------- */
/* 本机旧数据迁移向导                                                         */
/* -------------------------------------------------------------------------- */

function downloadLegacySnapshot(baseProducts, legacy, reason = "manual") {
  try {
    const payload = {
      format: "xmx-v4-premigration-snapshot",
      version: 1,
      exportedAt: new Date().toISOString(),
      reason,
      note: "迁移前数据快照：包含 V4 本机收藏/愿望/联动满赠分类与内置 1537 件商品数据。原始图片仍随项目 assets 保存，云端迁移不会删除本机数据。",
      baseProducts: baseProducts || [],
      legacy: {
        state: legacy.state || null,
        boards: legacy.boards || null,
        customProducts: legacy.customProducts || []
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const pad = (n) => String(n).padStart(2, "0");
    const d = new Date();
    downloadBlob(blob, `xmx-v4-premigration-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`);
  } catch (e) {
    console.warn("迁移前快照下载失败（不影响迁移，本机原数据未删除）", e);
  }
}

function showLegacyBanner() {
  if ($("legacyBanner") || state.legacyPrompted) return;
  state.legacyPrompted = true;
  const legacy = readLegacyLocalData();
  const summary = legacySummary(legacy, store.products.length);
  if (!legacy.hasAny) return;
  const el = document.createElement("div");
  el.id = "legacyBanner";
  el.className = "demo-banner";
  el.innerHTML = `<b>检测到本机 V4 数据</b><span>${summary.owned} 条收藏、${summary.wishlist} 条愿望、${summary.categories} 个自定义分类。可以合并到云端，不会覆盖已有数据。</span><button class="mini-btn" id="legacyMergeBtn">合并到云端</button><button class="link-btn" id="legacyDismissBtn">稍后</button>`;
  $("page-home")?.insertBefore(el, $("page-home").firstElementChild);
  $("legacyMergeBtn").addEventListener("click", openMigrationDialog);
  $("legacyDismissBtn").addEventListener("click", () => el.remove());
}

async function openMigrationDialog() {
  if (state.mode !== "cloud") {
    toast("本地预览模式无需迁移", "info");
    return;
  }
  const legacy = readLegacyLocalData();
  const summary = legacySummary(legacy, store.products.length);
  if (!legacy.hasAny) {
    await noticeDialog({
      title: "没有找到本机旧数据",
      message: "当前浏览器没有 V4 的收藏、愿望清单或联动/满赠分类记录。云端数据不受影响。"
    });
    return;
  }
  const ok = await confirmAction({
    title: "合并本机 V4 数据到云端？",
    message: "只补充云端缺少的记录，不会覆盖云端已有收藏和分类。本机原数据不会删除。",
    details: `<ul class="confirm-list">
      <li>本机收藏：${summary.owned} 条</li>
      <li>愿望清单：${summary.wishlist} 条</li>
      <li>联动/满赠分类：${summary.categories} 个，归属 ${summary.assignments} 条</li>
      <li>本机自定义商品：${summary.customProducts} 件</li>
    </ul>`,
    confirmLabel: "开始合并"
  });
  if (!ok) return;
  if (!state.lastSnapshot) return;
  let dlg = $("migrationDialog");  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "migrationDialog";
    dlg.className = "xmx-modal";
    dlg.innerHTML = `<div class="xmx-modal-inner"><div class="xmx-modal-head"><div><span class="eyebrow">MIGRATION</span><h2>合并本机旧数据</h2></div></div>
      <div class="xmx-modal-body"><div class="backup-progress"><div class="backup-progress-track"><span id="migrationBar" style="width:4%"></span></div><div class="backup-progress-text" id="migrationText">准备迁移…</div></div></div></div>`;
    document.body.appendChild(dlg);
  }
  if (!dlg.open) dlg.showModal();
  try {
    const baseProducts = await fetchBaseCatalog();
    downloadLegacySnapshot(baseProducts, legacy, "manual");
    const report = await migrateToCloud(state.backend, {
      snapshot: state.lastSnapshot,
      baseProducts,
      legacy,
      onProgress: (p) => {
        const bar = $("migrationBar");
        const pct = p.total ? Math.round((p.current / p.total) * 100) : 50;
        if (bar) bar.style.width = `${Math.max(4, pct)}%`;
        if ($("migrationText")) $("migrationText").textContent = p.message || "正在迁移…";
      }
    });
    await refreshData({ silent: true });
    document.querySelector("#migrationDialog .xmx-modal-body").innerHTML = `<div class="backup-success">合并完成：商品 ${report.products}，收藏 ${report.collections}，愿望 ${report.wishlist}，分类 ${report.categories}，归属 ${report.assignments}。</div>
      <p class="form-hint">本机旧数据已保留。以后可以在“账户 → 从本机旧数据合并”再次检查。</p>
      <div class="xmx-modal-actions" style="padding:12px 0 0;border:0"><button class="primary-btn" id="migrationDone">完成</button></div>`;
    $("migrationDone").addEventListener("click", () => $("migrationDialog").close());
    $("legacyBanner")?.remove();
    toast("本机旧数据已合并到云端", "success");
  } catch (e) {
    console.error(e);
    if ($("migrationText")) $("migrationText").textContent = `合并失败：${errorText(e)}`;
    toastError(e, "合并失败");
  }
}

/* -------------------------------------------------------------------------- */
/* 启动画面 / 清理                                                            */
/* -------------------------------------------------------------------------- */

function showBoot(text) {
  const el = $("bootScreen");
  if (!el) return;
  el.classList.remove("hidden", "done");
  const t = $("bootText");
  if (t) t.textContent = text;
}

function hideBoot() {
  const el = $("bootScreen");
  if (!el) return;
  el.classList.add("done");
  setTimeout(() => el.classList.add("hidden"), 350);
}

function showDemoBanner() {
  $("demoBanner")?.classList.remove("hidden");
}

function hideDemoIfCloud() {
  if (state.mode === "cloud") $("demoBanner")?.classList.add("hidden");
}

function showFatal(error) {
  const el = $("authGate");
  if (!el) return;
  el.classList.remove("hidden");
  $("authTitle").textContent = "网站初始化失败";
  $("authSub").textContent = "请检查 config.js、Supabase 数据库迁移和网络连接。";
  $("authForm").hidden = true;
  document.querySelector(".auth-tabs")?.classList.add("hidden");
  document.querySelector(".auth-links")?.classList.add("hidden");
  $("authMessage").textContent = errorText(error);
}

function teardownApp() {
  state.booted = false;
  state.booting = false;
  state.unsubscribeRealtime?.();
  state.unsubscribeRealtime = null;
  state.unsubscribeAuth?.();
  state.unsubscribeAuth = null;
  state.lastSnapshot = null;
  store.products = [];
  store.productMap.clear();
  store.collections.clear();
  store.wishlist.clear();
  store.assignments.clear();
  store.images.clear();
  store.user = null;
  $$("dialog").forEach((d) => { if (d.open) d.close(); });
  $("accountBtn").hidden = true;
  $("demoBanner")?.classList.add("hidden");
}
