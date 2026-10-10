// storage.js — ВСЁ общение с Supabase только здесь.
// Все методы кидают Error с понятным текстом; логирует и показывает ошибки app.js.
(function () {
  const cfg = window.APP_CONFIG;
  let sb = null;
  let authToken = null;   // нужен для запроса keepalive при закрытии вкладки

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
    const e = new Error(`${ctx}: ${describe(error)}`);
    if (error && error.code) e.code = error.code;
    throw e;
  }
  // у картинки теги приходят вложенной выборкой image_tags → превращаем в tag_ids
  function normImage(r) {
    const o = Object.assign({}, r);
    o.tag_ids = (o.image_tags || []).map((x) => x.tag_id);
    delete o.image_tags;
    return o;
  }
  // https://xxxx.supabase.co/rest/v1/ → https://xxxx.supabase.co
  function cleanUrl(u) {
    let s = String(u || '').trim();
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    const m = s.match(/^(https?:\/\/[^\/?#:]+?\.supabase\.co)(?=[\/?#:]|$)/i);
    return m ? m[1] : s.replace(/\/+$/, '');
  }

  async function countImagesOf(folderId) {
    const { count, error } = await sb.from('images').select('id', { count: 'exact', head: true }).eq('folder_id', folderId);
    if (error) fail('Папка: подсчёт картинок', error);
    return count || 0;
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
      authToken = data.session ? data.session.access_token : null;
      return data.session;
    },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) fail('Вход', error);
      authToken = data.session ? data.session.access_token : null;
      return data.session;
    },
    onSignedOut(cb) {
      sb.auth.onAuthStateChange((evt, session) => {
        authToken = session ? session.access_token : null;
        if (evt === 'SIGNED_OUT') setTimeout(cb, 0);
      });
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
      let q = sb.from('images').select('*, image_tags(tag_id)').order('created_at', { ascending: false });
      q = folderId === null ? q.is('folder_id', null) : q.eq('folder_id', folderId);
      const { data, error } = await q;
      if (error) fail('Картинки: загрузка', error);
      return data.map(normImage);
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
        return normImage(data);
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

    // Быстрая запись при закрытии вкладки (переживает выгрузку страницы)
    patchImageKeepalive(id, patch) {
      if (!authToken) return false;
      try {
        fetch(`${cleanUrl(cfg.SUPABASE_URL)}/rest/v1/images?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH', keepalive: true,
          headers: { apikey: String(cfg.SUPABASE_KEY).trim(), Authorization: 'Bearer ' + authToken, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(patch)
        }).catch(() => {});
        return true;
      } catch { return false; }
    },

    // ---------- порядок вкладок и удаление папки ----------
    async saveFolderOrder(rows) {            // обновляем только position, чтобы не затереть переименование
      const res = await Promise.all(rows.map((r) => sb.from('folders').update({ position: r.position }).eq('id', r.id)));
      const bad = res.find((r) => r.error);
      if (bad) fail('Папки: порядок', bad.error);
    },
    countImages(folderId) { return countImagesOf(folderId); },
    // Удаляет картинки папки (файлы в хранилище, потом записи), и только если не осталось ни одной, саму папку.
    // Не бросает ошибок по пачкам: возвращает отчёт, чтобы ничего не терялось молча.
    async deleteFolderWithImages(folderId) {
      const imgs = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from('images').select('id,original_path,preview_path').eq('folder_id', folderId).order('created_at').range(from, from + 999);
        if (error) fail('Папка: список картинок', error);
        imgs.push(...data);
        if (data.length < 1000) break;
      }
      const res = { total: imgs.length, deleted: 0, files: 0, failures: [], folderDeleted: false };
      const CH = 20;
      for (let i = 0; i < imgs.length; i += CH) {
        const chunk = imgs.slice(i, i + CH);
        const paths = chunk.flatMap((x) => [x.original_path, x.preview_path]).filter(Boolean);
        try {
          const r = await sb.storage.from(cfg.BUCKET).remove(paths);
          if (r.error) fail(`Хранилище: удаление файлов (пачка ${i / CH + 1}, ${paths.length} шт.)`, r.error);
          res.files += (r.data || []).length;
          const { error } = await sb.from('images').delete().in('id', chunk.map((x) => x.id));
          if (error) fail(`База: удаление записей (пачка ${i / CH + 1}, ${chunk.length} шт.)`, error);
          res.deleted += chunk.length;
        } catch (e) { res.failures.push(e.message); }
      }
      if (!res.failures.length) {
        try {
          const left = await countImagesOf(folderId);
          if (left > 0) res.failures.push(`в папке осталось картинок: ${left} (добавлены во время удаления?)`);
        } catch (e) { res.failures.push(e.message); }
      }
      if (!res.failures.length) {
        const { error } = await sb.from('folders').delete().eq('id', folderId);
        if (error) res.failures.push(describe(error)); else res.folderDeleted = true;
      }
      return res;
    },

    // ---------- теги ----------
    async listTags() {
      const { data, error } = await sb.from('tags').select('*').order('name');
      if (error) fail('Теги: загрузка', error);
      return data;
    },
    async countTagUsage(tagId) {
      const { count, error } = await sb.from('image_tags').select('image_id', { count: 'exact', head: true }).eq('tag_id', tagId);
      if (error) fail('Тег: подсчёт использования', error);
      return count || 0;
    },
    // Связи image_tags удаляются каскадом (on delete cascade в supabase_setup.sql)
    async deleteTag(tagId) {
      const { error } = await sb.from('tags').delete().eq('id', tagId);
      if (error) fail('Тег: удаление', error);
    },
    async createTag(name) {
      const { data, error } = await sb.from('tags').insert({ name }).select().single();
      if (error) fail('Теги: создание', error);
      return data;
    },
    // Идемпотентно: включить (upsert без дублей) или снять тег с картинки
    async setImageTag(imageId, tagId, on) {
      if (on) {
        const { error } = await sb.from('image_tags').upsert({ image_id: imageId, tag_id: tagId }, { onConflict: 'image_id,tag_id', ignoreDuplicates: true });
        if (error) fail('Теги: добавление к картинке', error);
      } else {
        const { error } = await sb.from('image_tags').delete().eq('image_id', imageId).eq('tag_id', tagId);
        if (error) fail('Теги: снятие с картинки', error);
      }
    },

    // ---------- подписанные ссылки ----------
    async signUrls(paths, ttl) {
      const { data, error } = await sb.storage.from(cfg.BUCKET).createSignedUrls(paths, ttl);
      if (error) fail('Ссылки на файлы', error);
      return data;
    }
  };
})();
