// config.js — настройки. Единственный файл, который нужно заполнить руками.
window.APP_CONFIG = {
  // ⚠ ЗАПОЛНИТЬ: Supabase → Project Settings → API
  SUPABASE_URL: "https://xaqdgwevjrttivskyofa.supabase.co/rest/v1/",          // ← плейсхолдер, заменить
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhhcWRnd2V2anJ0dGl2c2t5b2ZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1NzA1MTIsImV4cCI6MjEwNzE0NjUxMn0.7HOKAQE2WrAn8GXk2tIa8zceEyAFFKoE-X4RyoCzryg",       // ← плейсхолдер: anon / publishable. НЕ service_role!

  BUCKET: "charts",              // имя приватного бакета (создаётся скриптом supabase_setup.sql)
  SIGNED_URL_TTL: 4 * 60 * 60,   // срок подписанных ссылок, секунды (4 часа)
  MAX_FILE_MB: 10,               // лимит на каждый файл
  PREVIEW_WIDTH: 600,            // ширина превью, px
  PREVIEW_QUALITY: 0.85,         // качество WebP
  UPLOAD_CONCURRENCY: 3          // сколько файлов грузится одновременно
};
