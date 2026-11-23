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
import { SupabaseBackend } from "./cloud-supabase.js";
import { LocalBackend } from "./cloud-local.js";
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

  state.backend = new SupabaseBackend(config);
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

async function bootApp() {
  if (state.booted || state.booting) return;
  state.booting = true;
  showBoot("正在连接云端收藏室…");
  try {
    let snapshot = await state.backend.loadSnapshot();
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
      snapshot = await state.backend.loadSnapshot();
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
      snapshot = await state.backend.loadSnapshot();
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
  store.mainCategories = normalizeMainCategories(snapshot.mainCategories);
  store.works = normalizeWorks(snapshot.works, snapshot.characters);
  store.characters = snapshot.characters || [];
  store.localCategories = staticConfig.categories;
}

function normalizeMainCategories(rows) {
  const list = (rows || []).filter((r) => r?.key && r?.label).map((r, i) => ({
    key: r.key, label: r.label, order: Number(r.sort_order ?? r.order ?? i + 1)
  })).sort((a, b) => a.order - b.order);
  if (list.length === 20) return list;
  return staticConfig.categories.main.map((c, i) => ({ ...c, order: i + 1 }));
}

function normalizeWorks(cloudWorks, cloudCharacters) {
  if (Array.isArray(cloudWorks) && cloudWorks.length) {
    return cloudWorks.map((w, wi) => ({
      ...w,
      id: w.id,
      title: w.title,
      sort_order: w.sort_order ?? wi + 1,
      characters: (cloudCharacters || []).filter((c) => c.work_id === w.id).map((c, ci) => ({
        id: c.id, name: c.name, theme: c.theme || {}, total: c.total || 0,
        catalog: c.catalog || `data/${w.id}/${c.id}/products.json`,
        sort_order: c.sort_order ?? ci + 1
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
      <span class="muted"><button class="mini-btn" id="openDataBtn">数据与备份</button></span>
    </div><div id="worksStrip" class="works-strip"></div>`;
    home.insertBefore(section, home.querySelector(".hero"));
    section.querySelector("#openDataBtn").addEventListener("click", openAccountDialog);
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

function renderAll() {
  if (!state.booted) return;
  const total = store.products.length;
  const ownedKinds = store.collections.size;
  const ownedPieces = [...store.collections.values()].reduce((sum, c) => sum + (Number(c.quantity) || 1), 0);
  $("totalCount").textContent = total;
  $("ownedCount").textContent = ownedKinds;
  $("wishCount").textContent = store.wishlist.size;
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
  renderGrid("ownedGrid", store.products.filter((p) => store.collections.has(p.id)), "ownedEmpty", true);
  renderGrid("wishlistGrid", store.products.filter((p) => store.wishlist.has(p.id)), "wishlistEmpty", false);
  renderProgress();
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
          <span><b>${safe(c.name)}</b><small>${(c.total || (state.currentChar?.id === c.id ? store.products.length : 0))} 件</small></span></a>`;
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
  const total = store.products.length;
  const owned = store.collections.size;
  const rate = total ? Math.round((owned / total) * 100) : 0;
  $("progressText").innerHTML = `${rate}% <small>COLLECTED</small>`;
  $("progressDetail").textContent = `已拥有 ${owned} / ${total} 种商品，共 ${[...store.collections.values()].reduce((s, c) => s + (Number(c.quantity) || 1), 0)} 件`;
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
    const all = store.products.filter(g.match);
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
  return p.mainCategory || p.board || p.categoryLabel || "其他";
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
  const card = event.target.closest("[data-open]");
  if (card) openDetail(card.dataset.open);
}

function go(page) {
  location.hash = currentCharRoute(page);
  if (state.booted) setTimeout(() => { showPage(page); renderAll(); }, 20);
}

function showPage(page) {
  const map = { home: "home", catalog: "catalog", owned: "owned", wishlist: "wishlist", progress: "progress" };
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
    ["主分类", product.mainCategory || "—"],
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
    const snapshot = await state.backend.loadSnapshot();
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
