import { IMAGE_ACCEPT, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE } from "./constants.js";

const ACCEPTED = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/avif"]);

function imageError(message) {
  const e = new Error(message);
  e.userMessage = message;
  return e;
}

export function validateImageFile(file) {
  if (!file) throw imageError("请选择图片文件。");
  if (!ACCEPTED.has(String(file.type).toLowerCase())) {
    throw imageError("只支持 JPG、PNG、WebP、AVIF 图片。");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw imageError(`图片不能超过 ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MB，请压缩后重试。`);
  }
  return true;
}

async function loadBitmap(file) {
  if (globalThis.createImageBitmap) {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      console.warn("createImageBitmap 失败，改用 Image", e);
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function bitmapSize(bitmap) {
  return {
    width: bitmap.width || bitmap.naturalWidth,
    height: bitmap.height || bitmap.naturalHeight
  };
}

function drawToBlob(bitmap, maxEdge, quality) {
  const { width, height } = bitmapSize(bitmap);
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { alpha: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, outW, outH);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(imageError("图片处理失败，请换一张图片。")); return; }
      resolve({ blob, width: outW, height: outH });
    }, "image/webp", quality);
  });
}

export function extensionForMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/avif") return "avif";
  return "jpg";
}

/**
 * 压缩主图并生成缩略图；不会修改原文件。
 * @returns {Promise<{mainBlob:Blob, thumbBlob:Blob, width:number, height:number, mimeType:string, ext:string, thumbWidth:number, thumbHeight:number, fileName:string}>}
 */
export async function prepareImage(file) {
  validateImageFile(file);
  const bitmap = await loadBitmap(file);
  const { width, height } = bitmapSize(bitmap);
  if (!width || !height) throw imageError("无法读取图片尺寸。");
  if (Math.max(width, height) > MAX_IMAGE_EDGE) {
    throw imageError(`图片尺寸过大（${width}×${height}），最长边不能超过 ${MAX_IMAGE_EDGE}px。`);
  }

  let mainBlob = file;
  let mainWidth = width;
  let mainHeight = height;
  let mimeType = file.type === "image/jpg" ? "image/jpeg" : file.type;

  const needsResize = Math.max(width, height) > 2400 || file.size > 5 * 1024 * 1024;
  if (needsResize) {
    const resized = await drawToBlob(bitmap, 2400, 0.9);
    mainBlob = resized.blob;
    mainWidth = resized.width;
    mainHeight = resized.height;
    mimeType = "image/webp";
  }

  const thumb = await drawToBlob(bitmap, 640, 0.82);
  if (typeof bitmap.close === "function") bitmap.close();

  const ext = extensionForMime(mimeType);
  const base = String(file.name || "image").replace(/\.[^.]+$/, "").replace(/[^\w\u4e00-\u9fa5-]+/g, "-").slice(0, 50) || "image";
  return {
    mainBlob,
    thumbBlob: thumb.blob,
    width: mainWidth,
    height: mainHeight,
    mimeType,
    ext,
    thumbWidth: thumb.width,
    thumbHeight: thumb.height,
    fileName: `${base}.${ext}`
  };
}

export function localPreviewUrl(file) {
  return URL.createObjectURL(file);
}

export function imageAccept() {
  return IMAGE_ACCEPT;
}

export async function readImageDimensions(file) {
  const bitmap = await loadBitmap(file);
  const size = bitmapSize(bitmap);
  if (typeof bitmap.close === "function") bitmap.close();
  return size;
}
