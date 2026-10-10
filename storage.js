// storage.js — ВСЁ общение с Supabase только здесь.
// Все методы кидают Error с понятным текстом; логирует и показывает ошибки app.js.
(function () {
  const cfg = window.APP_CONFIG;
  let sb = null;
  let authToken = null;   // нужен для запроса keepalive при закрытии вкладки

  const CACHE_CONTROL = '31536000';          // новые файлы: кэш браузера на год (имена файлов уникальны)
  const RETRY_DELAYS = [500, 1500, 3000];    // до 3 повторов при сбоях сети, пауза растёт
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let noPreviewCol = false;                  // в images нет колонки preview_size (см. SQL в описании v3.0): пишем без неё
  let netIsDown = false;
  function netDown() { if (!netIsDown) { netIsDown = true; if (window.DB && window.DB.onNet) window.DB.onNet(false); } }
  function netUp() { if (netIsDown) { netIsDown = false; if (window.DB && window.DB.onNet) window.DB.onNet(true); } }
  // Сбой сети или сервера (повтор имеет смысл), в отличие от ошибок данных и прав (повтор бесполезен)
  function isTransient(err) {
    if (!err) return false;
    const st = Number(err.status || err.statusCode || 0);
    if (st) return st >= 500 || st === 408 || st === 429;
    return /failed to fetch|fetch|network|timeout|timed out|load failed|connection|aborted|offline/i.test(String(err.message || err));
  }

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
    e.transient = isTransient(error);
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
      // до 3 повторов при сбоях сети; пути уникальны, поэтому повторная загрузка безопасна (upsert)
      const attempt = async (label, fn) => {
        for (let i = 0; ; i++) {
          const res = await Promise.resolve().then(fn).catch((e) => ({ error: e }));   // конструктор запроса Supabase не Promise, поэтому оборачиваем
          if (!res.error) { netUp(); return res; }
          if (!isTransient(res.error)) { netUp(); return res; }
          netDown();
          if (i >= RETRY_DELAYS.length) return res;
          if (window.DB.onRetry) window.DB.onRetry(label, i + 1, res.error);
          await sleep(RETRY_DELAYS[i]);
        }
      };
      try {
        for (const [path, blob, type] of [[originalPath, file, mime], [previewPath, previewBlob, previewBlob.type || 'image/webp']]) {
          const r = await attempt('загрузка файла', () => sb.storage.from(cfg.BUCKET).upload(path, blob, { contentType: type, upsert: true, cacheControl: CACHE_CONTROL }));
          if (r.error) fail(`Хранилище: загрузка ${path}`, r.error);
          uploaded.push(path);
        }
        const row = {
          id: meta.id, title: meta.title, folder_id: meta.folder_id, created_at: meta.created_at,
          hash: meta.hash, width: meta.width, height: meta.height, size: meta.size,
          original_path: originalPath, preview_path: previewPath
        };
        if (!noPreviewCol) row.preview_size = previewBlob.size;
        const ins = () => sb.from('images').insert(row).select().single();
        let res = await attempt('запись в базу', ins);
        if (res.error && row.preview_size !== undefined && /preview_size/.test(res.error.message || '')) {
          noPreviewCol = true; delete row.preview_size;           // колонки ещё нет: пишем без размера превью
          res = await attempt('запись в базу', ins);
        }
        if (res.error && res.error.code === '23505') {            // повтор после потерянного ответа: запись уже есть
          res = await sb.from('images').select('*, image_tags(tag_id)').eq('id', meta.id).single();
        }
        if (res.error) fail('База: добавление картинки', res.error);
        return normImage(res.data);
      } catch (e) {
        // при обрыве связи не знаем, записалась ли строка: файлы не трогаем, чтобы не сломать возможную запись
        if (uploaded.length && !e.transient) await sb.storage.from(cfg.BUCKET).remove(uploaded);
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

    // ---------- фоновая подгрузка, занятое место, проверка связи ----------
    async listAllImages() {
      const all = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from('images').select('*, image_tags(tag_id)').order('created_at', { ascending: false }).range(from, from + 999);
        if (error) fail('Картинки: фоновая загрузка', error);
        all.push(...data);
        if (data.length < 1000) break;
      }
      return all.map(normImage);
    },
    async listUsage() {                      // размеры файлов; preview_size может отсутствовать (тогда оценка в app.js)
      const all = [];
      for (let from = 0; ; from += 1000) {
        let { data, error } = await sb.from('images').select('size,preview_size').order('id').range(from, from + 999);
        if (error && /preview_size/.test(error.message || '')) ({ data, error } = await sb.from('images').select('size').order('id').range(from, from + 999));
        if (error) fail('Занятое место', error);
        all.push(...data);
        if (data.length < 1000) break;
      }
      return all;
    },
    async ping() {
      const { error } = await sb.from('folders').select('id').limit(1);
      if (error && isTransient(error)) { netDown(); throw new Error(describe(error)); }
      netUp();
    },
    markDown() { netDown(); },

    // ---------- подписанные ссылки ----------
    async signUrls(paths, ttl) {
      const { data, error } = await sb.storage.from(cfg.BUCKET).createSignedUrls(paths, ttl);
      if (error) fail('Ссылки на файлы', error);
      return data;
    }
  };

  // Повторы при сбоях сети для безопасных (идемпотентных) операций: до 3 раз с растущей паузой.
  // Создание папки и тега не повторяем: повтор мог бы создать дубль.
  ['getSession', 'listFolders', 'renameFolder', 'saveFolderOrder', 'listImages', 'listAllImages', 'listUsage', 'updateImage', 'deleteImage',
   'listTags', 'setImageTag', 'countImages', 'countTagUsage', 'deleteTag', 'signUrls'].forEach((name) => {
    const orig = window.DB[name];
    window.DB[name] = async function (...args) {
      for (let i = 0; ; i++) {
        try { const r = await orig.apply(window.DB, args); netUp(); return r; }
        catch (e) {
          const tr = e.transient !== undefined ? e.transient : isTransient(e);
          if (!tr) { netUp(); throw e; }
          netDown();
          if (i >= RETRY_DELAYS.length) throw e;
          if (window.DB.onRetry) window.DB.onRetry(name, i + 1, e);
          await sleep(RETRY_DELAYS[i]);
        }
      }
    };
  });
})();
