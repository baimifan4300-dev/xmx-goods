export const APP_VERSION = "5.0.0";
export const APP_NAME = "星愿收藏室";
export const PAGE_SIZE = 60;
export const CLOUD_BATCH_SIZE = 200;

export const BACKUP_FORMAT = "xmx-goods-backup";
export const BACKUP_FORMAT_VERSION = 2;
export const SCHEMA_VERSION = "2026-11-supabase-v1";

export const STORAGE_BUCKET_DEFAULT = "product-images";
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 12000;
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/avif";

export const STATE_KEY = "xmx.collection.v1";
export const LEGACY_STATE_KEY = "xmx-goods-v1";
export const LEGACY_PRODUCTS_KEY = "xmx-goods-products-v1";
export const BOARD_STORE_PREFIX = "xmx.boards.v1";
export const LOCAL_STORE_PREFIX = "xmx.local.v5";
export const MIGRATION_MARK_PREFIX = "xmx.migrated.v5";

export const BOARD_KEYS = ["collab", "gift"];
export const BOARD_LABELS = { collab: "联动", gift: "满赠" };
export const BOARD_RESERVED_NAMES = new Set(["全部", "未分类"]);

export const DEFAULT_GIFT_CATEGORIES = [
  { id: "gift_badge", name: "吧唧" },
  { id: "gift_paper", name: "纸片" },
  { id: "gift_acrylic", name: "亚克力" },
  { id: "gift_other", name: "其他" }
];

export const DEFAULT_CATEGORY_CONFIG = {
  main: [
    { key: "badge", label: "吧唧" },
    { key: "laser_ticket", label: "镭射票" },
    { key: "poster", label: "海报" },
    { key: "folder", label: "文件夹" },
    { key: "hanging_picture", label: "挂画" },
    { key: "coaster_set", label: "杯垫套" },
    { key: "paper", label: "纸制品" },
    { key: "gift_box", label: "礼盒" },
    { key: "practical", label: "实用谷" },
    { key: "standee", label: "立牌" },
    { key: "mahjong", label: "麻将" },
    { key: "decorative_painting", label: "装饰画" },
    { key: "keychain", label: "挂件" },
    { key: "acrylic", label: "亚克力制品" },
    { key: "plush", label: "毛绒" },
    { key: "art_card", label: "色纸" },
    { key: "collection_card", label: "收藏卡" },
    { key: "memorial_card", label: "纪念卡" },
    { key: "handwritten_letter", label: "手写信" },
    { key: "small_card", label: "小卡" }
  ],
  boards: [
    { key: "collab", label: "联动" },
    { key: "gift", label: "满赠" }
  ],
  pending: { key: "pending", label: "待核对" }
};

export const MAIN_CATEGORY_KEYS = new Set(DEFAULT_CATEGORY_CONFIG.main.map((c) => c.key));

export const BOARD_KEY_FOR_PRODUCT = {
  collab: { label: "联动" },
  gift: { label: "满赠" }
};

export const ERROR_CODES = {
  CONFLICT: "XMX_CONFLICT",
  DELETED: "XMX_DELETED",
  AUTH: "XMX_AUTH",
  CONFIG: "XMX_CONFIG",
  STORAGE: "XMX_STORAGE",
  DUPLICATE: "XMX_DUPLICATE"
};

export function defaultCategoryLabel(key) {
  return DEFAULT_CATEGORY_CONFIG.main.find((c) => c.key === key)?.label || "";
}
