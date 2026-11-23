-- ============================================================================
-- 星愿收藏室 v5 · 固定主分类 / 作品 / 角色种子数据
-- 20 个主分类顺序不可变；商品数据由登录后的迁移流程按用户导入。
-- ============================================================================

insert into public.works (id, title, sort_order)
values ('gyly', '光与夜之恋', 1)
on conflict (id) do update set title = excluded.title, sort_order = excluded.sort_order;

insert into public.characters (work_id, id, name, theme, catalog, total, sort_order)
values (
  'gyly', 'xmx', '夏鸣星',
  '{"--pink":"#d989a2","--pink-dark":"#b76d86","--pale":"#fdf1f4"}'::jsonb,
  'data/gyly/xmx/products.json',
  1537,
  1
)
on conflict (work_id, id) do update set
  name = excluded.name,
  theme = excluded.theme,
  catalog = excluded.catalog,
  total = excluded.total,
  sort_order = excluded.sort_order;

insert into public.main_categories (key, label, sort_order) values
  ('badge', '吧唧', 1),
  ('laser_ticket', '镭射票', 2),
  ('poster', '海报', 3),
  ('folder', '文件夹', 4),
  ('hanging_picture', '挂画', 5),
  ('coaster_set', '杯垫套', 6),
  ('paper', '纸制品', 7),
  ('gift_box', '礼盒', 8),
  ('practical', '实用谷', 9),
  ('standee', '立牌', 10),
  ('mahjong', '麻将', 11),
  ('decorative_painting', '装饰画', 12),
  ('keychain', '挂件', 13),
  ('acrylic', '亚克力制品', 14),
  ('plush', '毛绒', 15),
  ('art_card', '色纸', 16),
  ('collection_card', '收藏卡', 17),
  ('memorial_card', '纪念卡', 18),
  ('handwritten_letter', '手写信', 19),
  ('small_card', '小卡', 20)
on conflict (key) do update set
  label = excluded.label,
  sort_order = excluded.sort_order;
