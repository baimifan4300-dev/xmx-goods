/* 星愿收藏室 v2
 * 多作品/多角色 · 只读商品数据 + 本地收藏状态
 * 数据：data/works.json + data/<work>/<char>/products.json
 * 收藏：localStorage "xmx.collection.v1"
 */
const WORKS_URL = "data/works.json";
const STATE_KEY = "xmx.collection.v1";
const LEGACY_STATE_KEY = "xmx-goods-v1";
const LEGACY_PRODUCTS_KEY = "xmx-goods-products-v1";
const PAGE_SIZE = 60;

const V2_CSS = `
.works-section{margin:26px 0 0}
.works-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.work-block{border:1px solid var(--line);border-radius:16px;padding:14px;background:#fff;box-shadow:var(--shadow)}
.work-head{display:flex;justify-content:space-between;font-size:12px;color:#b09da5;margin-bottom:10px}
.char-row{display:flex;gap:8px;flex-wrap:wrap}
.char-chip{display:flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid #f0dfe5;border-radius:12px;text-decoration:none;color:var(--ink)}
.char-chip.active{border-color:var(--pink);background:var(--pale)}
.char-avatar{width:30px;height:30px;border-radius:50%;color:#fff;display:grid;place-items:center;font-size:13px}
.char-chip small{display:block;color:#b09da5;font-size:10px}
.product-image.crop-box{height:auto;aspect-ratio:4/5;display:block;padding:0;background:#fff}
.product-image .thumb-img{position:absolute;inset:0;margin:auto;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;background:#fff}
.locator{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;overflow:hidden}
.locator-inner{position:relative;height:100%;max-width:100%}
.locator-inner img{width:100%;height:100%;object-fit:contain;display:block}
.locator-box{position:absolute;border:1.5px solid #ff4d6d;border-radius:2px}
.locator-tag{position:absolute;right:6px;bottom:6px;font-size:9px;background:#ffffffcc;color:#a4647a;padding:1px 5px;border-radius:6px}
.pending-tag{position:absolute;left:8px;top:8px;background:#fff3cd;color:#8a6d3b;font-size:10px;padding:2px 6px;border-radius:8px}
.load-more{display:block;margin:18px auto 0}
#detailDialog{border:0;border-radius:20px;padding:0;max-width:min(900px,94vw);box-shadow:0 30px 80px #7a4a5c33;background:#fff}
#detailDialog::backdrop{background:transparent;backdrop-filter:none}
.detail-wrap{display:grid;grid-template-columns:1.05fr .95fr;position:relative}
.detail-image{position:relative;background:#fff;display:flex;align-items:flex-start;justify-content:center;max-height:72vh;overflow:auto}
.detail-image img{width:100%;height:auto;display:block}
.detail-mark{position:absolute;border:2px solid #ff4d6d;border-radius:3px;animation:pulse 2.4s infinite;pointer-events:none}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 #ff4d6d66}50%{box-shadow:0 0 0 7px #ff4d6d00}}
.detail-note{margin-top:8px;font-size:11px;color:#b08a99;background:#fff6f8;border:1px solid #f5e3e9;border-radius:10px;padding:6px 10px}
.detail-body{padding:24px 26px;overflow:auto;max-height:72vh}
.detail-body h2{margin:8px 0 10px;font-size:21px;line-height:1.4}
.detail-meta{display:flex;gap:8px;margin-bottom:12px}
.detail-fields{display:grid;gap:7px;font-size:12px;color:#8a7680}
.detail-fields .field{display:grid;grid-template-columns:78px 1fr;gap:8px;border-bottom:1px dashed #f2e3e8;padding-bottom:6px}
.detail-fields .field b{color:var(--ink);font-weight:500;word-break:break-all}
.own-form{display:grid;gap:8px;margin-top:14px;font-size:12px}
.own-form label{display:flex;gap:8px;align-items:center}
.own-form input{flex:1;border:1px solid #ead2da;border-radius:10px;padding:8px;font:inherit}
#detailDialog .close-btn{position:absolute;right:10px;top:8px;z-index:3;background:#fff;border-radius:50%;width:32px;height:32px;border:1px solid #eed7de;cursor:pointer}
@media(min-width:1150px){.product-grid{grid-template-columns:repeat(6,1fr)}}
@media(max-width:720px){.detail-wrap{grid-template-columns:1fr}.detail-body{max-height:45vh}.detail-image{max-height:45vh}}
`;

