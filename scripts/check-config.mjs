import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSupabaseConfig } from "../src/utils.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "config.js");
if (!fs.existsSync(file)) {
  console.error("config.js 不存在。请复制 config.example.js 或配置 Vercel 环境变量。");
  process.exit(1);
}
const text = fs.readFileSync(file, "utf8");
const url = text.match(/supabaseUrl\s*:\s*["']([^"']*)["']/)?.[1] || "";
const key = text.match(/supabaseAnonKey\s*:\s*["']([^"']*)["']/)?.[1] || "";
const error = validateSupabaseConfig({ supabaseUrl: url, supabaseAnonKey: key });
if (error) {
  console.error(`配置检查失败：${error}`);
  console.error("本地预览可用 ?demo=1；正式部署请填写 SUPABASE_URL / SUPABASE_ANON_KEY。");
  process.exit(1);
}
console.log(`配置检查通过：${url}（未输出密钥）`);
