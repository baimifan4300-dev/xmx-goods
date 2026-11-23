import { ERROR_CODES } from "./constants.js";

export const $ = (id) => document.getElementById(id);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function safe(value = "") {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function escapeAttr(value = "") {
  return safe(value);
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function debounce(fn, wait = 180) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function uid(prefix = "") {
  const random = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/-/g, "");
  return `${prefix}${random}`;
}

export function newProductId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `U-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export function newBoardCategoryId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function parseNumberOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatMoney(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `¥ ${n.toFixed(2)}`;
}

export function formatShortMoney(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `¥${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleString("zh-CN", { hour12: false });
  } catch {
    return d.toISOString();
  }
}

export function normalizeDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function isCloudConfigured(config) {
  const url = String(config?.supabaseUrl || "").trim();
  const key = String(config?.supabaseAnonKey || "").trim();
  return /^https:\/\/[^/\s]+\.supabase\.co\/?$/.test(url) && key.length > 40 && !key.includes("YOUR-");
}

export function validateSupabaseConfig(config) {
  const url = String(config?.supabaseUrl || "").trim();
  const key = String(config?.supabaseAnonKey || "").trim();
  if (!url || !key) return "尚未填写 Supabase URL 或 anon key。";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return "Supabase URL 必须使用 https://。";
  } catch {
    return "Supabase URL 格式不正确。";
  }
  if (!/^https:\/\/[^/\s]+\.supabase\.co\/?$/.test(url)) {
    return "Supabase URL 应该是 https://<project-ref>.supabase.co。";
  }
  if (key.length < 40) return "Supabase anon key 看起来不完整。";
  if (key.includes("service_role") || key.startsWith("sb_secret_")) return "禁止在前端使用 service_role key，请改用 anon public key。";
  // Supabase 的 JWT anon key 里 role 必须是 anon；拒绝 service_role JWT。
  try {
    const payloadPart = key.split(".")[1];
    if (payloadPart) {
      const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payloadPart.length / 4) * 4, "=");
      const json = typeof atob === "function" ? atob(normalized) : Buffer.from(normalized, "base64").toString("utf8");
      const payload = JSON.parse(json);
      if (payload.role === "service_role") return "禁止在前端使用 service_role key，请改用 anon public key。";
    }
  } catch {
    // 非 JWT 的新式 publishable key 允许通过；服务端会做最终校验。
  }
  return null;
}

export function isHttpUrl(value) {
  try {
    const u = new URL(value, location.href);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function toast(message, type = "info", duration = 2600) {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.className = "toast";
  }, duration);
}

export function toastError(error, fallback = "操作失败") {
  const msg = error?.userMessage || error?.message || fallback;
  toast(msg, "error", 4200);
}

let dialogCounter = 0;

