const STORAGE_KEY = "xmx-goods-v1";
const CATEGORIES = ["徽章/吧唧","立牌","挂件","纸类","毛绒","其他"];
let products = [];
let state = { owned: [], wishlist: [] };

const $ = (id) => document.getElementById(id);
const safe = (s="") => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function loadState(){
  try { state = {...state, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")}; }
  catch(e){ console.warn("本地收藏数据读取失败", e); }
  if(!Array.isArray(state.owned)) state.owned=[];
  if(!Array.isArray(state.wishlist)) state.wishlist=[];
}
function saveState(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); renderAll(); }
function toast(msg){ const el=$("toast"); el.textContent=msg; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2100); }

async function loadProducts(){
  try {
    const res = await fetch("data/products.json");
    if(!res.ok) throw new Error("products.json unavailable");
    const data = await res.json();
    products = Array.isArray(data) ? data : (data.products || []);
  } catch(e) {
    products = [];
    console.warn("商品数据未加载：", e);
  }
}
function isOwned(id){ return state.owned.includes(id); }
function isWish(id){ return state.wishlist.includes(id); }
function toggle(listName,id){
  const list=state[listName], i=list.indexOf(id);
  if(i>=0) list.splice(i,1); else list.push(id);
  saveState();
  toast(listName==="owned" ? (i>=0?"已从收藏中移除":"已加入我的收藏") : (i>=0?"已移出愿望清单":"已加入愿望清单"));
}
function productCard(p){
  const owned=isOwned(p.id), wish=isWish(p.id);
  const image=p.image ? `<img src="${safe(p.image)}" alt="${safe(p.name)}" loading="lazy" onerror="this.remove()">` : `<span class="image-placeholder">✧</span>`;
  return `<article class="product-card">
    <div class="product-image">${image}<span class="product-tag">${safe(p.category||"其他")}</span></div>
    <div class="product-info"><h3>${safe(p.name)}</h3><div class="product-meta">${safe(p.series||"未填写系列")}${p.code?` · ${safe(p.code)}`:""}</div><div class="product-price">${p.price!=="" && p.price!=null ? `¥ ${Number(p.price).toFixed(2)}` : "价格待补充"}</div></div>
    <div class="card-actions">
      <button class="mini-btn ${owned?"active":""}" data-action="owned" data-id="${safe(p.id)}">${owned?"✓ 已拥有":"+ 已拥有"}</button>
      <button class="mini-btn ${wish?"active":""}" data-action="wish" data-id="${safe(p.id)}">${wish?"★ 已心愿":"☆ 想要"}</button>
      <button class="mini-btn" data-action="edit" data-id="${safe(p.id)}" aria-label="编辑">✎</button>
    </div>
  </article>`;
}
function renderGrid(id,items,emptyId){
  $(id).innerHTML=items.map(productCard).join("");
  $(emptyId).classList.toggle("hidden",items.length>0);
}
function renderCatalog(){
  const q=$("searchInput").value.trim().toLowerCase(), cat=$("categoryFilter").value, status=$("statusFilter").value, sort=$("sortFilter").value;
  let list=products.filter(p=>{
    const hay=[p.name,p.series,p.code,p.category].join(" ").toLowerCase();
    return (!q||hay.includes(q))&&(!cat||p.category===cat)&&(!status||(status==="owned"?isOwned(p.id):status==="wish"?isWish(p.id):!isOwned(p.id)&&!isWish(p.id)));
  });
  if(sort==="price") list.sort((a,b)=>(Number(a.price)||0)-(Number(b.price)||0));
  else if(sort==="newest") list.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  else list.sort((a,b)=>(a.name||"").localeCompare(b.name||"","zh-CN"));
  $("productGrid").innerHTML=list.map(productCard).join("");
  $("catalogEmpty").classList.toggle("hidden",list.length>0);
  $("resultCount").textContent=`${list.length} 件商品`;
}
function renderProgress(){
  const total=products.length, owned=products.filter(p=>isOwned(p.id)).length, rate=total?Math.round(owned/total*100):0;
  $("progressText").innerHTML=`${rate}% <small>COLLECTED</small>`;
  $("progressDetail").textContent=`已拥有 ${owned} / ${total} 件商品`;
  $("bigProgressBar").style.width=rate+"%";
  $("categoryProgressList").innerHTML=CATEGORIES.map(cat=>{
    const all=products.filter(p=>p.category===cat).length, got=products.filter(p=>p.category===cat&&isOwned(p.id)).length, pct=all?Math.round(got/all*100):0;
    return `<div class="progress-row"><span>${cat}</span><div class="progress-track"><span style="width:${pct}%"></span></div><span>${got}/${all}</span></div>`;
  }).join("");
}
function renderAll(){
  $("totalCount").textContent=products.length;
  $("ownedCount").textContent=products.filter(p=>isOwned(p.id)).length;
  $("wishCount").textContent=products.filter(p=>isWish(p.id)).length;
  const rate=products.length?Math.round(products.filter(p=>isOwned(p.id)).length/products.length*100):0;
  $("rateCount").textContent=rate+"%";
  renderCatalog();
  renderGrid("ownedGrid",products.filter(p=>isOwned(p.id)),"ownedEmpty");
  renderGrid("wishlistGrid",products.filter(p=>isWish(p.id)),"wishlistEmpty");
  renderProgress();
}
function go(page){
  document.querySelectorAll(".page").forEach(el=>el.classList.toggle("active",el.id==="page-"+page));
  document.querySelectorAll(".nav-link").forEach(el=>el.classList.toggle("active",el.dataset.page===page));
  $("mainNav").classList.remove("open");
  window.scrollTo({top:0,behavior:"smooth"});
}
function openForm(p=null){
  $("productForm").reset(); $("editId").value=p?.id||"";
  $("pName").value=p?.name||""; $("pCategory").value=p?.category||"徽章/吧唧";
  $("pSeries").value=p?.series||""; $("pPrice").value=p?.price??"";
  $("pCode").value=p?.code||""; $("pImage").value=p?.image||""; $("pNote").value=p?.note||"";
  $("productDialog").showModal();
}
function saveProduct(e){
  e.preventDefault();
  const id=$("editId").value||("p_"+Date.now().toString(36)+Math.random().toString(36).slice(2,6));
  const item={id,name:$("pName").value.trim(),category:$("pCategory").value,series:$("pSeries").value.trim(),price:$("pPrice").value===""?"":Number($("pPrice").value),code:$("pCode").value.trim(),image:$("pImage").value.trim(),note:$("pNote").value.trim(),createdAt:Date.now()};
  if(!item.name){toast("请填写商品名称");return;}
  const idx=products.findIndex(x=>x.id===id);
  if(idx>=0){item.createdAt=products[idx].createdAt||Date.now();products[idx]=item;}else products.push(item);
  // 商品数据与收藏状态均保存在当前设备，导出备份可迁移。
  localStorage.setItem("xmx-goods-products-v1",JSON.stringify(products));
  $("productDialog").close(); renderAll(); toast(idx>=0?"商品资料已更新":"商品已添加");
}
function exportBackup(){
  const payload={version:1,exportedAt:new Date().toISOString(),products,state};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="xmx-goods-backup.json";a.click();URL.revokeObjectURL(a.href);
}
function importBackup(file){
  const reader=new FileReader();
  reader.onload=()=>{try{const data=JSON.parse(reader.result);if(!Array.isArray(data.products)||!data.state)throw new Error();products=data.products;state={...state,...data.state};localStorage.setItem("xmx-goods-products-v1",JSON.stringify(products));saveState();toast("备份导入成功");}catch(e){toast("文件格式不正确，无法导入");}};
  reader.readAsText(file);
}
document.addEventListener("click",e=>{
  const nav=e.target.closest("[data-page]"); if(nav) go(nav.dataset.page);
  const goBtn=e.target.closest("[data-go]"); if(goBtn) go(goBtn.dataset.go);
  const action=e.target.closest("[data-action]");
  if(action){const p=products.find(x=>x.id===action.dataset.id);if(!p)return;
    if(action.dataset.action==="owned")toggle("owned",p.id);
    if(action.dataset.action==="wish")toggle("wishlist",p.id);
    if(action.dataset.action==="edit")openForm(p);
  }
});
$("menuToggle").addEventListener("click",()=>$("mainNav").classList.toggle("open"));
["searchInput","categoryFilter","statusFilter","sortFilter"].forEach(id=>$(id).addEventListener("input",renderCatalog));
$("addProductBtn").addEventListener("click",()=>openForm());
$("emptyAddBtn").addEventListener("click",()=>openForm());
$("closeDialog").addEventListener("click",()=>$("productDialog").close());
$("cancelDialog").addEventListener("click",()=>$("productDialog").close());
$("productForm").addEventListener("submit",saveProduct);

// 优先读取本地编辑后的商品数据；首次使用时再读取仓库内的 JSON。
(async()=>{
  loadState();
  const localProducts=localStorage.getItem("xmx-goods-products-v1");
  if(localProducts){try{products=JSON.parse(localProducts);}catch(e){await loadProducts();}}
  else await loadProducts();
  renderAll();
})();
