// config.js — настройки. Единственный файл, который нужно заполнить руками.
window.APP_CONFIG = {
  // ⚠ ЗАПОЛНИТЬ: Supabase → Project Settings → API
  SUPABASE_URL: "https://xaqdgwevjrttivskyofa.supabase.co/rest/v1/",          // ← плейсхолдер, заменить
  SUPABASE_KEY: "sb_publishable_rqqUlyrgwyo_r3jrynflqg_uwm3o1G-",       // ← плейсхолдер: anon / publishable. НЕ service_role!

  BUCKET: "charts",              // имя приватного бакета (создаётся скриптом supabase_setup.sql)
  SIGNED_URL_TTL: 4 * 60 * 60,   // срок подписанных ссылок, секунды (4 часа)
  MAX_FILE_MB: 10,               // лимит на каждый файл
  PREVIEW_WIDTH: 600,            // ширина превью, px
  PREVIEW_QUALITY: 0.85,         // качество WebP
  UPLOAD_CONCURRENCY: 3          // сколько файлов грузится одновременно
};
