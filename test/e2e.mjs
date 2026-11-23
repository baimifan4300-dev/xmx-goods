import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const base = "http://127.0.0.1:8765/?demo=1#/w/gyly/c/xmx/catalog";
const artifacts = path.resolve("test-artifacts");
fs.mkdirSync(artifacts, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  console.log(`  ✓ ${message}`);
}

async function waitApp(page) {
  await page.goto(base, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForFunction(() => {
    const boot = document.querySelector("#bootScreen");
    return boot && boot.classList.contains("hidden") && document.querySelector("#totalCount")?.textContent !== "0";
  }, null, { timeout: 120000 });
  await page.waitForTimeout(800);
}

async function search(page, text) {
  await page.fill("#searchInput", text);
  await page.waitForTimeout(300);
}

async function openFirstDetail(page) {
  await page.locator("#productGrid .product-card").first().click();
  await page.locator("#detailDialog[open]").waitFor({ timeout: 5000 });
}

async function closeDialog(page, id) {
  const dlg = page.locator(`#${id}`);
  if (await dlg.evaluate((el) => el.open).catch(() => false)) {
    await page.locator(`#${id} .close-btn`).first().click();
    await page.waitForTimeout(250);
  }
}

const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"]
});
const context = await browser.newContext({ viewport: { width: 1280, height: 1100 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack || e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

console.log("1. 初始化与原有数据");
await waitApp(page);
assert(await page.locator("#totalCount").textContent() === "1537", "1537 件商品完整显示");
assert(await page.locator("#productGrid .product-card").count() === 60, "首屏分页 60 件");
assert(await page.locator("#categoryFilter optgroup[label='主分类'] option").count() === 20, "20 个主分类");
assert(await page.locator("#categoryFilter optgroup[label='独立板块'] option").count() === 2, "联动/满赠板块存在");

console.log("2. 原有详情与合集红框");
await openFirstDetail(page);
assert(await page.locator("#detailName").textContent() !== "", "详情标题显示");
assert(await page.locator("#detailPriceCards .price-box").count() === 2, "市场价格与实际购买价独立显示");
assert(await page.locator("#detailFields .field").count() >= 10, "原有字段完整显示");
await page.screenshot({ path: path.join(artifacts, "v5-detail.png") });
await closeDialog(page, "detailDialog");

console.log("2b. 图片上传 / 替换 / 删除 / 恢复合集图");
await openFirstDetail(page);
await page.locator("#detailImageManage").click();
await page.locator("#imageManagerDialog[open]").waitFor();
await page.setInputFiles("#imgMgrFile", "assets/works/gyly/xmx/thumbs/B01-001.jpg");
await page.waitForTimeout(2500);
assert((await page.locator("#imgMgrBody").textContent()).includes("高清独立图"), "高清图上传成功");
await page.locator("#imgMgrDelete").click();
await page.locator("#xmxConfirmDialog[open]").waitFor();
await page.locator("#xmxConfirmOk").click();
await page.waitForTimeout(1800);
assert((await page.locator("#imgMgrBody").textContent()).includes("原始合集图"), "删除高清图后恢复合集图");
await closeDialog(page, "imageManagerDialog");
await closeDialog(page, "detailDialog");

console.log("2c. 原始商品删除二次确认（取消路径）");
await openFirstDetail(page);
await page.locator("#detailDelete").click();
await page.locator("#xmxConfirmDialog[open]").waitFor();
await page.locator("#xmxConfirmOk").click();
await page.waitForFunction(() => document.querySelector("#xmxConfirmTitle")?.textContent.includes("原始商品删除确认"), null, { timeout: 7000 });
await page.locator("#xmxConfirmCancel").click();
await page.waitForTimeout(500);
assert(await page.locator("#totalCount").textContent() === "1537", "取消二次确认后原始商品未被删除");
await closeDialog(page, "detailDialog");

console.log("3. 站内新增商品 + 图片上传");
await page.locator("#addProductBtn").click();
await page.locator("#productFormDialog[open]").waitFor();
await page.fill("#pfName", "E2E测试·云端徽章");
await page.selectOption("#pfMainCategory", "badge");
await page.fill("#pfVariety", "吧唧");
await page.fill("#pfVersion", "初版");
await page.fill("#pfReleaseDate", "2026-01-02");
await page.fill("#pfMarketPrice", "88.50");
await page.fill("#pfProductCode", "E2E-001");
await page.fill("#pfNotes", "站内新增测试备注");
await page.setInputFiles("#pfImageFile", "assets/works/gyly/xmx/thumbs/B01-001.jpg");
await page.waitForTimeout(300);
await page.locator("#pfSave").click();
await page.locator("#productFormDialog").waitFor({ state: "hidden", timeout: 15000 });
await page.waitForTimeout(900);
assert(await page.locator("#totalCount").textContent() === "1538", "新增后商品数 1538");
await search(page, "E2E测试");
assert(await page.locator("#productGrid .product-card").count() === 1, "搜索到新增商品");
await page.waitForFunction(() => [...document.querySelectorAll("#productGrid .product-price")].some((el) => el.textContent.includes("88.50")), null, { timeout: 10000 });
assert((await page.locator("#productGrid .product-price").first().textContent()).includes("88.50"), "卡片显示市场价");
await page.screenshot({ path: path.join(artifacts, "v5-new-product.png") });

console.log("4. 收藏数量、购买价、市场价分离");
await openFirstDetail(page);
assert((await page.locator("#detailPriceCards").textContent()).includes("88.50"), "详情显示市场价 88.50");
await page.fill("#ownQty", "2");
await page.fill("#ownPrice", "65");
await page.fill("#ownDate", "2026-02-03");
await page.fill("#ownNote", "E2E 购入备注");
await page.locator("#saveOwn").click();
await page.waitForTimeout(1200);
assert((await page.locator("#detailPriceCards").textContent()).includes("65.00"), "实际购买价保存为 65");
assert((await page.locator("#detailPriceCards").textContent()).includes("88.50"), "市场价未被购买价覆盖");
assert((await page.locator(".owned-status").textContent()).includes("×2"), "拥有数量 2");
await closeDialog(page, "detailDialog");

await page.locator(".nav-link[data-page='owned']").click();
await page.waitForTimeout(700);
assert((await page.locator("#ownedSummary").textContent()).includes("2"), "收藏概览显示拥有 2 件");
assert(await page.locator("#ownedGrid .qty-badge").first().textContent() === "×2", "收藏卡片显示数量角标");
await page.screenshot({ path: path.join(artifacts, "v5-owned.png") });

console.log("5. 编辑商品");
await page.locator(".nav-link[data-page='catalog']").click();
await page.waitForTimeout(400);
await search(page, "E2E测试");
await openFirstDetail(page);
await page.locator("#detailEdit").click();
await page.locator("#productFormDialog[open]").waitFor();
await page.fill("#pfName", "E2E测试·改名后徽章");
await page.fill("#pfMarketPrice", "99");
await page.locator("#pfSave").click();
await page.locator("#productFormDialog").waitFor({ state: "hidden", timeout: 15000 });
await page.waitForTimeout(900);
await search(page, "改名后");
assert(await page.locator("#productGrid .product-card").count() === 1, "编辑后名称更新");
await page.waitForFunction(() => [...document.querySelectorAll("#productGrid .product-price")].some((el) => el.textContent.includes("99")), null, { timeout: 10000 });
assert((await page.locator("#productGrid .product-price").first().textContent()).includes("99"), "市场价更新为 99");
await openFirstDetail(page);
assert((await page.locator("#detailPriceCards").textContent()).includes("65.00"), "编辑商品未覆盖购买价");
await closeDialog(page, "detailDialog");

console.log("6. 联动分类新建 / 归类 / 重命名 / 删除");
await page.goto(`http://127.0.0.1:8765/?demo=1&r=${Date.now()}#/w/gyly/c/xmx/catalog`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.locator(".nav-link[data-page='home']").click();
await page.waitForTimeout(500);
await page.locator("[data-board-enter='collab']").click();
await page.waitForTimeout(700);
assert((await page.locator("#boardBar").textContent()).includes("全部"), "联动板块导航出现");
await page.locator("[data-board-new]").click();
await page.locator("#xmxTextDialog[open]").waitFor();
await page.fill("#xmxTextInput", "E2E联动分类");
await page.locator("#xmxTextOk").click();
await page.waitForTimeout(800);
assert((await page.locator("#boardBar").textContent()).includes("E2E联动分类"), "新建分类出现在导航");
await page.locator("[data-board-tab='uncat']").click();
await page.waitForTimeout(500);
const assign = page.locator("#productGrid [data-assign]").first();
await assign.selectOption({ label: "E2E联动分类" });
await page.waitForTimeout(900);
assert((await page.locator("#boardBar").textContent()).includes("E2E联动分类1"), "商品归类计数为 1");
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.locator(".nav-link[data-page='home']").click();
await page.waitForTimeout(500);
await page.locator("[data-board-enter='collab']").click();
await page.waitForTimeout(600);
assert((await page.locator("#boardBar").textContent()).includes("E2E联动分类"), "刷新后分类保留");
await page.locator(".board-tab").filter({ hasText: "E2E联动分类" }).click();
await page.waitForTimeout(300);
await page.locator("[data-board-rename]").click();
await page.locator("#xmxTextDialog[open]").waitFor();
await page.fill("#xmxTextInput", "E2E联动改名");
await page.locator("#xmxTextOk").click();
await page.waitForTimeout(900);
assert((await page.locator("#boardBar").textContent()).includes("E2E联动改名"), "分类重命名成功");
await page.locator("[data-board-delete]").click();
await page.locator("#xmxConfirmDialog[open]").waitFor();
await page.locator("#xmxConfirmOk").click();
await page.waitForFunction(() => document.querySelector("#xmxConfirmTitle")?.textContent.includes("再次确认删除"), null, { timeout: 7000 });
await page.locator("#xmxConfirmOk").click();
await page.waitForTimeout(1100);
assert(!(await page.locator("#boardBar").textContent()).includes("E2E联动改名"), "删除分类成功");
assert((await page.locator("#boardBar").textContent()).includes("未分类347"), "删除分类后商品转入未分类");

console.log("7. 跨标签同步与冲突处理");
const page2 = await context.newPage();
await page2.goto("http://127.0.0.1:8765/?demo=1#/w/gyly/c/xmx/catalog", { waitUntil: "networkidle" });
await page2.waitForTimeout(1200);
await page.locator(".nav-link[data-page='catalog']").click();
await page.waitForTimeout(400);
await page.selectOption("#categoryFilter", "");
await page.waitForTimeout(300);
await search(page, "E2E测试");
await openFirstDetail(page);
await page.locator("#detailEdit").click();
await page.locator("#productFormDialog[open]").waitFor();
await page.fill("#pfName", "E2E测试·页面1草稿");

await search(page2, "E2E测试");
await openFirstDetail(page2);
await page2.locator("#detailEdit").click();
await page2.locator("#productFormDialog[open]").waitFor();
await page2.fill("#pfName", "E2E测试·页面2已保存");
await page2.locator("#pfSave").click();
await page2.locator("#productFormDialog").waitFor({ state: "hidden", timeout: 15000 });
await page2.waitForTimeout(1000);

await page.locator("#pfSave").click();
await page.locator("#conflictDialog[open]").waitFor({ timeout: 7000 });
assert(true, "检测到并发修改并弹出冲突选择");
await page.screenshot({ path: path.join(artifacts, "v5-conflict.png") });
await page.locator("#conflictKeepMine").click();
await page.waitForTimeout(1500);
await page.locator("#productFormDialog").waitFor({ state: "hidden", timeout: 7000 });
await search(page, "页面1草稿");
assert(await page.locator("#productGrid .product-card").count() === 1, "选择保留我的版本后覆盖成功");
await page2.bringToFront();
await page2.waitForTimeout(1800);
await search(page2, "页面1草稿");
assert(await page2.locator("#productGrid .product-card").count() === 1, "另一标签同步到覆盖后的数据");

console.log("8. 完整备份（含图片）");
await page.waitForTimeout(700);
await page.locator("#accountBtn").click();
await page.locator("#accountDialog[open]").waitFor();
await page.locator("[data-account-action='backup']").click();
await page.locator("#backupDialog[open]").waitFor();
await page.locator("#backupBase").uncheck();
const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
await page.locator("#backupStart").click();
const download = await downloadPromise;
const backupPath = path.join(artifacts, "backup.zip");
await download.saveAs(backupPath);
await page.waitForTimeout(1000);
assert(fs.existsSync(backupPath), "备份 ZIP 已下载");
const zip = await JSZip.loadAsync(fs.readFileSync(backupPath));
assert(Boolean(zip.file("manifest.json")), "备份包含 manifest.json");
assert(Boolean(zip.file("data.json")), "备份包含 data.json");
const backupData = JSON.parse(await zip.file("data.json").async("string"));
assert(backupData.counts.products === 1538, "备份包含 1538 件商品");
assert(backupData.counts.collections >= 1, "备份包含收藏");
assert(backupData.counts.productImages >= 1, "备份包含图片元数据");
assert(Object.keys(zip.files).some((f) => f.startsWith("images/uploads/")), "备份包含上传图片文件");
const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
assert(manifest.images.length >= 1, "manifest 图片清单存在");
await closeDialog(page, "backupDialog");
await closeDialog(page, "accountDialog");

console.log("9. 删除商品 + 从备份恢复");
await search(page, "页面1草稿");
await openFirstDetail(page);
await page.locator("#detailDelete").click();
await page.locator("#xmxConfirmDialog[open]").waitFor();
await page.locator("#xmxConfirmOk").click();
await page.waitForTimeout(1200);
assert(await page.locator("#totalCount").textContent() === "1537", "删除站内商品后回到 1537");

await page.locator("#accountBtn").click();
await page.locator("#accountDialog[open]").waitFor();
await page.setInputFiles("#globalRestoreFile", backupPath);
await page.locator("#restoreDialog[open]").waitFor();
await page.waitForSelector("#restoreBody .restore-mode", { timeout: 120000 });
const restoreBodyText = await page.locator("#restoreBody").textContent();
assert(!restoreBodyText.includes("备份校验失败"), "备份校验通过");
await page.locator("#restoreStart").click();
await page.locator("#xmxConfirmDialog[open]").waitFor();
await page.locator("#xmxConfirmOk").click();
await page.waitForFunction(() => {
  const el = document.querySelector("#xmxConfirmTitle");
  return el && el.textContent.includes("再次确认恢复");
}, null, { timeout: 7000 });
await page.fill("#xmxConfirmInput", "恢复");
await page.locator("#xmxConfirmOk").click();
await page.waitForSelector("#restoreBody .backup-success", { timeout: 120000 });
assert(true, "恢复完成并显示成功报告");
await page.screenshot({ path: path.join(artifacts, "v5-restore.png") });
await page.locator("#restoreClose").click();
await closeDialog(page, "accountDialog");
await page.waitForTimeout(1200);
assert(await page.locator("#totalCount").textContent() === "1538", "恢复后商品数 1538");
await search(page, "页面1草稿");
assert(await page.locator("#productGrid .product-card").count() === 1, "恢复后商品按原 ID 找回");
await openFirstDetail(page);
assert(await page.locator("#detailImage img").count() >= 1, "恢复后高清图正常显示");
assert((await page.locator("#detailPriceCards").textContent()).includes("65.00"), "恢复后购买价保留");
await closeDialog(page, "detailDialog");

console.log("10. 回归：主分类与 1537 原始数据");
await page.locator("#searchInput").fill("");
await page.waitForTimeout(500);
assert(await page.locator("#totalCount").textContent() === "1538", "图鉴总数包含新增");
assert(await page.locator("#categoryFilter optgroup[label='主分类'] option").count() === 20, "20 个主分类仍在");
await page.locator("#categoryFilter").selectOption("main:badge");
await page.waitForTimeout(500);
assert(Number((await page.locator("#resultCount").textContent()).replace(/\D/g, "")) >= 171, "吧唧主分类正常");

console.log("11. 书籍页面与导航");
await page.locator('[data-page="books"]').click();
await page.waitForTimeout(500);
assert(await page.locator("#page-books").evaluate((el) => el.classList.contains("active")), "书籍收藏页面可打开");
assert((await page.locator("#bookResultCount").textContent()).includes("0 本书"), "本地预览书籍为空");
await page.locator('[data-page="catalog"]').click();
await page.waitForTimeout(300);

console.log("错误日志：", errors.length ? errors.slice(0, 10) : "无");
await page.screenshot({ path: path.join(artifacts, "v5-final.png") });
try {
  await browser.close();
} catch (e) {
  console.warn("浏览器关闭警告：", e.message);
}
if (errors.length) process.exitCode = 2;
