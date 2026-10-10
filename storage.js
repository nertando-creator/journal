// storage.js — ВСЁ общение с Supabase только здесь.
// Все методы кидают Error с понятным текстом; логирует и показывает ошибки app.js.
(function () {
  const cfg = window.APP_CONFIG;
  let sb = null;

  // Настоящий текст ошибки Supabase: сообщение, имя, HTTP-статус, код, детали, подсказка
  function describe(error) {
    if (!error) return 'неизвестная ошибка';
    if (typeof error === 'string') return error;
    const msg = error.message || String(error);
    const meta = [];
    if (error.name && error.name !== 'Error' && !msg.includes(error.name)) meta.push(error.name);
    if (error.status) meta.push('HTTP ' + error.status);
    if (error.statusCode) meta.push('HTTP ' + error.statusCode);
    if (error.code) meta.push('код ' + error.code);
    let out = msg + (meta.length ? ` [${meta.join(', ')}]` : '');
    if (error.details) out += ' | ' + error.details;
    if (error.hint) out += ' | подсказка: ' + error.hint;
    return out;
  }
  function fail(ctx, error) {
    throw new Error(`${ctx}: ${describe(error)}`);
  }
  // https://xxxx.supabase.co/rest/v1/ → https://xxxx.supabase.co
  function cleanUrl(u) {
    let s = String(u || '').trim();
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    const m = s.match(/^(https?:\/\/[^\/?#:]+?\.supabase\.co)(?=[\/?#:]|$)/i);
    return m ? m[1] : s.replace(/\/+$/, '');
  }

  window.DB = {
    // ---------- старт ----------
    isConfigured() {
      return !!cfg && !/ВСТАВЬ/.test(String(cfg.SUPABASE_URL) + String(cfg.SUPABASE_KEY));
    },
    supabaseUrl() { return cleanUrl(cfg.SUPABASE_URL); },
    init() { sb = window.supabase.createClient(cleanUrl(cfg.SUPABASE_URL), String(cfg.SUPABASE_KEY).trim()); },
    ready() { return !!sb; },

    // ---------- вход ----------
    async getSession() {
      const { data, error } = await sb.auth.getSession();
      if (error) fail('Сессия', error);
      return data.session;
    },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) fail('Вход', error);
      return data.session;
    },
    onSignedOut(cb) {
      sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT') setTimeout(cb, 0); });
    },

    // ---------- папки ----------
    async listFolders() {
      const { data, error } = await sb.from('folders').select('*').order('position').order('created_at');
      if (error) fail('Папки: загрузка', error);
      return data;
    },
    async createFolder(name, position) {
      const { data, error } = await sb.from('folders').insert({ name, position }).select().single();
      if (error) fail('Папки: создание', error);
      return data;
    },
    async renameFolder(id, name) {
      const { error } = await sb.from('folders').update({ name }).eq('id', id);
      if (error) fail('Папки: переименование', error);
    },

    // ---------- картинки ----------
    async listImages(folderId) {
      let q = sb.from('images').select('*').order('created_at', { ascending: false });
      q = folderId === null ? q.is('folder_id', null) : q.eq('folder_id', folderId);
      const { data, error } = await q;
      if (error) fail('Картинки: загрузка', error);
      return data;
    },
    // Поиск повторов по всей библиотеке: по хешу и по названию (точное совпадение)
    async findDuplicates(hashes, titles) {
      const found = new Map();
      const cols = 'id,title,hash,folder_id,preview_path,original_path';
      if (hashes.length) {
        const { data, error } = await sb.from('images').select(cols).in('hash', hashes);
        if (error) fail('Проверка дублей (хеш)', error);
        data.forEach((r) => found.set(r.id, r));
      }
      if (titles.length) {
        const { data, error } = await sb.from('images').select(cols).in('title', titles);
        if (error) fail('Проверка дублей (название)', error);
        data.forEach((r) => found.set(r.id, r));
      }
      return [...found.values()];
    },
    // Загрузка оригинала + превью + запись в базу. При ошибке убирает уже загруженные файлы.
    async addImage(meta, file, mime, previewBlob) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) fail('Нет сессии', 'войди заново');
      const uid = session.user.id;
      const originalPath = `${uid}/original/${meta.id}.${meta.ext}`;
      const previewPath = `${uid}/preview/${meta.id}.webp`;
      const uploaded = [];
      const put = async (path, blob, type) => {
        const { error } = await sb.storage.from(cfg.BUCKET).upload(path, blob, { contentType: type, upsert: false, cacheControl: '3600' });
        if (error) fail(`Хранилище: загрузка ${path}`, error);
        uploaded.push(path);
      };
      try {
        await put(originalPath, file, mime);
        await put(previewPath, previewBlob, previewBlob.type || 'image/webp');
        const row = {
          id: meta.id, title: meta.title, folder_id: meta.folder_id, created_at: meta.created_at,
          hash: meta.hash, width: meta.width, height: meta.height, size: meta.size,
          original_path: originalPath, preview_path: previewPath
        };
        const { data, error } = await sb.from('images').insert(row).select().single();
        if (error) fail('База: добавление картинки', error);
        return data;
      } catch (e) {
        if (uploaded.length) await sb.storage.from(cfg.BUCKET).remove(uploaded);
        throw e;
      }
    },
    async updateImage(id, patch) {
      const { error } = await sb.from('images').update(patch).eq('id', id);
      if (error) fail('Картинка: сохранение', error);
    },
    // Удаляет строку, потом файлы. Если файлы не удалились, бросает ошибку с путями (строка уже удалена).
    async deleteImage(img) {
      const { error } = await sb.from('images').delete().eq('id', img.id);
      if (error) fail('Картинка: удаление', error);
      const paths = [img.original_path, img.preview_path].filter(Boolean);
      const res = await sb.storage.from(cfg.BUCKET).remove(paths);
      if (res.error) fail(`Запись удалена, но файлы остались (${paths.join(', ')})`, res.error);
    },

    // ---------- подписанные ссылки ----------
    async signUrls(paths, ttl) {
      const { data, error } = await sb.storage.from(cfg.BUCKET).createSignedUrls(paths, ttl);
      if (error) fail('Ссылки на файлы', error);
      return data;
    }
  };
})();
