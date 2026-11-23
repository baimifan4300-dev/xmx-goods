import JSZip from "jszip";
import {
  APP_VERSION, BACKUP_FORMAT, BACKUP_FORMAT_VERSION, SCHEMA_VERSION
} from "./constants.js";
import { formatBytes, sha256Blob, uid } from "./utils.js";

function stripRuntime(product) {
  const p = { ...product };
  for (const key of ["_revision", "_images", "_imageUrl", "_thumbUrl", "_highResUrl", "_coverUrl", "_signed", "_local", "_uploading"]) {
    delete p[key];
  }
  p.revision = product._revision ?? product.revision ?? 1;
  return p;
}

function extFromMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/avif") return "avif";
  return "jpg";
}

function sanitizePart(value) {
  return String(value || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function uniqueList(items) {
  return [...new Set(items.filter(Boolean))];
}

export function buildBackupData(snapshot) {
  const products = (snapshot.products || []).map(stripRuntime);
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    owner: {
      id: snapshot.user?.id || null,
      email: snapshot.user?.email || null
    },
    counts: {
      products: products.length,
      userProducts: products.filter((p) => p.isUserCreated).length,
      collections: snapshot.collections?.length || 0,
      wishlist: snapshot.wishlist?.length || 0,
      boardCategories: snapshot.boardCategories?.length || 0,
      boardAssignments: snapshot.boardAssignments?.length || 0,
      productImages: snapshot.productImages?.length || 0,
      mainCategories: snapshot.mainCategories?.length || 0
    },
    data: {
      products,
      collections: snapshot.collections || [],
      wishlist: snapshot.wishlist || [],
      boardCategories: snapshot.boardCategories || [],
      boardAssignments: snapshot.boardAssignments || [],
      productImages: (snapshot.productImages || []).map((img) => ({
        ...img, url: null, thumbUrl: null
      })),
      settings: snapshot.settings || {},
      mainCategories: snapshot.mainCategories || [],
      works: snapshot.works || [],
      characters: snapshot.characters || []
    }
  };
}

/**
 * 创建完整 ZIP 备份：data.json + manifest.json + 用户上传图 + 原始合集图（可选）
 */
export async function createBackup(backend, snapshot, options = {}, onProgress = () => {}) {
  const includeBaseImages = options.includeBaseImages !== false;
  const includeThumbs = options.includeThumbs !== false;
  const zip = new JSZip();
  const data = buildBackupData(snapshot);
  const manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: data.exportedAt,
    owner: data.owner,
    counts: data.counts,
    options: { includeBaseImages, includeThumbs },
    dataFile: "data.json",
    images: [],
    warnings: []
  };
  const warnings = [];

  onProgress({ phase: "prepare", message: "正在整理数据…", current: 0, total: 1 });
  zip.file("data.json", JSON.stringify(data, null, 2), { compression: "DEFLATE", compressionOptions: { level: 6 } });

  const uploaded = snapshot.productImages || [];
  const imageEntries = [];
  let done = 0;
  const uploadedTotal = uploaded.length;
  for (const image of uploaded) {
    if (!image.storagePath) continue;
    try {
      onProgress({
        phase: "images", message: `正在打包高清图 ${done + 1}/${uploadedTotal}`,
        current: done, total: uploadedTotal + (includeBaseImages ? 1 : 0)
      });
      const blob = await backend.downloadStorage(image.storagePath);
      const ext = extFromMime(image.mimeType);
      const zipPath = `images/uploads/${sanitizePart(image.productId)}/${sanitizePart(image.id || image.kind)}.${ext}`;
      zip.file(zipPath, blob, { compression: "STORE" });
      const entry = {
        category: "upload",
        zipPath,
        sourcePath: image.storagePath,
        productId: image.productId,
        kind: image.kind,
        mimeType: image.mimeType || blob.type || "image/jpeg",
        size: blob.size,
        sha256: await sha256Blob(blob),
        width: image.width,
        height: image.height,
        thumbZipPath: null,
        thumbMimeType: null,
        thumbSize: null,
        thumbSha256: null
      };
      if (image.thumbPath && includeThumbs) {
        try {
          const thumbBlob = await backend.downloadStorage(image.thumbPath);
          const thumbZipPath = `images/uploads/${sanitizePart(image.productId)}/${sanitizePart(image.id || image.kind)}-thumb.webp`;
          zip.file(thumbZipPath, thumbBlob, { compression: "STORE" });
          entry.thumbZipPath = thumbZipPath;
          entry.thumbMimeType = thumbBlob.type || "image/webp";
          entry.thumbSize = thumbBlob.size;
          entry.thumbSha256 = await sha256Blob(thumbBlob);
        } catch (e) {
          warnings.push(`缩略图缺失：${image.thumbPath}`);
        }
      }
      manifest.images.push(entry);
      imageEntries.push(entry);
    } catch (e) {
      warnings.push(`高清图打包失败：${image.storagePath}（${e.message}）`);
    }
    done += 1;
  }

  if (includeBaseImages) {
    const basePaths = [];
    for (const p of snapshot.products || []) {
      if (p.image?.src) basePaths.push(p.image.src);
      if (includeThumbs && p.image?.thumb) basePaths.push(p.image.thumb);
    }
    const paths = uniqueList(basePaths);
    let baseDone = 0;
    for (const sourcePath of paths) {
      baseDone += 1;
      onProgress({
        phase: "images", message: `正在打包原始图 ${baseDone}/${paths.length}`,
        current: uploadedTotal + baseDone - 1, total: uploadedTotal + paths.length
      });
      try {
        const res = await fetch(sourcePath, { cache: "force-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const zipPath = `images/base/${sourcePath.replace(/^assets\//, "")}`;
        zip.file(zipPath, blob, { compression: "STORE" });
        manifest.images.push({
          category: "base",
          zipPath,
          sourcePath,
          productId: null,
          kind: sourcePath.includes("/thumbs/") ? "thumb" : "composite",
          mimeType: blob.type || "image/jpeg",
          size: blob.size,
          sha256: await sha256Blob(blob)
        });
      } catch (e) {
        warnings.push(`原始图打包失败：${sourcePath}（${e.message}）`);
      }
    }
  }

  manifest.warnings = warnings;
  zip.file("manifest.json", JSON.stringify(manifest, null, 2), { compression: "DEFLATE", compressionOptions: { level: 6 } });
  zip.file("README.txt", [
    "星愿收藏室 · 完整备份包",
    `导出时间：${data.exportedAt}`,
    `数据结构版本：${SCHEMA_VERSION}`,
    `商品：${data.counts.products}（用户新增 ${data.counts.userProducts}）`,
    `收藏：${data.counts.collections}；愿望：${data.counts.wishlist}`,
    `联动/满赠分类：${data.counts.boardCategories}`,
    "",
    "目录说明：",
    "  data.json      全部数据库数据（商品、收藏、愿望、分类、关联、图片元数据）",
    "  manifest.json  备份清单、图片清单与 SHA-256 校验值",
    "  images/uploads 用户上传的高清图与缩略图",
    "  images/base    原始合集图与裁切缩略图（用于归档校验）",
    "",
    "恢复请回到网站 → 账户 → 恢复备份，不要手工修改本压缩包。",
    "本备份包含个人收藏数据，请妥善保管。"
  ].join("\n"), { compression: "DEFLATE" });

  const total = uploadedTotal + (includeBaseImages ? uniqueList((snapshot.products || []).flatMap((p) => [p.image?.src, includeThumbs ? p.image?.thumb : null])).length : 0);
  const blob = await zip.generateAsync(
    { type: "blob", compression: "STORE", streamFiles: true },
    (meta) => onProgress({
      phase: "zip", message: `正在生成备份包 ${Math.round(meta.percent)}%`,
      current: Math.round(meta.percent), total: 100, percent: meta.percent
    })
  );
  onProgress({ phase: "done", message: "备份已生成", current: total, total });
  return { blob, manifest, data, warnings };
}

export function backupFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `xmx-goods-backup-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.zip`;
}

/**
 * 读取并校验备份包。会校验格式、版本、图片文件是否存在、SHA-256 是否一致。
 */
export async function inspectBackup(file, onProgress = () => {}) {
  onProgress({ phase: "read", message: "正在读取备份包…", current: 0, total: 1 });
  const zip = await JSZip.loadAsync(file);
  const manifestFile = zip.file("manifest.json");
  const dataFile = zip.file("data.json");
  if (!manifestFile) throw new Error("备份包缺少 manifest.json，可能不是完整的备份包。");
  if (!dataFile) throw new Error("备份包缺少 data.json。");
  const manifest = JSON.parse(await manifestFile.async("string"));
  const data = JSON.parse(await dataFile.async("string"));
  if (manifest.format !== BACKUP_FORMAT || data.format !== BACKUP_FORMAT) {
    throw new Error("备份格式不匹配，这不是星愿收藏室的完整备份包。");
  }
  if (Number(manifest.formatVersion) > BACKUP_FORMAT_VERSION) {
    throw new Error(`备份版本（v${manifest.formatVersion}）高于当前网站支持的版本（v${BACKUP_FORMAT_VERSION}）。请先升级网站。`);
  }
  if (!data.data || !Array.isArray(data.data.products)) {
    throw new Error("备份数据不完整：缺少商品列表。");
  }

  const missingFiles = [];
  const hashMismatches = [];
  const images = Array.isArray(manifest.images) ? manifest.images : [];
  const total = images.length;
  let done = 0;
  for (const entry of images) {
    done += 1;
    onProgress({ phase: "verify", message: `正在校验图片 ${done}/${total}`, current: done, total });
    const main = zip.file(entry.zipPath);
    if (!main) { missingFiles.push(entry.zipPath); continue; }
    if (entry.sha256) {
      const blob = await main.async("blob");
      const hash = await sha256Blob(blob);
      if (hash && hash !== entry.sha256) hashMismatches.push(entry.zipPath);
    }
    if (entry.thumbZipPath) {
      const thumb = zip.file(entry.thumbZipPath);
      if (!thumb) missingFiles.push(entry.thumbZipPath);
      else if (entry.thumbSha256) {
        const blob = await thumb.async("blob");
        const hash = await sha256Blob(blob);
        if (hash && hash !== entry.thumbSha256) hashMismatches.push(entry.thumbZipPath);
      }
    }
  }

  return {
    zip,
    manifest,
    data,
    images,
    missingFiles,
    hashMismatches,
    summary: {
      exportedAt: data.exportedAt,
      products: data.data.products.length,
      userProducts: data.data.products.filter((p) => p.isUserCreated).length,
      collections: data.data.collections?.length || 0,
      wishlist: data.data.wishlist?.length || 0,
      categories: data.data.boardCategories?.length || 0,
      assignments: data.data.boardAssignments?.length || 0,
      uploads: images.filter((i) => i.category === "upload").length,
      baseImages: images.filter((i) => i.category === "base").length,
      totalImageBytes: images.reduce((sum, i) => sum + (i.size || 0) + (i.thumbSize || 0), 0)
    }
  };
}

function extFromName(name = "") {
  const m = String(name).match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "bin";
}

function buildCategoryMap(existing, backupCategories, overwrite) {
  const byId = new Map((existing || []).map((c) => [c.id, c]));
  const byName = new Map((existing || []).map((c) => [`${c.boardKey}|${c.name}`, c]));
  const oldToNew = new Map();
  const toCreate = [];
  for (const c of backupCategories || []) {
    const sameName = byName.get(`${c.boardKey}|${c.name}`);
    if (sameName) {
      oldToNew.set(c.id, sameName.id);
      continue;
    }
    const sameId = byId.get(c.id);
    if (sameId) {
      oldToNew.set(c.id, sameId.id);
      if (overwrite && sameId.name !== c.name) {
        // 同名冲突在严格唯一约束下无法直接改名，保留云端名称，避免恢复中断。
      }
      continue;
    }
    oldToNew.set(c.id, c.id);
    toCreate.push(c);
  }
  return { oldToNew, toCreate };
}

/**
 * 从备份恢复。默认只补充缺失，不覆盖现有数据。
 */
export async function restoreBackup({ backend, inspection, overwrite = false, onProgress = () => {} }) {
  const { zip, data, images, missingFiles } = inspection;
  const payload = data.data;
  const report = {
    products: 0,
    collections: 0,
    wishlist: 0,
    categories: 0,
    assignments: 0,
    images: 0,
    skippedImages: 0,
    failed: 0,
    warnings: []
  };

  onProgress({ phase: "products", message: "正在恢复商品…", current: 0, total: 4 });
  report.products = await backend.upsertRestoreProducts(payload.products || [], overwrite);

  onProgress({ phase: "collections", message: "正在恢复收藏与愿望清单…", current: 1, total: 4 });
  report.collections = await backend.upsertRestoreCollections(payload.collections || [], overwrite);
  report.wishlist = await backend.upsertRestoreWishlist(payload.wishlist || [], overwrite);

  onProgress({ phase: "categories", message: "正在恢复分类…", current: 2, total: 4 });
  const before = await backend.loadSnapshot();
  const categoryMap = buildCategoryMap(before.boardCategories, payload.boardCategories || [], overwrite);
  report.categories = await backend.upsertRestoreCategories(categoryMap.toCreate);
  const mappedAssignments = (payload.boardAssignments || [])
    .map((a) => ({
      ...a,
      categoryId: categoryMap.oldToNew.get(a.categoryId) || a.categoryId
    }))
    .filter((a) => a.categoryId);
  report.assignments = await backend.upsertRestoreAssignments(mappedAssignments);

  onProgress({ phase: "images", message: "正在恢复图片…", current: 3, total: 4 });
  const afterProducts = new Set((await backend.loadSnapshot()).products.map((p) => p.id));
  const uploadEntries = images.filter((i) => i.category === "upload" && i.productId);
  const currentImages = await backend.loadSnapshot();
  const existingMap = new Map((currentImages.productImages || []).map((i) => [`${i.productId}|${i.kind}`, i]));
  let imageIndex = 0;
  for (const entry of uploadEntries) {
    imageIndex += 1;
    onProgress({
      phase: "images", message: `正在恢复图片 ${imageIndex}/${uploadEntries.length}`,
      current: imageIndex, total: uploadEntries.length
    });
    if (!afterProducts.has(entry.productId)) {
      report.warnings.push(`商品 ${entry.productId} 不存在，跳过图片`);
      continue;
    }
    if (missingFiles.includes(entry.zipPath)) {
      report.warnings.push(`图片文件缺失：${entry.zipPath}`);
      report.failed += 1;
      continue;
    }
    const existing = existingMap.get(`${entry.productId}|${entry.kind}`);
    if (existing && !overwrite) {
      report.skippedImages += 1;
      continue;
    }
    try {
      const mainBlob = await zip.file(entry.zipPath).async("blob");
      const ext = extFromName(entry.zipPath);
      const ownerId = backend.user?.id || "owner";
      const basePath = `${ownerId}/${sanitizePart(entry.productId)}/${entry.kind}-${Date.now()}-${uid().slice(0, 8)}.${ext}`;
      await backend.uploadStorage(basePath, mainBlob, entry.mimeType || "image/jpeg");
      let thumbPath = null;
      if (entry.thumbZipPath && zip.file(entry.thumbZipPath)) {
        const thumbBlob = await zip.file(entry.thumbZipPath).async("blob");
        thumbPath = `${ownerId}/${sanitizePart(entry.productId)}/${entry.kind}-${Date.now()}-${uid().slice(0, 8)}-thumb.webp`;
        await backend.uploadStorage(thumbPath, thumbBlob, entry.thumbMimeType || "image/webp");
      }
      const saved = await backend.saveProductImageRecord({
        productId: entry.productId,
        kind: entry.kind,
        storagePath: basePath,
        thumbPath,
        fileName: entry.zipPath.split("/").pop(),
        mimeType: entry.mimeType || "image/jpeg",
        sizeBytes: entry.size || mainBlob.size,
        width: entry.width ?? null,
        height: entry.height ?? null
      }, existing || null);
      if (existing?.storagePath) {
        await backend.removeStorage([existing.storagePath, existing.thumbPath]);
      }
      existingMap.set(`${entry.productId}|${entry.kind}`, saved);
      report.images += 1;
    } catch (e) {
      report.failed += 1;
      report.warnings.push(`图片恢复失败：${entry.zipPath}（${e.message}）`);
    }
  }

  onProgress({ phase: "settings", message: "正在恢复设置…", current: 4, total: 4 });
  try {
    await backend.mergeSettings(payload.settings || {});
  } catch (e) {
    report.warnings.push(`设置恢复失败：${e.message}`);
  }

  report.warnings.push(...(inspection.manifest.warnings || []).map((w) => `备份时警告：${w}`));
  if (inspection.hashMismatches.length) {
    report.warnings.push(`有 ${inspection.hashMismatches.length} 个图片校验值不一致，请检查备份文件是否被修改。`);
  }
  onProgress({ phase: "done", message: "恢复完成", current: 4, total: 4 });
  return report;
}

export function restoreReportText(report, summary) {
  return [
    "星愿收藏室 · 恢复报告",
    `时间：${new Date().toISOString()}`,
    `备份导出时间：${summary?.exportedAt || "—"}`,
    "",
    `商品：${report.products}`,
    `收藏：${report.collections}`,
    `愿望清单：${report.wishlist}`,
    `分类：${report.categories}`,
    `分类归属：${report.assignments}`,
    `图片：${report.images}`,
    `跳过已有图片：${report.skippedImages}`,
    `失败：${report.failed}`,
    "",
    "警告：",
    ...(report.warnings.length ? report.warnings.map((w) => `- ${w}`) : ["无"])
  ].join("\n");
}

export function formatBackupSize(bytes) {
  return formatBytes(bytes);
}