const $ = (id) => document.getElementById(id);
const safe = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let works = [];
let ctx = { work: null, char: null, products: [], catalogLoading: false };
let state = { version: 1, owned: {}, wishlist: [] };
let view = { q: "", cat: "", status: "", sort: "name", limit: PAGE_SIZE };

/* ---------------- 状态 ---------------- */
function loadState() {
  try {
    state = JSON.parse(localStorage.getItem(STATE_KEY) || "null") || state;
  } catch (e) { console.warn("收藏数据读取失败", e); }
  if (!state.owned || typeof state.owned !== "object") state.owned = {};
  if (!Array.isArray(state.wishlist)) state.wishlist = [];
  migrateLegacy();
}

function migrateLegacy() {
  if (localStorage.getItem(STATE_KEY)) { cleanupLegacy(); return; }
  try {
    const old = JSON.parse(localStorage.getItem(LEGACY_STATE_KEY) || "null");
    let changed = false;
    if (old) {
      if (Array.isArray(old.owned)) old.owned.forEach((id) => { state.owned[id] = state.owned[id] || {}; changed = true; });
      if (Array.isArray(old.wishlist)) old.wishlist.forEach((id) => { if (!state.wishlist.includes(id)) state.wishlist.push(id); changed = true; });
    }
    if (changed) localStorage.setItem(STATE_KEY, JSON.stringify(state));
    cleanupLegacy();
  } catch (e) { console.warn("旧收藏数据迁移失败", e); }
}

function cleanupLegacy() {
  // 只清理旧收藏状态键；旧商品缓存保留，避免误删用户手工加过的数据
  if (localStorage.getItem(LEGACY_STATE_KEY)) localStorage.removeItem(LEGACY_STATE_KEY);
}

function saveState() {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  renderAll();
}

const isOwned = (id) => Object.prototype.hasOwnProperty.call(state.owned, id);
const isWish = (id) => state.wishlist.includes(id);

function toggleOwned(id) {
  if (isOwned(id)) delete state.owned[id];
  else { state.owned[id] = { price: null, date: "", note: "" }; state.wishlist = state.wishlist.filter((x) => x !== id); }
  saveState();
  toast(isOwned(id) ? "已加入我的收藏" : "已从收藏中移除");
}

function toggleWish(id) {
  if (isWish(id)) state.wishlist = state.wishlist.filter((x) => x !== id);
  else state.wishlist.push(id);
  saveState();
  toast(isWish(id) ? "已加入愿望清单" : "已移出愿望清单");
}

/* ---------------- 工具 ---------------- */
function toast(msg) {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2100);
}

function mediaHTML(p) {
  const im = p.image || {};
  if (!im.src) return "";
  if (im.sharp && im.thumb) {
    return `<img class="thumb-img" src="${safe(im.thumb)}" alt="${safe(p.name || "待识别")}" loading="lazy">`;
  }
  const iw = im.imageWidth, ih = im.imageHeight;
  const box = `left:${(im.x / iw) * 100}%;top:${(im.y / ih) * 100}%;width:${(im.width / iw) * 100}%;height:${(im.height / ih) * 100}%`;
  return `<div class="locator"><div class="locator-inner" style="aspect-ratio:${iw}/${ih}">
    <img src="${safe(im.src)}" alt="合集图定位" loading="lazy"><span class="locator-box" style="${box}"></span>
  </div><span class="locator-tag">合集定位</span></div>`;
}

function priceLabel(p) {
  if (p.price != null) return `¥ ${Number(p.price).toFixed(2)}`;
  if (p.priceText) return safe(p.priceText);
  return "价格待补充";
}

