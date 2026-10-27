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
  let slotsOn = false;                       // есть ли в images колонки слотов/Дата/ТФ (SQL v4.5); без них новые поля скрыты
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

  const SLOT_COLS = 'chart_path,chart_preview_path,chart_size,extra_path,extra_preview_path,extra_size,symbol,timeframe,range_from,range_to,chart_params';
  // все пути файлов записи: до трёх оригиналов и до трёх превью
  const allPaths = (r) => [r.original_path, r.preview_path, r.chart_path, r.chart_preview_path, r.extra_path, r.extra_preview_path].filter(Boolean);
  // повторы при сбоях сети для одной операции (пути уникальны, повтор безопасен)
  async function attemptNet(label, fn) {
    for (let i = 0; ; i++) {
      const res = await Promise.resolve().then(fn).catch((e) => ({ error: e }));
      if (!res.error) { netUp(); return res; }
      if (!isTransient(res.error)) { netUp(); return res; }
      netDown();
      if (i >= RETRY_DELAYS.length) return res;
      if (window.DB.onRetry) window.DB.onRetry(label, i + 1, res.error);
      await sleep(RETRY_DELAYS[i]);
    }
  }
  let usageCols = null;                      // какой набор колонок для подсчёта места работает

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
    slotsOn() { return slotsOn; },
    // Есть ли новые колонки (SQL v4.5). Сбой сети пробрасывается (будет повтор), «колонки нет» = слоты выключены.
    async probeSlots() {
      const { error } = await sb.from('images').select(SLOT_COLS).limit(1);
      if (error) {
        if (isTransient(error)) fail('Проверка новых колонок', error);
        slotsOn = false; return { on: false, why: describe(error) };
      }
      slotsOn = true; return { on: true };
    },

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
        if (slotsOn && meta.symbol !== undefined) { row.symbol = meta.symbol; row.timeframe = meta.timeframe; }
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
      const paths = allPaths(img);
      const res = await sb.storage.from(cfg.BUCKET).remove(paths);
      if (res.error) fail(`Запись удалена, но файлы остались (${paths.join(', ')})`, res.error);
    },
    // Слот картинки (chart | extra): загрузка оригинала и превью, потом запись путей в строку. Возвращает patch для строки.
    async addSlotImage(imageId, slot, file, mime, previewBlob, ext) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) fail('Нет сессии', 'войди заново');
      const uid = session.user.id, tag = crypto.randomUUID();
      const fullPath = `${uid}/${slot}/${imageId}_${tag}.${ext}`;
      const prevPath = `${uid}/${slot}_preview/${imageId}_${tag}.webp`;
      const uploaded = [];
      try {
        for (const [path, blob, type] of [[fullPath, file, mime], [prevPath, previewBlob, previewBlob.type || 'image/webp']]) {
          const r = await attemptNet('загрузка файла', () => sb.storage.from(cfg.BUCKET).upload(path, blob, { contentType: type, upsert: true, cacheControl: CACHE_CONTROL }));
          if (r.error) fail(`Хранилище: загрузка ${path}`, r.error);
          uploaded.push(path);
        }
        const patch = { [slot + '_path']: fullPath, [slot + '_preview_path']: prevPath, [slot + '_size']: file.size };
        const r = await attemptNet('запись в базу', () => sb.from('images').update(patch).eq('id', imageId));
        if (r.error) fail('База: запись слота', r.error);
        return patch;
      } catch (e) {
        if (uploaded.length && !e.transient) await sb.storage.from(cfg.BUCKET).remove(uploaded);   // при обрыве связи файлы не трогаем: неизвестно, записалась ли строка
        throw e;
      }
    },
    // Замена «Основной» (построение графика): новые файлы с новыми именами → строка → и только потом удаление старых файлов.
    // Результат относится к записи id, а не к открытой сейчас. Если записи уже нет, новые файлы удаляются (ошибка с code 'GONE').
    async replaceChart(imageId, file, previewBlob, params, range) {   // range (необязательно): { from, to } в ISO, пишется в той же строке, что и картинка
      const { data: { session } } = await sb.auth.getSession();
      if (!session) fail('Нет сессии', 'войди заново');
      const cur = await attemptNet('чтение записи', () => sb.from('images').select('id,chart_path,chart_preview_path,chart_size').eq('id', imageId).maybeSingle());
      if (cur.error) fail('База: чтение записи', cur.error);
      if (!cur.data) throw Object.assign(new Error('Запись удалена, новые файлы не загружались'), { code: 'GONE' });
      const old = [cur.data.chart_path, cur.data.chart_preview_path].filter(Boolean);
      const uid = session.user.id, tag = crypto.randomUUID();
      const fullPath = `${uid}/chart/${tag}.png`, prevPath = `${uid}/chart_preview/${tag}.webp`;
      const uploaded = [];
      try {
        for (const [path, blob, type] of [[fullPath, file, 'image/png'], [prevPath, previewBlob, previewBlob.type || 'image/webp']]) {
          const r = await attemptNet('загрузка файла', () => sb.storage.from(cfg.BUCKET).upload(path, blob, { contentType: type, upsert: true, cacheControl: CACHE_CONTROL }));
          if (r.error) fail(`Хранилище: загрузка ${path}`, r.error);
          uploaded.push(path);
        }
        const patch = { chart_path: fullPath, chart_preview_path: prevPath, chart_size: file.size, chart_params: params };
        if (range) { patch.range_from = range.from || null; patch.range_to = range.to || null; }   // одним обновлением с картинкой
        const r = await attemptNet('запись в базу', () => sb.from('images').update(patch).eq('id', imageId).select('id'));
        if (r.error) fail('База: запись основной картинки', r.error);
        if (!r.data || !r.data.length) throw Object.assign(new Error('Запись удалена во время построения, новые файлы удалены'), { code: 'GONE' });
        let oldFail = null;
        if (old.length) {
          const res = await sb.storage.from(cfg.BUCKET).remove(old);
          if (res.error) oldFail = `Старые файлы основной остались в хранилище (${old.join(', ')}): ${describe(res.error)}`;
        }
        return { patch, oldSize: cur.data.chart_size || 0, oldFail };
      } catch (e) {
        if (uploaded.length && !e.transient) await sb.storage.from(cfg.BUCKET).remove(uploaded);   // при обрыве связи файлы не трогаем: неизвестно, записалась ли строка
        throw e;
      }
    },
    // Очищает слот: сначала строка (поля в null), потом файлы. Если файлы не удалились, ошибка с путями.
    async removeSlotImage(img, slot) {
      const paths = [img[slot + '_path'], img[slot + '_preview_path']].filter(Boolean);
      const { error } = await sb.from('images').update({ [slot + '_path']: null, [slot + '_preview_path']: null, [slot + '_size']: null }).eq('id', img.id);
      if (error) fail('Слот: очистка', error);
      if (!paths.length) return;
      const res = await sb.storage.from(cfg.BUCKET).remove(paths);
      if (res.error) fail(`Слот очищен, но файлы остались (${paths.join(', ')})`, res.error);
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
        const { data, error } = await sb.from('images').select('id,original_path,preview_path' + (slotsOn ? ',chart_path,chart_preview_path,extra_path,extra_preview_path' : '')).eq('folder_id', folderId).order('created_at').range(from, from + 999);
        if (error) fail('Папка: список картинок', error);
        imgs.push(...data);
        if (data.length < 1000) break;
      }
      const res = { total: imgs.length, deleted: 0, files: 0, failures: [], folderDeleted: false };
      const CH = 20;
      for (let i = 0; i < imgs.length; i += CH) {
        const chunk = imgs.slice(i, i + CH);
        const paths = chunk.flatMap(allPaths);
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
    async listUsage() {                      // размеры файлов; preview_size и слоты могут отсутствовать (тогда оценка в app.js)
      const chain = ['size,preview_size,chart_size,extra_size', 'size,preview_size', 'size'];
      const all = [];
      for (let from = 0; ; from += 1000) {
        let data = null, error = null;
        for (const cols of (usageCols ? [usageCols] : chain)) {
          ({ data, error } = await sb.from('images').select(cols).order('id').range(from, from + 999));
          if (!error) { usageCols = cols; break; }
          if (isTransient(error) || !/preview_size|chart_size|extra_size/.test(error.message || '')) break;
        }
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
   'listTags', 'setImageTag', 'countImages', 'countTagUsage', 'deleteTag', 'signUrls', 'probeSlots', 'removeSlotImage'].forEach((name) => {
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
