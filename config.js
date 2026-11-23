/* 公开的浏览器端配置：Supabase Publishable Key，可安全暴露。
 * 绝不能把 service_role / secret key 写进本文件。
 * GitHub Pages 没有构建步骤，因此本文件需要提交；Vercel 优先用环境变量生成。
 */
window.XMX_CONFIG = {
  supabaseUrl: "https://lcwdgtbzeifqvsyewgpe.supabase.co",
  supabaseAnonKey: "sb_publishable_tZiHS7qcd_UGXW9EdvFWZA_rxr_ITZz",
  storageBucket: "product-images",
  appVersion: "5.0.0",
  demoFallback: false
};