function cardHTML(p) {
  const owned = isOwned(p.id), wish = isWish(p.id);
  const tag = p.categoryLabel || "其他";
  return `<article class="product-card" data-open="${safe(p.id)}">
    <div class="product-image crop-box">${mediaHTML(p)}
      <span class="product-tag">${safe(tag)}</span>
      ${p.verificationStatus === "pending" ? '<span class="pending-tag">待核实</span>' : ""}
    </div>
    <div class="product-info"><h3>${safe(p.name || "待识别")}</h3>
      <div class="product-meta">${safe(p.series || p.folder || "未填写系列")}${p.productCode ? ` · ${safe(p.productCode)}` : ""}</div>
      <div class="product-price">${priceLabel(p)}</div></div>
    <div class="card-actions">
      <button class="mini-btn ${owned ? "active" : ""}" data-action="owned" data-id="${safe(p.id)}">${owned ? "✓ 已拥有" : "+ 已拥有"}</button>
      <button class="mini-btn ${wish ? "active" : ""}" data-action="wish" data-id="${safe(p.id)}">${wish ? "★ 已心愿" : "☆ 想要"}</button>
      <button class="mini-btn" data-action="detail" data-id="${safe(p.id)}" aria-label="详情">⋯</button>
    </div>
  </article>`;
}