function ensureConfirmDialog() {
  let dlg = $("xmxConfirmDialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "xmxConfirmDialog";
  dlg.className = "xmx-modal confirm-modal";
  dlg.innerHTML = `
    <form method="dialog" class="xmx-modal-inner">
      <div class="xmx-modal-head">
        <div><span class="eyebrow" id="xmxConfirmEyebrow">PLEASE CONFIRM</span><h2 id="xmxConfirmTitle">请确认</h2></div>
        <button class="close-btn" value="cancel" aria-label="关闭">×</button>
      </div>
      <div id="xmxConfirmBody" class="xmx-modal-body"></div>
      <div id="xmxConfirmRequire" class="require-text hidden">
        <label>请输入 <b id="xmxConfirmRequireWord"></b> 以继续
          <input id="xmxConfirmInput" autocomplete="off">
        </label>
      </div>
      <div class="xmx-modal-actions">
        <button type="button" class="outline-btn" id="xmxConfirmCancel">取消</button>
        <button type="button" class="primary-btn" id="xmxConfirmOk">确认</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  return dlg;
}

/**
 * 通用确认框。二次确认只需调用两次。
 * @returns {Promise<boolean>}
 */
export function confirmAction({
  title = "请确认",
  message = "",
  details = "",
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  requireText = null,
  eyebrow = "PLEASE CONFIRM"
} = {}) {
  const dlg = ensureConfirmDialog();
  const id = ++dialogCounter;
  $("xmxConfirmEyebrow").textContent = eyebrow;
  $("xmxConfirmTitle").textContent = title;
  $("xmxConfirmBody").innerHTML = `${message ? `<p class="confirm-message">${safe(message)}</p>` : ""}${details || ""}`;
  const requireWrap = $("xmxConfirmRequire");
  const input = $("xmxConfirmInput");
  if (requireText) {
    requireWrap.classList.remove("hidden");
    $("xmxConfirmRequireWord").textContent = requireText;
    input.value = "";
  } else {
    requireWrap.classList.add("hidden");
  }
  const ok = $("xmxConfirmOk");
  const cancel = $("xmxConfirmCancel");
  ok.textContent = confirmLabel;
  cancel.textContent = cancelLabel;
  ok.className = danger ? "primary-btn danger-btn" : "primary-btn";
  ok.disabled = Boolean(requireText);
  input.oninput = () => { ok.disabled = requireText ? input.value.trim() !== requireText : false; };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener("close", onClose);
      const done = () => {
        dlg.removeEventListener("close", done);
        resolve(value);
      };
      if (dlg.open) {
        dlg.addEventListener("close", done, { once: true });
        dlg.close();
      } else {
        done();
      }
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener("close", onClose);
      resolve(false);
    };
    dlg.addEventListener("close", onClose, { once: true });
    ok.onclick = () => {
      if (requireText && input.value.trim() !== requireText) {
        input.focus();
        return;
      }
      finish(true);
    };
    cancel.onclick = () => finish(false);
    dlg.showModal();
    setTimeout(() => {
      if (requireText) input.focus();
      else ok.focus();
    }, 30);
    dlg.dataset.callId = String(id);
  });
}

export function noticeDialog({ title = "提示", message = "", details = "", okLabel = "知道了" } = {}) {
  return confirmAction({ title, message, details, confirmLabel: okLabel, cancelLabel: "关闭", eyebrow: "NOTICE" });
}

let textDialog = null;
export function askText({ title, label, value = "", placeholder = "", maxLength = 20, confirmLabel = "保存" } = {}) {
  if (!textDialog) {
    textDialog = document.createElement("dialog");
    textDialog.id = "xmxTextDialog";
    textDialog.className = "xmx-modal";
    textDialog.innerHTML = `
      <form method="dialog" class="xmx-modal-inner">
        <div class="xmx-modal-head"><div><span class="eyebrow">EDIT</span><h2 id="xmxTextTitle"></h2></div>
          <button class="close-btn" value="cancel" aria-label="关闭">×</button></div>
        <div class="xmx-modal-body">
          <label class="stack-label"><span id="xmxTextLabel"></span>
            <input id="xmxTextInput" maxlength="20" autocomplete="off"></label>
          <p class="form-hint" id="xmxTextHint"></p>
        </div>
        <div class="xmx-modal-actions"><button type="button" class="outline-btn" id="xmxTextCancel">取消</button>
          <button type="button" class="primary-btn" id="xmxTextOk"></button></div>
      </form>`;
    document.body.appendChild(textDialog);
  }
  $("xmxTextTitle").textContent = title;
  $("xmxTextLabel").textContent = label || title;
  $("xmxTextInput").maxLength = maxLength;
  $("xmxTextInput").value = value;
  $("xmxTextInput").placeholder = placeholder;
  $("xmxTextHint").textContent = `最多 ${maxLength} 个字符；“全部”“未分类”为系统保留名称。`;
  $("xmxTextOk").textContent = confirmLabel;
  return new Promise((resolve) => {
    const dlg = textDialog;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener("close", onClose);
      if (dlg.open) dlg.close();
      resolve(val);
    };
    const onClose = () => finish(null);
    dlg.addEventListener("close", onClose, { once: true });
    $("xmxTextCancel").onclick = () => finish(null);
    $("xmxTextOk").onclick = () => finish($("xmxTextInput").value.trim());
    dlg.showModal();
    setTimeout(() => { $("xmxTextInput").focus(); $("xmxTextInput").select(); }, 30);
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function sha256Blob(blob) {
  if (!globalThis.crypto?.subtle) return null;
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeError(error) {
  if (!error) return new Error("未知错误");
  if (error.code === ERROR_CODES.CONFLICT || error.code === ERROR_CODES.DELETED ||
      error.code === ERROR_CODES.AUTH || error.code === ERROR_CODES.CONFIG) {
    return error;
  }
  const out = new Error(error.message || "操作失败");
  out.code = error.code || "UNKNOWN";
  const msg = String(error.message || "");
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    out.userMessage = "网络连接失败，请检查网络后重试。";
  } else if (/JWT expired|invalid claim|not authenticated/i.test(msg)) {
    out.userMessage = "登录状态已过期，请重新登录。";
    out.code = ERROR_CODES.AUTH;
  } else if (/duplicate key|already exists|23505/i.test(msg)) {
    out.userMessage = "已存在同 ID 或同名称的记录，请检查后重试。";
    out.code = ERROR_CODES.DUPLICATE;
  } else if (/row-level security|permission denied|42501/i.test(msg)) {
    out.userMessage = "没有权限执行该操作，请确认已登录且数据属于当前账号。";
  } else if (/Payload too large|exceeded the maximum allowed size/i.test(msg)) {
    out.userMessage = "文件太大，请压缩后重试。";
  } else {
    out.userMessage = msg || "操作失败，请稍后重试。";
  }
  return out;
}

export function versionOf(row) {
  return Number.isInteger(row?._revision) ? row._revision : Number(row?.revision || 1);
}

export function compareVersions(a, b) {
  return Number(a || 0) - Number(b || 0);
}

export function uniqueBy(list, keyFn) {
  const seen = new Set();
  return list.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function setButtonBusy(button, busy, busyText = "处理中…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
    button.classList.add("is-busy");
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.classList.remove("is-busy");
  }
}