/* ---------------- 过滤 ---------------- */
function filteredProducts() {
  const q = view.q.toLowerCase();
  let list = ctx.products.filter((p) => {
    if (q) {
      const hay = [p.name, p.series, p.productCode, p.notes, p.folder].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (view.cat && p.category !== view.cat) return false;
    if (view.status === "owned" && !isOwned(p.id)) return false;
    if (view.status === "wish" && !isWish(p.id)) return false;
    if (view.status === "none" && (isOwned(p.id) || isWish(p.id))) return false;
    return true;
  });
  if (view.sort === "price") list.sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
  else if (view.sort === "newest") list.sort((a, b) => String(b.id).localeCompare(String(a.id)));
  else list.sort((a, b) => {
    if (!a.name && b.name) return 1;
    if (a.name && !b.name) return -1;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
  });
  return list;
}

/* ---------------- 渲染 ---------------- */
function currentCharRoute(page) {
  let w = ctx.work, c = ctx.char;
  if (!w || !c) {
    w = works[0];
    c = w && w.characters[0];
  }
  if (!w || !c) return "#/";
  return page ? `#/w/${w.id}/c/${c.id}/${page}` : `#/w/${w.id}/c/${c.id}`;
}

function renderWorksStrip() {
  const el = $("worksStrip");
  if (!el) return;
  el.innerHTML = works.map((w) => `
    <div class="work-block">
      <div class="work-head"><b>${safe(w.title)}</b><span>${w.characters.length} 位角色</span></div>
      <div class="char-row">${w.characters.map((c) => {
        const active = ctx.char && ctx.char.id === c.id;
        return `<a class="char-chip ${active ? "active" : ""}" href="#/w/${w.id}/c/${c.id}">
          <span class="char-avatar" style="background:${safe(c.theme?.["--pink"] || "#e8b9c9")}">${safe((c.name || "?").slice(0, 1))}</span>
          <span><b>${safe(c.name)}</b><small>${c.total || 0} 件</small></span></a>`;
      }).join("")}</div>
    </div>`).join("");
}

function renderCatalog() {
  const list = filteredProducts();
  const shown = list.slice(0, view.limit);
  $("productGrid").innerHTML = shown.map(cardHTML).join("");
  $("catalogEmpty").classList.toggle("hidden", list.length > 0);
  const more = $("loadMoreBtn");
  if (more) {
    more.classList.toggle("hidden", shown.length >= list.length);
    more.textContent = `加载更多（${shown.length}/${list.length}）`;
  }
  $("resultCount").textContent = `${list.length} 件商品`;
}

function renderGrid(id, items, emptyId) {
  $(id).innerHTML = items.map(cardHTML).join("");
  $(emptyId).classList.toggle("hidden", items.length > 0);
}

function renderProgress() {
  const total = ctx.products.length;
  const owned = ctx.products.filter((p) => isOwned(p.id)).length;
  const rate = total ? Math.round((owned / total) * 100) : 0;
  $("progressText").innerHTML = `${rate}% <small>COLLECTED</small>`;
  $("progressDetail").textContent = `已拥有 ${owned} / ${total} 件商品`;
  $("bigProgressBar").style.width = rate + "%";
  const cats = [...new Set(ctx.products.map((p) => p.category))];
  const labels = {};
  ctx.products.forEach((p) => { labels[p.category] = p.categoryLabel || p.category; });
  $("categoryProgressList").innerHTML = cats.map((cat) => {
    const all = ctx.products.filter((p) => p.category === cat);
    const got = all.filter((p) => isOwned(p.id)).length;
    const pct = all.length ? Math.round((got / all.length) * 100) : 0;
    return `<div class="progress-row"><span>${safe(labels[cat] || cat)}</span><div class="progress-track"><span style="width:${pct}%"></span></div><span>${got}/${all.length}</span></div>`;
  }).join("");
}

function renderAll() {
  const total = ctx.products.length;
  const owned = ctx.products.filter((p) => isOwned(p.id)).length;
  $("totalCount").textContent = total;
  $("ownedCount").textContent = owned;
  $("wishCount").textContent = ctx.products.filter((p) => isWish(p.id)).length;
  $("rateCount").textContent = (total ? Math.round((owned / total) * 100) : 0) + "%";
  renderWorksStrip();
  if (ctx.products.length) {
    renderCatalog();
    renderGrid("ownedGrid", ctx.products.filter((p) => isOwned(p.id)), "ownedEmpty");
    renderGrid("wishlistGrid", ctx.products.filter((p) => isWish(p.id)), "wishlistEmpty");
    renderProgress();
  }
}

/* ---------------- 数据 ---------------- */
async function loadWorks() {
  const res = await fetch(WORKS_URL);
  if (!res.ok) throw new Error("works.json 读取失败");
  const data = await res.json();
  works = Array.isArray(data) ? data : (data.works || []);
}

async function loadCatalog(work, char) {
  if (ctx.catalogLoading) return;
  if (ctx.char && ctx.char.id === char.id && ctx.products.length) return;
  ctx.catalogLoading = true;
  try {
    const res = await fetch(char.catalog);
    if (!res.ok) throw new Error(char.catalog + " 读取失败");
    ctx.products = await res.json();
    ctx.work = work; ctx.char = char;
    view.limit = PAGE_SIZE;
  } finally { ctx.catalogLoading = false; }
}

/* ---------------- 路由 ---------------- */
function parseHash() {
  const m = location.hash.match(/^#\/w\/([^/]+)(?:\/c\/([^/]+))?(?:\/(\w+))?/);
  return m ? { workId: m[1], charId: m[2] || null, page: m[3] || "" } : null;
}

async function applyRoute() {
  const r = parseHash();
  const work = r ? (works.find((w) => w.id === r.workId) || works[0]) : works[0];
  const char = work ? (work.characters.find((c) => c.id === (r && r.charId)) || work.characters[0]) : null;
  if (!work || !char) { showPage("home"); return; }
  await loadCatalog(work, char);
  applyTheme(char);
  fillCategoryFilter();
  showPage(r ? (r.page || "home") : "home");
  renderAll();
}

function showPage(page) {
  const map = { home: "home", catalog: "catalog", owned: "owned", wishlist: "wishlist", progress: "progress" };
  const target = "page-" + (map[page] || "home");
  document.querySelectorAll(".page").forEach((el) => el.classList.toggle("active", el.id === target));
  document.querySelectorAll(".nav-link").forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  $("mainNav").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function applyTheme(char) {
  const root = document.documentElement;
  Object.entries(char.theme || {}).forEach(([k, v]) => root.style.setProperty(k, v));
  const name = char.name || "";
  document.title = `星愿收藏室 · ${name}谷子图鉴`;
  document.querySelectorAll(".hero-card-name").forEach((el) => { el.textContent = name; });
  const heroP = document.querySelector(".hero-copy p");
  if (heroP) heroP.textContent = `每一份心动都有自己的位置。欢迎来到专属于你的${name}收藏室。`;
}

function go(page) {
  location.hash = currentCharRoute(page);
}

/* ---------------- 详情 ---------------- */
function ensureDetailDialog() {
  if ($("detailDialog")) return;
  const el = document.createElement("dialog");
  el.id = "detailDialog";
  el.innerHTML = `<div class="detail-wrap">
    <button class="close-btn" id="detailClose" aria-label="关闭">×</button>
    <div class="detail-image" id="detailImage"></div>
    <div class="detail-body">
      <div class="eyebrow">PRODUCT DETAIL</div>
      <h2 id="detailName"></h2>
      <div id="detailMeta" class="detail-meta"></div>
      <div id="detailNote"></div>
      <div id="detailFields" class="detail-fields"></div>
      <div class="detail-own" id="detailOwn"></div>
    </div></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (e) => { if (e.target === el) el.close(); });
  el.querySelector("#detailClose").addEventListener("click", () => el.close());
}

function openDetail(id) {
  const p = ctx.products.find((x) => x.id === id);
  if (!p) return;
  ensureDetailDialog();
  const dlg = $("detailDialog");
  const im = p.image;
  const img = im.src ? `<img src="${safe(im.src)}" alt="${safe(p.name)}" id="detailImg">` : "";
  $("detailImage").innerHTML = img + (im.src ? `<div class="detail-mark" id="detailMark"></div>` : "");
  if (im.src) {
    const el = $("detailImg");
    const place = () => {
      const m = $("detailMark");
      if (!m || !el.clientWidth) return;
      const scale = el.clientWidth / im.imageWidth;
      m.style.left = `${im.x * scale}px`;
      m.style.top = `${im.y * scale}px`;
      m.style.width = `${im.width * scale}px`;
      m.style.height = `${im.height * scale}px`;
    };
    el.onload = place;
    if (el.complete) place();
    window.addEventListener("resize", place, { once: true });
  }
  $("detailName").textContent = p.name || "待识别";
  $("detailMeta").innerHTML = `<span class="product-tag">${safe(p.categoryLabel)}</span>${p.verificationStatus === "pending" ? '<span class="pending-tag">待核实</span>' : ""}`;
  $("detailNote").innerHTML = p.image.sharp ? "" : `<div class="detail-note">该商品在原合集中可见像素较少，按清晰度规则不单独放大裁剪；上方整图红框是它的位置。</div>`;
  const rows = [
    ["ID", p.id], ["系列", p.series || "—"], ["版本", p.version || "—"],
    ["价格", p.price != null ? `¥${p.price}` : (p.priceText || "—")],
    ["价格原文", p.priceText || "—"], ["编号", p.productCode || "—"],
    ["发售日期", p.releaseDate || "—"], ["来源文件夹", p.folder || "—"],
    ["同名候选", p.duplicateGroup || "—"], ["图注/备注", p.notes || "—"],
  ];
  $("detailFields").innerHTML = rows.map(([k, v]) => `<div class="field"><span>${safe(k)}</span><b>${safe(v)}</b></div>`).join("");
  const own = state.owned[p.id];
  $("detailOwn").innerHTML = isOwned(p.id)
    ? `<div class="own-form"><label>购入价 <input type="number" id="ownPrice" value="${own?.price ?? ""}" step="0.01"></label>
       <label>入手日期 <input type="date" id="ownDate" value="${own?.date || ""}"></label>
       <label>备注 <input id="ownNote" value="${safe(own?.note || "")}"></label>
       <button class="primary-btn" id="saveOwn">保存收藏信息</button></div>`
    : `<button class="primary-btn" id="ownFromDetail">加入我的收藏</button>`;
  if (!$("detailDialog").open) dlg.showModal();
  $("saveOwn")?.addEventListener("click", () => {
    state.owned[p.id] = { price: $("ownPrice").value ? Number($("ownPrice").value) : null, date: $("ownDate").value, note: $("ownNote").value };
    saveState(); toast("收藏信息已保存");
  });
  $("ownFromDetail")?.addEventListener("click", () => { toggleOwned(p.id); openDetail(p.id); });
}

/* ---------------- 导出/导入 ---------------- */
function exportBackup() {
  const payload = { version: 1, exportedAt: new Date().toISOString(), collection: state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "xmx-collection-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const c = data.collection || data.state || data;
      if (!c || !c.owned || !Array.isArray(c.wishlist)) throw new Error("bad format");
      state = { version: 1, owned: c.owned, wishlist: c.wishlist };
      saveState(); toast("收藏数据导入成功");
    } catch (e) { toast("文件格式不正确，无法导入"); }
  };
  reader.readAsText(file);
}

/* ---------------- 初始化 ---------------- */
document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-page]");
  if (nav) { go(nav.dataset.page); return; }
  const goBtn = e.target.closest("[data-go]");
  if (goBtn) { go(goBtn.dataset.go); return; }
  const action = e.target.closest("[data-action]");
  if (action) {
    const id = action.dataset.id;
    if (action.dataset.action === "owned") toggleOwned(id);
    if (action.dataset.action === "wish") toggleWish(id);
    if (action.dataset.action === "detail") openDetail(id);
    return;
  }
  const card = e.target.closest("[data-open]");
  if (card) openDetail(card.dataset.open);
});

$("menuToggle").addEventListener("click", () => $("mainNav").classList.toggle("open"));
["searchInput", "categoryFilter", "statusFilter", "sortFilter"].forEach((id) => $(id)?.addEventListener("input", () => {
  view.q = $("searchInput").value.trim();
  view.cat = $("categoryFilter").value;
  view.status = $("statusFilter").value;
  view.sort = $("sortFilter").value;
  view.limit = PAGE_SIZE;
  renderCatalog();
}));
$("addProductBtn")?.addEventListener("click", () => toast("商品资料由 JSON 统一维护，暂不支持站内新增"));
$("emptyAddBtn")?.addEventListener("click", () => toast("商品资料由 JSON 统一维护，暂不支持站内新增"));
$("closeDialog")?.addEventListener("click", () => $("productDialog")?.close());
$("cancelDialog")?.addEventListener("click", () => $("productDialog")?.close());
$("productForm")?.addEventListener("submit", (e) => { e.preventDefault(); toast("商品资料由 JSON 统一维护"); });

window.addEventListener("hashchange", applyRoute);

(async () => {
  loadState();
  injectShell();
  try {
    await loadWorks();
    fillCategoryFilter();
    await applyRoute();
    const did = new URLSearchParams(location.search).get("detail");
    if (did) setTimeout(() => openDetail(did), 300);
  } catch (e) {
    console.error(e);
    toast("数据加载失败：" + e.message);
  }
})();

function injectShell() {
  if (!document.getElementById("v2-style")) {
    const st = document.createElement("style");
    st.id = "v2-style";
    st.textContent = V2_CSS;
    document.head.appendChild(st);
  }
  // 作品/角色入口 + 导出导入（不改变原 HTML 结构）
  const home = $("page-home");
  if (home && !$("worksStrip")) {
    const sec = document.createElement("section");
    sec.className = "works-section";
    sec.innerHTML = `<div class="section-heading"><div><span class="eyebrow">WORKS & CHARACTERS</span><h2>作品与角色</h2></div>
      <span class="muted"><button class="mini-btn" id="exportBtn">导出收藏</button> <label class="mini-btn">导入<input type="file" id="importFile" accept="application/json" hidden></label></span></div>
      <div id="worksStrip" class="works-strip"></div>`;
    home.insertBefore(sec, home.querySelector(".hero"));
    sec.querySelector("#exportBtn").addEventListener("click", exportBackup);
    sec.querySelector("#importFile").addEventListener("change", (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); });
  }
  // 加载更多
  if ($("productGrid") && !$("loadMoreBtn")) {
    const btn = document.createElement("button");
    btn.id = "loadMoreBtn";
    btn.className = "outline-btn load-more";
    btn.textContent = "加载更多";
    btn.addEventListener("click", () => { view.limit += PAGE_SIZE; renderCatalog(); });
    $("productGrid").after(btn);
  }
}

function fillCategoryFilter() {
  const sel = $("categoryFilter");
  if (!sel || !ctx.products.length) return;
  const map = {};
  ctx.products.forEach((p) => { map[p.category] = p.categoryLabel; });
  sel.innerHTML = '<option value="">全部类别</option>' + Object.entries(map).map(([k, v]) => `<option value="${k}">${safe(v)}</option>`).join("");
  if (view.cat) sel.value = view.cat;
  else sel.value = "";
}
