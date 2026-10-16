/* app.js — интерфейс. С Supabase общается только через DB (storage.js). */
const APP_VERSION = 'v4.1';
const CFG = window.APP_CONFIG;
let viewMode = 'gallery';                // какое окно открыто: 'gallery' (Формации) или 'market' (График); меняет market.js
const $ = (s, r = document) => r.querySelector(s);

// ---- настройки, которые удобно менять одной строкой ----
const STORAGE_LIMIT_BYTES = 1024 ** 3;   // лимит хранилища (1 ГБ) для текста «Занято: X из …»
const GRID_CHUNK = 80;                   // сколько карточек добавляется за раз при прокрутке
const SKELETON_COUNT = 14;               // заглушек в сетке, пока грузится список
const PREVIEW_RATIO = 0.15;              // оценка размера превью от оригинала, если реальный размер не записан
const LOGS_KEEP = 200;                   // сколько последних записей логов хранить в браузере
const PRELOAD_CONCURRENCY = 4;           // сколько превью одновременно подгружать в фоне
const URL_REFRESH_MS = 10 * 60 * 1000;   // за сколько до конца срока обновлять подписанную ссылку

/* ================= ЛОГИ И УВЕДОМЛЕНИЯ ================= */
// Логи: последние LOGS_KEEP записей хранятся в localStorage и переживают F5
const LOGS_KEY = 'journal_logs_v1';
let logEntries = [];
let logSaveTimer = null;
function loadLogs() {
  try {
    const a = JSON.parse(localStorage.getItem(LOGS_KEY) || '[]');
    if (Array.isArray(a)) logEntries = a.filter((x) => x && x.level && x.line).slice(-LOGS_KEEP);
  } catch { /* localStorage недоступен или пуст */ }
}
function saveLogsNow() { try { localStorage.setItem(LOGS_KEY, JSON.stringify(logEntries)); } catch { /* переполнение или запрет: не критично */ } }
function saveLogsSoon() { clearTimeout(logSaveTimer); logSaveTimer = setTimeout(saveLogsNow, 400); }
function logRow(e) { const d = document.createElement('div'); d.className = 'log-' + e.level; d.textContent = e.line; return d; }
function renderLogs() {
  const body = $('#logs-body'); body.textContent = '';
  logEntries.forEach((e) => body.appendChild(logRow(e)));
  body.scrollTop = body.scrollHeight;
}
function log(level, msg) {
  const when = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const e = { level, line: `[${when}] [${level}] ${msg}` };
  logEntries.push(e);
  const body = $('#logs-body');
  if (logEntries.length > LOGS_KEEP) { logEntries.shift(); if (body.firstChild) body.firstChild.remove(); }
  body.appendChild(logRow(e));
  body.scrollTop = body.scrollHeight;
  (level === 'ERR' ? console.error : console.log)(e.line);
  saveLogsSoon();
}
function setLogFilter(mode) {
  $('#logs-body').classList.toggle('only-err', mode === 'err');
  $('#logs-all').classList.toggle('active', mode !== 'err');
  $('#logs-err').classList.toggle('active', mode === 'err');
}
function clearLogs() {
  logEntries = []; renderLogs();
  try { localStorage.removeItem(LOGS_KEY); } catch { /* ничего */ }
}
const logI = (m) => log('INFO', m);
const logW = (m) => log('WARN', m);
const logE = (m) => log('ERR', m);
const errMsg = (e) => {
  if (!e) return 'неизвестная ошибка';
  const m = e.message || String(e);
  return e.name && e.name !== 'Error' && !m.includes(e.name) ? `${e.name}: ${m}` : m;
};

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

async function copyLogs() {
  const text = `Журнал сетапов ${APP_VERSION}\n` + logEntries.map((e) => e.line).join('\n');
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast('Логи скопированы');
}

window.addEventListener('error', (e) => logE(`Ошибка JS: ${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => logE(`Необработанная ошибка: ${errMsg(e.reason)}`));

/* ================= СОСТОЯНИЕ И ИКОНКИ ================= */
const state = {
  folders: [],
  tags: [],                    // общие теги (все вкладки)
  menu: null,                  // открытый выпадающий список
  loadingImages: false,        // идёт загрузка списка: заглушки вместо карточек
  loadFailed: false,           // последняя загрузка списка не удалась
  gridCount: GRID_CHUNK,       // сколько карточек сейчас показано (порциями)
  usedBytes: null,             // занятое место (оригиналы + превью)
  usedApprox: false,           // в сумме есть оценка размера превью
  activeFolder: null,          // null = «Не отсортированные»
  images: [],                  // картинки активной вкладки, новые первыми
  pending: [],                 // заглушки загружаемых файлов
  modalId: null,
  loadSeq: 0,
  up: { total: 0, done: 0, failed: 0 }
};
const ICON_FOLDER = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v7M14 10v7"/></svg>';

const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b >= 2 && b <= 4 ? f[1] : f[2]; };
const ICON_CLOSE = '<svg viewBox="0 0 10 10" ><path d="M1 1l8 8M9 1l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const folderName = (id) => id === null || id === undefined ? 'Не отсортированные' : ((state.folders.find((f) => f.id === id) || {}).name || '?');
const isTyping = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
const byDateDesc = (a, b) => new Date(b.created_at) - new Date(a.created_at);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

/* ================= ПОДПИСАННЫЕ ССЫЛКИ ================= */
// Подписанные ссылки живут в памяти и в sessionStorage (переживают F5 в этой вкладке): адрес не меняется,
// поэтому кэш браузера работает. Срок задаёт config.js (SIGNED_URL_TTL); перед концом срока ссылка обновляется.
const URL_STORE_KEY = 'journal_urls_v1';
const urlCache = new Map(); // path -> { url, exp }
(function restoreUrls() {
  try {
    const o = JSON.parse(sessionStorage.getItem(URL_STORE_KEY) || '{}'), now = Date.now();
    Object.entries(o).forEach(([p, v]) => { if (v && v.url && v.exp - now > 2 * URL_REFRESH_MS) urlCache.set(p, v); });
  } catch { /* sessionStorage недоступен: работаем из памяти */ }
})();
let urlSaveTimer = null;
function saveUrlsSoon() {
  clearTimeout(urlSaveTimer);
  urlSaveTimer = setTimeout(() => { try { sessionStorage.setItem(URL_STORE_KEY, JSON.stringify(Object.fromEntries(urlCache))); } catch { /* не критично */ } }, 1000);
}
const hasUrl = (p) => { const c = urlCache.get(p); return !!c && c.exp - Date.now() > URL_REFRESH_MS; };
const urlKey = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
const loadedUrls = new Set();      // адреса, которые уже загружались в этой сессии (заглушка не мигает)
const markLoaded = (u) => { if (u) loadedUrls.add(urlKey(u)); };
const wasLoaded = (u) => !!u && loadedUrls.has(urlKey(u));
async function ensureUrls(paths) {
  const need = [...new Set(paths.filter(Boolean))].filter((p) => !hasUrl(p));
  if (!need.length) return;
  const chunks = [];
  for (let i = 0; i < need.length; i += 100) chunks.push(need.slice(i, i + 100));
  await runPool(chunks, 2, async (chunk) => {
    try {
      const res = await DB.signUrls(chunk, CFG.SIGNED_URL_TTL), now = Date.now();
      res.forEach((r) => {
        if (r.error || !r.signedUrl) { logE(`Нет ссылки для ${r.path}: ${r.error}`); return; }
        urlCache.set(r.path, { url: r.signedUrl, exp: now + CFG.SIGNED_URL_TTL * 1000 });
      });
    } catch (e) { logE(errMsg(e)); }
  });
  saveUrlsSoon();
}
// Привязывает картинку к пути в хранилище; при ошибке один раз обновляет ссылку
function bindImg(img, path) {
  const set = () => { const c = urlCache.get(path); if (c) img.src = c.url; };
  img.addEventListener('error', async () => {
    if (img.dataset.retry) { logE(`Картинка не загрузилась: ${path}`); return; }
    img.dataset.retry = '1';
    logI(`Ссылка устарела, обновляю: ${path}`);
    urlCache.delete(path);
    await ensureUrls([path]);
    set();
  });
  set();
}

/* ================= ДИАЛОГ ================= */
let activeDialog = null;
function openDialog({ title, body, buttons }) {
  return new Promise((resolve) => {
    const ov = $('#dialog');
    $('#dialog-title').textContent = title;
    const b = $('#dialog-body'); b.textContent = '';
    if (body) b.appendChild(body);
    const bt = $('#dialog-btns'); bt.textContent = '';
    const close = (id) => { activeDialog = null; ov.hidden = true; resolve(id); };
    let focusEl = null;
    buttons.forEach((x) => {
      const btn = el('button', 'btn ' + (x.kind || ''), x.label);
      btn.onclick = () => close(x.id);
      bt.appendChild(btn);
      if (x.focus) focusEl = btn;
    });
    activeDialog = { cancel: () => close('cancel') };
    ov.hidden = false;
    if (focusEl) focusEl.focus();
  });
}

/* ================= ВХОД ================= */
function showLogin() {
  closeModal();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#stats').textContent = '';
  $('#usage').textContent = ''; state.usedBytes = null;
}
async function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  logI('Вход выполнен');
  state.loadingImages = true; renderTabs(); renderGrid();       // первая загрузка: заглушки вместо карточек
  refreshUsage();
  try { state.folders = await DB.listFolders(); }
  catch (e) { logE(errMsg(e)); toast('Не удалось загрузить папки'); }
  try { state.tags = await DB.listTags(); }
  catch (e) { logE(errMsg(e)); toast('Не удалось загрузить теги'); }
  renderTabs();
  await loadImages();
  prefetchAll();                   // фоном: списки и превью остальных вкладок
}

/* ================= ВКЛАДКИ ================= */
function renderTabs() {
  const box = $('#tabs'); box.textContent = '';
  box.appendChild(makeTab(null, 'Не отсортированные'));
  state.folders.forEach((f) => box.appendChild(makeTab(f.id, f.name)));
  const add = el('button', 'tab-add'); add.title = 'Новая папка'; add.innerHTML = ICON_PLUS;
  add.onclick = createFolder;
  box.appendChild(add);
}
function makeTab(id, name) {
  const t = el('div', 'tab' + (id === state.activeFolder ? ' active' : ''));
  t.dataset.id = id === null ? '' : id;
  t.innerHTML = ICON_FOLDER + '<span class="tab-name"></span>';
  $('.tab-name', t).textContent = name;
  t.addEventListener('click', () => setActiveFolder(id));
  if (id !== null) {                         // «Не отсортированные»: без переименования и без крестика
    t.addEventListener('dblclick', () => startRename(id));
    const x = el('button', 'tab-close'); x.type = 'button'; x.title = 'Удалить папку'; x.innerHTML = ICON_CLOSE;
    x.addEventListener('click', (e) => { e.stopPropagation(); deleteFolder(id); });
    t.classList.add('has-close'); t.appendChild(x);
  }
  return t;
}
async function setActiveFolder(id) {
  if (id === state.activeFolder) return;
  tabCache.set(state.activeFolder, state.images.filter(belongsHere));   // запомнить список ушедшей вкладки
  const cached = tabCache.has(id);
  state.activeFolder = id;
  state.gridCount = GRID_CHUNK;
  if (cached) { state.images = tabCache.get(id).slice(); state.loadingImages = false; }   // мгновенно из кэша
  else { state.images = []; state.loadingImages = true; }
  renderTabs();
  renderGrid();
  await settleSaves();       // дописать несохранённое, чтобы перезагрузка не показала старые данные
  await loadImages({ quiet: cached });   // свежий список подтягивается фоном
}
async function createFolder() {
  try {
    const pos = state.folders.reduce((m, f) => Math.max(m, f.position), 0) + 1;
    const f = await DB.createFolder('Новая папка', pos);
    state.folders.push(f);
    logI(`Создана папка «${f.name}»`);
    setActiveFolder(f.id);   // renderTabs выполняется синхронно внутри
    startRename(f.id);
  } catch (e) { logE(errMsg(e)); toast('Не удалось создать папку'); }
}
function startRename(id) {
  const f = state.folders.find((x) => x.id === id);
  const tab = $(`#tabs .tab[data-id="${id}"]`);
  if (!f || !tab || $('input', tab)) return;
  const span = $('.tab-name', tab);
  const inp = el('input', 'tab-input');
  inp.value = f.name; inp.maxLength = 60;
  inp.style.width = Math.max(90, span.offsetWidth + 16) + 'px';
  span.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const name = inp.value.trim();
    if (save && name && name !== f.name) {
      try { await DB.renameFolder(id, name); logI(`Папка переименована: «${f.name}» → «${name}»`); f.name = name; }
      catch (e) { logE(errMsg(e)); toast('Не удалось переименовать'); }
    }
    renderTabs();
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
}

/* ================= СЕТКА ================= */
async function loadImages({ quiet = false } = {}) {
  const seq = ++state.loadSeq;
  const folder = state.activeFolder;
  if (!quiet) state.loadingImages = true;
  const t0 = performance.now();
  try {
    const rows = await DB.listImages(folder);
    const t1 = performance.now();
    const had = rows.filter((r) => hasUrl(r.preview_path)).length;
    await ensureUrls(rows.map((r) => r.preview_path));
    const t2 = performance.now();
    if (seq !== state.loadSeq) return;        // успели переключить вкладку
    state.loadFailed = false;
    logI(`⏱ Вкладка «${folderName(folder)}»${quiet ? ' (фон)' : ''}: ${rows.length} шт., список ${ms(t1 - t0)} мс, ссылки ${ms(t2 - t1)} мс (уже были ${had}/${rows.length})`);
    if (quiet && (isModalOpen() || hasUnsaved())) return;   // не затираем то, что сейчас правится
    state.images = rows;
    state.loadingImages = false;
    renderGrid();
  } catch (e) {
    if (seq !== state.loadSeq) return;
    logE(errMsg(e));
    if (quiet) return;                         // показываем кэш, фоновое обновление не удалось
    state.loadingImages = false; state.loadFailed = true;
    toast('Не удалось загрузить картинки');
    renderGrid();
  }
}
// Сетка порциями: следующая порция добавляется, когда прокрутка подходит к концу
const gridObserver = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) { state.gridCount += GRID_CHUNK; appendCards(); }
}, { rootMargin: '800px' });
function renderGrid() {
  const grid = $('#grid'); grid.textContent = '';
  gridObserver.disconnect();
  const pend = state.pending.filter((p) => p.folderId === state.activeFolder);
  pend.forEach((p) => grid.appendChild(pendingCard(p)));
  if (state.loadingImages) { for (let i = 0; i < SKELETON_COUNT; i++) grid.appendChild(skeletonCard()); }
  else if (!state.images.length && !pend.length) {
    grid.appendChild(el('div', 'empty-hint', state.loadFailed
      ? 'Не удалось загрузить картинки. Попробую ещё раз, когда появится связь'
      : 'Здесь пока пусто. Перетащи картинки или нажми Ctrl+V'));
  } else appendCards();
  updateStats();
}
function appendCards() {
  const grid = $('#grid');
  gridObserver.disconnect();
  const old = grid.querySelector('.grid-sentinel'); if (old) old.remove();
  const have = grid.querySelectorAll('.card:not(.pending)').length;
  state.images.slice(have, state.gridCount).forEach((im) => grid.appendChild(imageCard(im)));
  if (state.images.length > state.gridCount) { const sen = el('div', 'grid-sentinel'); grid.appendChild(sen); gridObserver.observe(sen); }
}
function skeletonCard() {
  const c = el('div', 'card skeleton');
  c.innerHTML = '<div class="thumb loading"></div><div class="cap sk"></div>';
  return c;
}
function imageCard(im) {
  const c = el('div', 'card'); c.dataset.id = im.id;
  c.innerHTML = `<div class="thumb"><img alt="" draggable="false"><button class="trash" title="Удалить навсегда">${ICON_TRASH}</button></div><div class="cap"></div>`;
  const img = $('img', c), thumb = $('.thumb', c);
  img.style.setProperty('--w', im.width || 235);
  img.style.setProperty('--h', im.height || 153);
  img.loading = 'lazy';
  const known = urlCache.get(im.preview_path);
  if (!(known && wasLoaded(known.url))) thumb.classList.add('loading');   // мягкая заглушка, пока превью грузится
  img.addEventListener('load', () => { thumb.classList.remove('loading'); markLoaded(img.currentSrc || img.src); });
  img.addEventListener('error', () => thumb.classList.remove('loading'));
  bindImg(img, im.preview_path);
  $('.cap', c).textContent = im.title || 'Без названия';
  c.addEventListener('click', () => openModal(im.id));
  $('.trash', c).addEventListener('click', (e) => { e.stopPropagation(); deleteImage(im.id); });
  return c;
}
function pendingCard(p) {
  const c = el('div', 'card pending' + (p.error ? ' failed' : ''));
  c.innerHTML = '<div class="thumb"><img alt=""><span class="pending-label"></span></div><div class="cap"></div>';
  const img = $('img', c);
  img.style.setProperty('--w', 99999); img.style.setProperty('--h', 99999);
  img.src = p.blobUrl;
  $('.pending-label', c).textContent = p.error ? 'Ошибка' : 'Загрузка…';
  $('.cap', c).textContent = p.name;
  return c;
}
function updateCaption(id) {
  const im = state.images.find((x) => x.id === id);
  const cap = $(`.card[data-id="${id}"] .cap`);
  if (im && cap) cap.textContent = im.title || 'Без названия';
}

/* ================= ДОБАВЛЕНИЕ КАРТИНОК ================= */
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
function mimeOf(f) {
  if (MIME_EXT[f.type]) return f.type;
  if (!f.type) {                                   // иногда браузер не указывает тип
    const m = /\.(png|jpe?g|webp)$/i.exec(f.name || '');
    if (m) { const x = m[1].toLowerCase(); return x === 'png' ? 'image/png' : x === 'webp' ? 'image/webp' : 'image/jpeg'; }
  }
  return null;
}
const titleOf = (f) => (f.name || '').replace(/\.[^.]+$/, '') || 'Без названия';
function pasteTitle() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `Скрин ${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
async function sha256(file) {
  const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function loadImg(file) {
  return new Promise((res, rej) => {
    const u = URL.createObjectURL(file), i = new Image();
    i.onload = () => { URL.revokeObjectURL(u); res(i); };
    i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('файл не открылся как картинка')); };
    i.src = u;
  });
}
async function makePreview(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { bmp = await loadImg(file); }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, CFG.PREVIEW_WIDTH / w);       // маленькие не увеличиваем
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  const blob = await new Promise((r) => c.toBlob(r, 'image/webp', CFG.PREVIEW_QUALITY));
  if (!blob) throw new Error('не удалось создать превью');
  return { width: w, height: h, preview: blob };
}
async function runPool(list, n, fn) {
  const out = new Array(list.length); let i = 0;
  const worker = async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}
function skipFile(msg) { logW(`Пропущен файл ${msg}`); toast(`Пропущен: ${msg}`); }

async function processFiles(files, source) {
  const folderId = state.activeFolder;
  const maxBytes = CFG.MAX_FILE_MB * 1024 * 1024;
  let accepted = [];
  for (const file of files) {
    const name = file.name || '(без имени)';
    const mime = mimeOf(file);
    if (!mime) { skipFile(`${name}: формат не поддерживается (нужны PNG, JPG, WebP)`); continue; }
    if (file.size > maxBytes) { skipFile(`${name}: больше ${CFG.MAX_FILE_MB} МБ (${(file.size / 1048576).toFixed(1)} МБ)`); continue; }
    accepted.push({ file, mime, title: source === 'paste' ? pasteTitle() : titleOf(file) });
  }
  if (!accepted.length) return;
  logI(`Добавление: ${accepted.length} файл(ов) в «${folderName(folderId)}»`);

  // --- хеши ---
  for (const a of accepted) {
    try { a.hash = await sha256(a.file); }
    catch (e) { a.hash = null; logE(`Хеш не посчитан для «${a.title}»: ${errMsg(e)}`); }
  }

  // --- проверка повторов по всей библиотеке и внутри пачки ---
  let found = [];
  try {
    found = await DB.findDuplicates([...new Set(accepted.map((a) => a.hash).filter(Boolean))], [...new Set(accepted.map((a) => a.title))]);
  } catch (e) { logE(errMsg(e)); toast('Проверка повторов не удалась, добавляю без неё'); }
  const norm = (s) => String(s || '').trim().toLowerCase();
  const dups = [];
  accepted.forEach((a, i) => {
    const reasons = []; let existing = null, local = null;
    const byHash = a.hash && found.find((r) => r.hash === a.hash);
    if (byHash) { existing = byHash; reasons.push('тот же файл (хеш)'); if (norm(byHash.title) === norm(a.title)) reasons.push('то же название'); }
    else { const byTitle = found.find((r) => norm(r.title) === norm(a.title)); if (byTitle) { existing = byTitle; reasons.push('то же название'); } }
    if (!existing) {
      for (let j = 0; j < i; j++) {
        const b = accepted[j];
        if (a.hash && b.hash === a.hash) { local = b; reasons.push('тот же файл (хеш), в этой же пачке'); break; }
        if (norm(b.title) === norm(a.title)) { local = b; reasons.push('то же название, в этой же пачке'); break; }
      }
    }
    if (existing || local) dups.push({ a, existing, local, reasons });
  });
  if (dups.length) {
    const choice = await dupDialog(dups, accepted.length - dups.length);
    if (choice === 'cancel') {
      const skip = new Set(dups.map((d) => d.a));
      accepted = accepted.filter((a) => !skip.has(a));
      logI(`Повторы пропущены: ${dups.length}`);
      if (!accepted.length) return;
    } else logI(`Повторы добавлены осознанно: ${dups.length}`);
  }

  // --- загрузка ---
  const base = Date.now();
  const items = accepted.map((a, i) => ({
    ...a, id: crypto.randomUUID(),
    createdAt: new Date(base + (accepted.length - 1 - i)).toISOString()   // первый файл пачки окажется первым в сетке
  }));
  items.forEach((it) => state.pending.push({ key: it.id, name: it.title, blobUrl: URL.createObjectURL(it.file), folderId, error: false }));
  state.up.total += items.length;
  updateUploadStatus();
  if (state.activeFolder === folderId) renderGrid();

  const results = await runPool(items, CFG.UPLOAD_CONCURRENCY, (it) => uploadOne(it, folderId));
  const first = results.find(Boolean);   // первая добавленная по порядку файлов
  if (first && state.activeFolder === folderId && canAdd()) openModal(first.id);
}
function removePending(key) {
  const i = state.pending.findIndex((p) => p.key === key);
  if (i >= 0) { URL.revokeObjectURL(state.pending[i].blobUrl); state.pending.splice(i, 1); }
}
async function uploadOne(it, folderId) {
  const rerender = () => { if (state.activeFolder === folderId) renderGrid(); };
  try {
    const { width, height, preview } = await makePreview(it.file);
    const row = await DB.addImage({ id: it.id, title: it.title, folder_id: folderId, created_at: it.createdAt, hash: it.hash, width, height, size: it.file.size, ext: MIME_EXT[it.mime] }, it.file, it.mime, preview);
    await ensureUrls([row.preview_path]);
    addUsage(row, 1);
    removePending(it.id);
    if (state.activeFolder === folderId) { state.images.push(row); state.images.sort(byDateDesc); }
    state.up.done++;
    logI(`Добавлено: «${row.title}» (${width}×${height}, ${Math.round(it.file.size / 1024)} КБ)`);
    rerender(); updateUploadStatus();
    return row;
  } catch (e) {
    logE(`Не удалось добавить «${it.title}»: ${errMsg(e)}`);
    toast(`Ошибка при добавлении: ${it.title}`);
    const p = state.pending.find((x) => x.key === it.id);
    if (p) p.error = true;
    state.up.failed++;
    rerender(); updateUploadStatus();
    setTimeout(() => { removePending(it.id); rerender(); }, 6000);
    return null;
  }
}
let upTimer = null;
function updateUploadStatus() {
  const u = state.up, box = $('#upload-status');
  clearTimeout(upTimer);
  if (!u.total) { box.textContent = ''; return; }
  box.textContent = `Загружено ${u.done} из ${u.total}` + (u.failed ? `, ошибок: ${u.failed}` : '');
  if (u.done + u.failed >= u.total) {
    upTimer = setTimeout(() => { if (u.done + u.failed >= u.total) { u.total = u.done = u.failed = 0; box.textContent = ''; } }, 4000);
  }
}

// Окно повторов: одно на всю пачку
async function dupDialog(dups, restCount) {
  const blobs = [];
  await ensureUrls(dups.map((d) => d.existing && d.existing.preview_path));
  const body = el('div');
  body.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  body.appendChild(el('p', '', restCount > 0
    ? `Остальные файлы (${restCount}) добавятся в любом случае. «Отмена» пропускает только повторы.`
    : 'Если нажать «Отмена», эти файлы не добавятся.'));
  dups.forEach((d) => {
    const row = el('div', 'dup-row');
    const nu = URL.createObjectURL(d.a.file); blobs.push(nu);
    const imgNew = el('img', 'dup-img'); imgNew.src = nu;
    const info = el('div', 'dup-info');
    const l1 = el('div'); l1.append('Новая: ', el('b', '', d.a.title));
    const l2 = el('div');
    if (d.existing) l2.append('Уже есть: ', el('b', '', d.existing.title || 'Без названия'), ` · вкладка «${folderName(d.existing.folder_id)}»`);
    else l2.append('Уже в пачке: ', el('b', '', d.local.title));
    info.append(l1, l2, el('div', '', 'Совпадение: ' + d.reasons.join(', ')));
    const imgOld = el('img', 'dup-img');
    if (d.existing) { const c = urlCache.get(d.existing.preview_path); if (c) imgOld.src = c.url; }
    else { const ou = URL.createObjectURL(d.local.file); blobs.push(ou); imgOld.src = ou; }
    row.append(imgNew, info, imgOld);
    body.appendChild(row);
  });
  const choice = await openDialog({
    title: `Найдены повторы: ${dups.length}`, body,
    buttons: [{ id: 'add', label: 'Всё равно добавить' }, { id: 'cancel', label: 'Отмена', focus: true }]
  });
  blobs.forEach((u) => URL.revokeObjectURL(u));
  return choice;
}

/* ================= НАДЁЖНОЕ СОХРАНЕНИЕ ================= */
// Модель «последнего желаемого значения»: на каждое поле картинки (и на каждый тег) хранится актуальное значение,
// запись идёт по очереди для своего ключа. Каждая запись знает id картинки, поэтому быстрые переключения
// не могут записать данные не в ту картинку, а повторы и гонки не откатывают новое значение старым.
const saver = { desired: new Map(), timers: new Map(), queues: new Map(), failed: new Map(), saved: new Set(), inflight: 0, retry: null };
const FIELD_LABEL = { title: 'название', comment: 'комментарий', status: 'статус', folder_id: 'папка', is_favorite: 'избранное', tag: 'тег' };
const saveKey = (id, field, tagId) => (field === 'tag' ? `${id}:tag:${tagId}` : `${id}:${field}`);

function queueSave(id, field, value, { delay = 0, tagId = null } = {}) {
  const key = saveKey(id, field, tagId);
  const im = state.images.find((x) => x.id === id);
  let d = saver.desired.get(key);
  if (!d) { d = { id, field, tagId }; saver.desired.set(key, d); }
  d.value = value; d.dirty = true; d.name = im ? (im.title || 'Без названия') : id.slice(0, 8);
  saver.saved.delete(key);
  clearTimeout(saver.timers.get(key)); saver.timers.delete(key);
  if (delay > 0) saver.timers.set(key, setTimeout(() => runKey(key), delay)); else runKey(key);
  refreshSaveUI();
}
function runKey(key) {
  clearTimeout(saver.timers.get(key)); saver.timers.delete(key);
  const p = (saver.queues.get(key) || Promise.resolve()).then(() => executeKey(key));
  saver.queues.set(key, p);
  p.then(() => { if (saver.queues.get(key) === p) saver.queues.delete(key); });
  return p;
}
function persist(d, value) {
  if (d.field === 'tag') return DB.setImageTag(d.id, d.tagId, value);
  return DB.updateImage(d.id, { [d.field]: d.field === 'title' ? String(value).trim() : value });
}
function saveLogText(d, v) {
  const n = `«${d.name}»`;
  if (d.field === 'tag') { const t = state.tags.find((x) => x.id === d.tagId); return `Тег «${t ? t.name : '?'}» ${v ? 'добавлен' : 'снят'}: ${n}`; }
  if (d.field === 'comment') return `Комментарий сохранён (${String(v).length} симв.): ${n}`;
  if (d.field === 'status') return `Статус «${statusDef(v).label}»: ${n}`;
  if (d.field === 'folder_id') return `Папка «${folderName(v)}»: ${n}`;
  if (d.field === 'is_favorite') return `Избранное ${v ? 'вкл' : 'выкл'}: ${n}`;
  return `Название сохранено: «${String(v).trim()}»`;
}
async function executeKey(key) {         // никогда не бросает: ошибки уходят в логи и в пометку интерфейса
  const d = saver.desired.get(key);
  if (!d || !d.dirty) return;
  const value = d.value; d.dirty = false;
  saver.inflight++;
  try {
    await persist(d, value);
    const wasFailed = saver.failed.delete(key);
    if (!d.dirty) { saver.desired.delete(key); saver.saved.add(key); }   // если за время записи значение сменилось, следующая запись уже в очереди
    logI(saveLogText(d, value));
    if (wasFailed) logI(`Сохранение восстановилось: ${FIELD_LABEL[d.field]}, «${d.name}»`);
  } catch (e) {
    d.dirty = true;
    const first = !saver.failed.has(key);
    saver.failed.set(key, errMsg(e));
    logE(`НЕ СОХРАНЕНО (${FIELD_LABEL[d.field]}, «${d.name}»): ${errMsg(e)}`);
    if (first) toast(`Не сохранилось: ${FIELD_LABEL[d.field]}. Попробую ещё раз`);
    scheduleRetry();
  } finally { saver.inflight--; refreshSaveUI(); }
}
function flushAll() { for (const [key, d] of saver.desired) if (d.dirty) runKey(key); }
function settleSaves() { return Promise.all([...saver.queues.values()]); }
function scheduleRetry() { if (!saver.retry) saver.retry = setTimeout(() => { saver.retry = null; flushAll(); }, 15000); }
function hasUnsaved() {
  return saver.inflight > 0 || saver.failed.size > 0 || [...saver.desired.values()].some((d) => d.dirty) || state.pending.some((p) => !p.error);
}
function dropSaves(id) {                 // картинка удалена: её правки больше не нужны
  for (const key of [...saver.desired.keys()]) {
    if (!key.startsWith(id + ':')) continue;
    clearTimeout(saver.timers.get(key)); saver.timers.delete(key);
    saver.desired.delete(key); saver.failed.delete(key); saver.saved.delete(key);
  }
}
function flushOnUnload() {               // закрытие вкладки: быстрый запрос keepalive, переживает выгрузку страницы
  for (const d of saver.desired.values()) {
    if (d.dirty && d.field !== 'tag') DB.patchImageKeepalive(d.id, { [d.field]: d.field === 'title' ? String(d.value).trim() : d.value });
  }
}
// Пометки в интерфейсе: красный контур у поля, которое не сохранилось, и индикатор у комментария
function refreshSaveUI() {
  const id = state.modalId;
  if (!id) return;
  const bad = (f) => saver.failed.has(saveKey(id, f));
  const badTag = [...saver.failed.keys()].some((k) => k.startsWith(`${id}:tag:`));
  $('#m-title').classList.toggle('save-error', bad('title'));
  $('#m-star').classList.toggle('save-error', bad('is_favorite'));
  $('#tags-field').classList.toggle('save-error', badTag);
  $('#status-select').classList.toggle('save-error', bad('status'));
  $('#folder-select').classList.toggle('save-error', bad('folder_id'));
  $('#m-comment').classList.toggle('save-error', bad('comment'));
  const k = saveKey(id, 'comment'), st = $('#comment-state');
  let text = '', err = false;
  if (saver.failed.has(k)) { text = 'Ошибка сохранения'; err = true; }
  else if (saver.desired.has(k)) text = 'Сохраняется…';
  else if (saver.saved.has(k)) text = 'Сохранено';
  st.textContent = text; st.classList.toggle('err', err);
}

/* ================= МОДАЛКА ================= */
const isModalOpen = () => !$('#modal').hidden;
const canAdd = () => !$('#app').hidden && viewMode === 'gallery' && !isModalOpen() && !activeDialog;
const curImage = () => state.images.find((x) => x.id === state.modalId);
let modalPath = null;

// Статусы. Чтобы добавить свой: новая переменная цвета в :root + строка здесь. Заливка, контур и текст считаются из цвета правилом .chip.tint в CSS.
const STATUSES = [
  { id: 'none', label: 'Без статуса', color: null },
  { id: 'success', label: 'Успех', color: 'var(--status-success)' },
  { id: 'fail', label: 'Проигрыш', color: 'var(--status-fail)' }
];
const statusDef = (id) => STATUSES.find((s) => s.id === id) || STATUSES[0];
const TRI_X = '<svg viewBox="0 0 10 10" width="7" height="7"><path d="M1 1l8 8M9 1l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 12 12" width="10" height="10"><path d="M2 6.5l2.7 2.7L10 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Картинка могла быть перенесена в другую папку: она остаётся в списке листания, пока пользователь не уйдёт с неё
const belongsHere = (im) => (im.folder_id == null ? null : im.folder_id) === state.activeFolder;
function purgeMoved(exceptId) {
  const n = state.images.length;
  state.images = state.images.filter((im) => im.id === exceptId || belongsHere(im));
  if (state.images.length !== n) renderGrid();
}

// Модалка всегда 1354×654; уменьшается целиком только если окно меньше. Зум не определяем.
function cssNum(name) { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)); }
function fitModal() {
  const W = document.documentElement.clientWidth, H = document.documentElement.clientHeight;
  const mw = cssNum('--modal-w'), mh = cssNum('--modal-h');
  const k = Math.max(0.2, Math.min(1, (W - 2 * cssNum('--arrow-space')) / mw, (H - 32) / mh));
  $('#modal-box').style.setProperty('--ms', k);
  // стрелки: посередине между краем окна и краем модалки
  $('#modal').style.setProperty('--nav-x', ((W - mw * k) / 4) + 'px');
}
// Невидимая область 944×609: картинка вписывается, центрируется, не больше 1.5× натурального
function sizeModalImage(im) {
  const w = im.width || 1, h = im.height || 1;
  const s = Math.min(cssNum('--frame-w') / w, cssNum('--frame-h') / h, 1.5);
  const box = $('#m-imgbox');
  box.style.width = Math.round(w * s) + 'px';
  box.style.height = Math.round(h * s) + 'px';
}

function openModal(id) {
  const im = state.images.find((x) => x.id === id);
  if (!im) return;
  flushAll();                      // дописать всё несохранённое по предыдущей картинке (запись знает свой id)
  closeMenu();
  state.modalId = id;
  purgeMoved(id);
  $('#modal').hidden = false;
  fitModal();
  const img = $('#m-img'), prev = $('#m-img-prev');
  img.classList.remove('ready'); img.removeAttribute('src'); delete img.dataset.retry;
  prev.removeAttribute('src');
  sizeModalImage(im);
  modalPath = im.original_path;
  saver.saved.delete(saveKey(id, 'comment'));
  fillPanel(im);
  updateNav();
  // превью уже в кэше: показываем сразу, оригинал подставляем поверх, когда догрузится
  const pc = urlCache.get(im.preview_path);
  if (pc) prev.src = pc.url;
  const t0 = performance.now(), cached = hasUrl(im.original_path);
  const showOriginal = () => {
    if (state.modalId !== id) return;
    const c = urlCache.get(im.original_path);
    if (!c) return;
    const p2 = urlCache.get(im.preview_path);
    if (p2 && !prev.getAttribute('src')) prev.src = p2.url;
    const t1 = performance.now();
    img.onload = () => {
      if (state.modalId !== id) return;
      img.classList.add('ready'); markLoaded(c.url);
      logI(`⏱ Открыто «${im.title || 'Без названия'}»: ссылка ${ms(t1 - t0)} мс${cached ? ' (из кэша)' : ''}, оригинал ${ms(performance.now() - t1)} мс`);
    };
    img.src = c.url;
  };
  if (cached) showOriginal(); else ensureUrls([im.original_path, im.preview_path]).then(showOriginal);
  // соседние картинки (предыдущая и следующая): оригиналы подписываем и догружаем заранее
  const i = state.images.findIndex((x) => x.id === id);
  const near = [state.images[i - 1], state.images[i + 1]].filter(Boolean).map((x) => x.original_path);
  ensureUrls(near).then(() => near.forEach(preloadOne));
}
function closeModal() {
  if (!isModalOpen()) return;
  flushAll(); closeMenu();
  $('#modal').hidden = true;
  state.modalId = null; modalPath = null;
  purgeMoved(null);                // перенесённые картинки исчезают из сетки этой вкладки
}
function updateNav() {
  const i = state.images.findIndex((x) => x.id === state.modalId);
  $('#nav-prev').disabled = i <= 0;
  $('#nav-next').disabled = i < 0 || i >= state.images.length - 1;
}
function step(d) {
  const i = state.images.findIndex((x) => x.id === state.modalId);
  const n = state.images[i + d];
  if (n) openModal(n.id);
}

/* ---------- правая панель ---------- */
function fillPanel(im) {
  $('#m-title').value = im.title || '';
  $('#m-star').classList.toggle('on', !!im.is_favorite);
  renderTags(im); renderStatus(im); renderFolder(im);
  $('#m-comment').value = im.comment || '';
  refreshSaveUI();
}
function chipEl(text, { color = null, sm = false, removeTag = null } = {}) {
  const c = el('span', 'chip' + (sm ? ' sm' : '') + (color ? ' tint' : ''));
  if (color) c.style.setProperty('--c', color);
  c.appendChild(el('span', 't', text));
  if (removeTag) {
    const x = el('button', 'chip-x'); x.type = 'button'; x.title = 'Снять тег'; x.innerHTML = TRI_X; x.dataset.tag = removeTag;
    c.appendChild(x);
  }
  return c;
}
function renderTags(im) {
  const f = $('#tags-field'); f.textContent = '';
  im.tag_ids.map((tid) => state.tags.find((t) => t.id === tid)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .forEach((t) => f.appendChild(chipEl(t.name, { removeTag: t.id })));
}
function renderStatus(im) {
  const st = statusDef(im.status), v = $('#status-select .sel-val'); v.textContent = '';
  if (st.color) v.appendChild(chipEl(st.label, { color: st.color }));
  else v.appendChild(el('span', 'dash', '—'));      // «без статуса» показываем прочерком
}
function renderFolder(im) {
  const v = $('#folder-select .sel-val'); v.textContent = '';
  if (im.folder_id == null) v.appendChild(el('span', 'dash', '—'));
  else v.appendChild(chipEl(folderName(im.folder_id)));
}

// Выпадающие списки: один открытый за раз; закрываются кликом снаружи и Esc
function toggleMenu(name, host, render, cls = '') {
  if (state.menu && state.menu.name === name) { closeMenu(); return; }
  closeMenu();
  const m = el('div', 'menu scrolly ' + cls);
  render(m);
  if (!m.children.length) return;           // нечего показывать (например, папок ещё нет)
  host.appendChild(m);
  host.classList.add('open');               // треугольник разворачивается вниз
  state.menu = { name, host, el: m, render };
}
function closeMenu() { if (state.menu) { state.menu.host.classList.remove('open'); state.menu.el.remove(); state.menu = null; } }
function refreshMenu() { if (state.menu) { const m = state.menu.el; m.textContent = ''; state.menu.render(m); } }
function menuItem(node, selected) {
  const b = el('button', 'menu-item' + (selected ? ' sel' : '')); b.type = 'button';
  b.appendChild(node);
  const ck = el('span', 'menu-check'); ck.innerHTML = selected ? ICON_CHECK : '';
  b.appendChild(ck);
  return b;
}
function renderTagsMenu(m) {
  const im = curImage(); if (!im) return;
  state.tags.forEach((t) => {
    const sel = im.tag_ids.includes(t.id);
    const r = menuItem(chipEl(t.name), sel);
    r.onclick = () => toggleTag(t.id);
    if (!sel) {                                // у невыбранных при наведении справа крестик удаления тега
      const ck = $('.menu-check', r);
      ck.className = 'menu-del'; ck.title = 'Удалить тег'; ck.innerHTML = TRI_X;
      ck.addEventListener('click', (e) => { e.stopPropagation(); deleteTag(t); });
    }
    m.appendChild(r);
  });
  m.appendChild(addTagRow());
}
function addTagRow() {
  const b = el('button', 'menu-item add', 'Добавить новую'); b.type = 'button';
  b.addEventListener('click', () => {
    const inp = el('input', 'menu-input'); inp.type = 'text'; inp.maxLength = 40; inp.placeholder = 'Название тега';
    b.replaceWith(inp); inp.focus();
    inp.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!inp.value.trim()) return;           // пустые теги не создаём
      await addTag(inp.value);
      refreshMenu();
    });
    inp.addEventListener('blur', () => { if (inp.isConnected) inp.replaceWith(addTagRow()); });
  });
  return b;
}
function renderStatusMenu(m) {
  const im = curImage(); if (!im) return;
  STATUSES.filter((s) => s.color).forEach((s) => {     // только реальные значения; повторный клик снимает выбор
    const on = (im.status || 'none') === s.id;
    const r = menuItem(chipEl(s.label, { color: s.color }), on);
    r.onclick = () => { setStatus(on ? 'none' : s.id); closeMenu(); };
    m.appendChild(r);
  });
}
function renderFolderMenu(m) {
  const im = curImage(); if (!im) return;
  const cur = im.folder_id == null ? null : im.folder_id;
  state.folders.forEach((f) => {                         // только существующие папки; повторный клик снимает выбор
    const on = cur === f.id;
    const r = menuItem(chipEl(f.name), on);
    r.onclick = () => { setFolder(on ? null : f.id); closeMenu(); };
    m.appendChild(r);
  });
}

// Изменения полей: сначала сразу в интерфейсе и в памяти, потом запись через saver
function onTitleInput() {
  const id = state.modalId, im = curImage(); if (!im) return;
  im.title = $('#m-title').value;
  updateCaption(id);
  queueSave(id, 'title', im.title, { delay: 600 });
}
function toggleStar() {
  const id = state.modalId, im = curImage(); if (!im) return;
  im.is_favorite = !im.is_favorite;
  $('#m-star').classList.toggle('on', im.is_favorite);
  queueSave(id, 'is_favorite', im.is_favorite);
}
function setStatus(v) {
  const id = state.modalId, im = curImage();
  if (!im || (im.status || 'none') === v) return;
  im.status = v; renderStatus(im);
  queueSave(id, 'status', v);
  updateStats();
}
function setFolder(v) {
  const id = state.modalId, im = curImage();
  if (!im || (im.folder_id == null ? null : im.folder_id) === v) return;
  im.folder_id = v; renderFolder(im);       // модалка не закрывается, картинка остаётся в списке листания
  queueSave(id, 'folder_id', v);
  updateStats();
}
function toggleTag(tagId, forceOn) {
  const id = state.modalId, im = curImage(); if (!im) return;
  const has = im.tag_ids.includes(tagId);
  const on = forceOn === undefined ? !has : forceOn;
  if (on === has) return;
  im.tag_ids = on ? [...im.tag_ids, tagId] : im.tag_ids.filter((t) => t !== tagId);
  renderTags(im); refreshMenu();
  queueSave(id, 'tag', on, { tagId });
}
const sortTags = () => state.tags.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
async function addTag(raw) {
  const id = state.modalId;                  // тег ставится на ту картинку, где его вводили, даже если окно успели переключить
  const name = String(raw).trim().replace(/\s+/g, ' ');
  if (!name) return;
  const same = (t) => t.name.toLowerCase() === name.toLowerCase();
  let tag = state.tags.find(same);
  if (!tag) {
    try { tag = await DB.createTag(name); logI(`Создан тег «${name}»`); }
    catch (e) {
      if (e.code === '23505') {              // такой уже есть (например, создан с другого устройства)
        try { state.tags = await DB.listTags(); tag = state.tags.find(same); } catch (e2) { logE(errMsg(e2)); }
      }
      if (!tag) { logE(`Тег «${name}» не создан: ${errMsg(e)}`); toast('Не удалось создать тег'); return; }
    }
    if (!state.tags.some((t) => t.id === tag.id)) { state.tags.push(tag); sortTags(); }
  }
  const im = state.images.find((x) => x.id === id);
  if (im && !im.tag_ids.includes(tag.id)) {
    im.tag_ids = [...im.tag_ids, tag.id];
    queueSave(id, 'tag', true, { tagId: tag.id });
  }
  if (state.modalId === id && im) renderTags(im);
}

// Клик по пункту списка: сам пункт к этому моменту может быть уже убран из DOM, поэтому смотрим путь события, а не e.target
const inMenu = (e) => e.composedPath().some((n) => n.classList && n.classList.contains('menu'));
function bindPanel() {
  $('#tags-host').addEventListener('click', (e) => {
    if (inMenu(e)) return;
    const x = e.target.closest('.chip-x');
    if (x) { toggleTag(x.dataset.tag, false); return; }
    toggleMenu('tags', $('#tags-host'), renderTagsMenu);
  });
  $('#status-host').addEventListener('click', (e) => { if (!inMenu(e)) toggleMenu('status', $('#status-host'), renderStatusMenu, 'match'); });
  $('#folder-host').addEventListener('click', (e) => { if (!inMenu(e)) toggleMenu('folder', $('#folder-host'), renderFolderMenu, 'match right'); });
  const c = $('#m-comment');
  c.addEventListener('input', () => {
    const id = state.modalId, im = curImage(); if (!im) return;
    im.comment = c.value;
    queueSave(id, 'comment', c.value, { delay: 1000 });
  });
  c.addEventListener('blur', flushAll);
  $('#m-title').addEventListener('blur', flushAll);
  document.addEventListener('mousedown', (e) => { if (state.menu && !state.menu.host.contains(e.target)) closeMenu(); }, true);
  // закрытие вкладки браузера: быстрая отправка несохранённого + предупреждение, если что-то не записано
  window.addEventListener('beforeunload', (e) => { flushOnUnload(); if (hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('pagehide', flushOnUnload);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll(); });
}

async function deleteImage(id) {
  const im = state.images.find((x) => x.id === id);
  if (!im) return;
  const body = el('p', '', `«${im.title || 'Без названия'}» будет удалена навсегда. Вернуть её не получится.`);
  const choice = await openDialog({
    title: 'Удалить картинку?', body,
    buttons: [{ id: 'cancel', label: 'Отмена', focus: true }, { id: 'delete', label: 'Удалить', kind: 'danger' }]
  });
  if (choice !== 'delete') return;
  closeMenu();
  const idx = state.images.findIndex((x) => x.id === id);
  try { await DB.deleteImage(im); }
  catch (e) {
    logE(errMsg(e));
    if (/файлы остались/.test(errMsg(e))) { dropSaves(id); state.images.splice(idx, 1); renderGrid(); }
    toast('Ошибка при удалении, подробности в логах');
    return;
  }
  dropSaves(id);
  addUsage(im, -1);
  state.images.splice(idx, 1);
  logI(`Удалено навсегда: «${im.title || 'Без названия'}»`);
  renderGrid();
  if (isModalOpen() && state.modalId === id) {
    const next = state.images[idx];          // следующая картинка встала на место удалённой
    if (next) openModal(next.id); else closeModal();
  }
}

/* ================= СЧЁТЧИКИ ================= */
// Для активной вкладки: всего · успех · проигрыш · процент (успех / (успех + проигрыш), «без статуса» не входят)
function updateStats() {
  const box = $('#stats');
  if (!box) return;
  if ($('#app').hidden) { box.textContent = ''; return; }
  if (state.loadingImages) { box.textContent = 'Загрузка…'; return; }
  const list = state.images.filter(belongsHere);     // перенесённые в другую папку уже не считаются
  const s = list.filter((i) => i.status === 'success').length;
  const f = list.filter((i) => i.status === 'fail').length;
  box.textContent = `${list.length} · успех ${s} · проигрыш ${f} · ${s + f ? Math.round((s / (s + f)) * 100) + '%' : '—'}`;
}

/* ================= ВКЛАДКИ: ПЕРЕТАСКИВАНИЕ ================= */
// Своё перетаскивание на pointer-событиях: с файлами из проводника (HTML5 drag с типом «Files») не пересекается вообще.
let orderChain = Promise.resolve();
let suppressTabClick = false;
function bindTabDrag() {
  const box = $('#tabs');
  // после перетаскивания гасим «хвостовой» клик, чтобы вкладка не переключалась
  box.addEventListener('click', (e) => { if (suppressTabClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const tab = e.target.closest('.tab');
    if (!tab || tab.dataset.id === '') return;                       // «Не отсортированные» неподвижна
    if (tab.querySelector('input') || e.target.closest('.tab-close')) return;   // при переименовании и на крестике не тащим
    const tabs = [...box.querySelectorAll('.tab')].filter((t) => t.dataset.id !== '');
    const rects = tabs.map((t) => t.getBoundingClientRect());
    const from = tabs.indexOf(tab);
    const gap = parseFloat(getComputedStyle(box).columnGap) || 0;
    const shift = rects[from].width + gap;
    const startX = e.clientX;
    const minDx = rects[0].left - rects[from].left;                  // левее первой папки нельзя
    const maxDx = rects[rects.length - 1].right - rects[from].right;
    let dragging = false, to = from;
    const move = (ev) => {
      const raw = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(raw) < cssNum('--drag-threshold')) return;
        dragging = true; tab.classList.add('dragging'); document.body.classList.add('dragging-tab');
      }
      const dx = Math.max(minDx, Math.min(maxDx, raw));
      tab.style.transform = `translateX(${dx}px)`;
      const center = rects[from].left + rects[from].width / 2 + dx;
      to = rects.filter((r, j) => j !== from && r.left + r.width / 2 < center).length;
      tabs.forEach((t, j) => {
        if (j === from) return;
        const s = from < to && j > from && j <= to ? -shift : from > to && j < from && j >= to ? shift : 0;
        t.style.transform = s ? `translateX(${s}px)` : '';
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('dragging-tab');
      if (!dragging) return;
      suppressTabClick = true; setTimeout(() => { suppressTabClick = false; }, 0);
      if (to !== from) reorderFolders(from, to); else renderTabs();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}
function reorderFolders(from, to) {
  const [m] = state.folders.splice(from, 1);
  state.folders.splice(to, 0, m);
  state.folders.forEach((f, i) => { f.position = i + 1; });
  renderTabs();
  logI(`Вкладка «${m.name}» перемещена: ${from + 1} → ${to + 1}`);
  const rows = state.folders.map((f) => ({ id: f.id, position: f.position }));
  orderChain = orderChain.then(() => DB.saveFolderOrder(rows)).then(() => logI('Порядок вкладок сохранён')).catch(async (e) => {
    logE(`Порядок вкладок не сохранён: ${errMsg(e)}`);
    toast('Не удалось сохранить порядок вкладок');
    try { state.folders = await DB.listFolders(); renderTabs(); } catch (e2) { logE(errMsg(e2)); }   // показываем то, что реально в базе
  });
}

/* ================= УДАЛЕНИЕ ПАПКИ ================= */
const deletingFolders = new Set();
async function deleteFolder(id) {
  const f = state.folders.find((x) => x.id === id);
  if (!f || deletingFolders.has(id)) return;
  if (state.pending.some((p) => p.folderId === id && !p.error)) { toast('В эту папку идёт загрузка. Дождись окончания'); return; }
  await settleSaves();
  let count;
  try { count = await DB.countImages(id); }
  catch (e) { logE(errMsg(e)); toast('Не удалось посчитать картинки в папке'); return; }
  const one = count % 10 === 1 && count % 100 !== 11;
  const text = count === 0
    ? `Папка «${f.name}» пустая.`
    : `В папке «${f.name}» ${count} ${plural(count, ['картинка', 'картинки', 'картинок'])}, ${one ? 'она будет удалена' : 'они будут удалены'} навсегда.`;
  const choice = await openDialog({
    title: 'Удалить папку?', body: el('p', '', text),
    buttons: [{ id: 'cancel', label: 'Отмена', focus: true }, { id: 'delete', label: 'Удалить', kind: 'danger' }]
  });
  if (choice !== 'delete') return;
  deletingFolders.add(id);
  logI(`Удаление папки «${f.name}» (картинок: ${count})…`);
  let res;
  try { res = await DB.deleteFolderWithImages(id); }
  catch (e) {
    deletingFolders.delete(id);
    logE(`Папка «${f.name}» не удалена: ${errMsg(e)}`);
    toast('Не удалось удалить папку, подробности в «Логи»');
    return;
  }
  deletingFolders.delete(id);
  res.failures.forEach((m) => logE(`Папка «${f.name}»: ${m}`));
  if (res.folderDeleted) {
    state.folders = state.folders.filter((x) => x.id !== id);
    tabCache.delete(id); refreshUsage();
    logI(`Папка «${f.name}» удалена: картинок ${res.deleted}, файлов в хранилище ${res.files}`);
    if (state.activeFolder === id) await setActiveFolder(null); else renderTabs();
  } else {
    logE(`Папка «${f.name}» удалена не полностью: картинок удалено ${res.deleted} из ${res.total}, сама папка осталась`);
    toast('Папка удалена не полностью, подробности в «Логи»');
    renderTabs();
    if (state.activeFolder === id) await loadImages();
  }
}

/* ================= УДАЛЕНИЕ ТЕГА ================= */
async function deleteTag(t) {
  await settleSaves();                       // чтобы только что поставленные теги попали в подсчёт
  let n;
  try { n = await DB.countTagUsage(t.id); }
  catch (e) { logE(errMsg(e)); toast('Не удалось проверить, где используется тег'); return; }
  if (n > 1) {
    const choice = await openDialog({
      title: 'Удалить тег?',
      body: el('p', '', `Тег «${t.name}» используется в ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'картинке' : 'картинках'}. Удалить?`),
      buttons: [{ id: 'cancel', label: 'Отмена', focus: true }, { id: 'delete', label: 'Удалить', kind: 'danger' }]
    });
    if (choice !== 'delete') return;
  }
  try { await DB.deleteTag(t.id); }
  catch (e) { logE(`Тег «${t.name}» не удалён: ${errMsg(e)}`); toast('Не удалось удалить тег'); return; }
  state.tags = state.tags.filter((x) => x.id !== t.id);
  state.images.forEach((im) => { im.tag_ids = im.tag_ids.filter((x) => x !== t.id); });
  for (const key of [...saver.desired.keys()]) {            // отложенные записи про этот тег больше не нужны
    if (!key.endsWith(`:tag:${t.id}`)) continue;
    clearTimeout(saver.timers.get(key)); saver.timers.delete(key);
    saver.desired.delete(key); saver.failed.delete(key); saver.saved.delete(key);
  }
  const cur = curImage();
  if (cur && isModalOpen()) renderTags(cur);
  refreshMenu(); refreshSaveUI();
  logI(`Тег «${t.name}» удалён (стоял на картинках: ${n})`);
}

/* ================= ФОН: ПРЕДЗАГРУЗКА, СЕТЬ, ЗАНЯТОЕ МЕСТО ================= */
const ms = (v) => Math.round(v);
const tabCache = new Map();           // списки картинок по вкладкам: переключение вкладок мгновенное
const preloaded = new Set();
function preloadOne(path) {           // скачивает картинку «вхолостую», чтобы она оказалась в кэше браузера
  const c = urlCache.get(path);
  if (!c || preloaded.has(c.url)) return Promise.resolve();
  preloaded.add(c.url);
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => { markLoaded(c.url); res(); };
    i.onerror = () => res();
    setTimeout(res, 20000);
    i.decoding = 'async';
    try { i.fetchPriority = 'low'; } catch { /* старый браузер */ }
    i.src = c.url;
  });
}
const preloadMany = (paths) => runPool(paths, PRELOAD_CONCURRENCY, preloadOne);
let prefetching = false;
async function prefetchAll() {
  if (prefetching) return;
  prefetching = true;
  const t0 = performance.now();
  try {
    const rows = await DB.listAllImages();
    const groups = new Map();
    rows.forEach((r) => { const k = r.folder_id == null ? null : r.folder_id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const keys = [null, ...state.folders.map((f) => f.id)];
    keys.forEach((k) => { if (k !== state.activeFolder && !tabCache.has(k)) tabCache.set(k, groups.get(k) || []); });
    const others = keys.filter((k) => k !== state.activeFolder).flatMap((k) => groups.get(k) || []);
    const t1 = performance.now();
    await ensureUrls(others.map((r) => r.preview_path));
    const t2 = performance.now();
    await preloadMany(others.map((r) => r.preview_path));
    const t3 = performance.now();
    await ensureUrls(rows.map((r) => r.original_path));       // оригиналы только подписываем, не качаем
    logI(`⏱ Фон: списки ${ms(t1 - t0)} мс, ссылки на превью ${ms(t2 - t1)} мс, превью скачано ${others.length} шт. за ${ms(t3 - t2)} мс, ссылки на оригиналы ${ms(performance.now() - t3)} мс`);
  } catch (e) { logE(`Фоновая подгрузка: ${errMsg(e)}`); }
  finally { prefetching = false; }
}

// Связь: неброская плашка, пропадает сама, когда связь вернулась
let netProbe = null;
function setNet(up) {
  $('#net-banner').hidden = up;
  if (up) {
    logI('Соединение восстановлено');
    clearInterval(netProbe); netProbe = null;
    flushAll();
    if (state.loadFailed) loadImages();
  } else {
    logW('Нет соединения');
    if (!netProbe) netProbe = setInterval(() => DB.ping().catch(() => {}), 5000);
  }
}

// Занятое место: оригиналы + превью (реальный размер, если записан в preview_size, иначе оценка)
const previewBytes = (r) => (r.preview_size != null ? Number(r.preview_size) : Math.round(Number(r.size || 0) * PREVIEW_RATIO));
const rowBytes = (r) => Number(r.size || 0) + previewBytes(r);
function fmtBytes(b) {
  const KB = 1024, MB = KB * 1024, GB = MB * 1024;
  if (b >= GB) return `${+(b / GB).toFixed(2)} ГБ`;
  if (b >= MB) return `${Math.round(b / MB)} МБ`;
  return `${Math.round(b / KB)} КБ`;
}
function renderUsage() {
  const box = $('#usage');
  if (state.usedBytes === null || $('#app').hidden) { box.textContent = ''; return; }
  const share = state.usedBytes / STORAGE_LIMIT_BYTES;
  box.textContent = `Занято: ${state.usedApprox ? '≈' : ''}${fmtBytes(state.usedBytes)} из ${fmtBytes(STORAGE_LIMIT_BYTES)}`;
  box.classList.toggle('warn', share > 0.8 && share < 1);
  box.classList.toggle('over', share >= 1);
}
function addUsage(r, sign) {
  if (state.usedBytes === null) return;
  state.usedBytes = Math.max(0, state.usedBytes + sign * rowBytes(r));
  if (sign > 0 && r.preview_size == null) state.usedApprox = true;
  renderUsage();
}
async function refreshUsage() {
  try {
    const rows = await DB.listUsage();
    state.usedBytes = rows.reduce((sum, r) => sum + rowBytes(r), 0);
    state.usedApprox = rows.some((r) => r.preview_size == null);
    renderUsage();
  } catch (e) { logE(`Занятое место не посчитано: ${errMsg(e)}`); }
}

/* ================= СОБЫТИЯ ================= */
function bindUI() {
  // логи
  $('#logs-toggle').onclick = () => { $('#logs').hidden = !$('#logs').hidden; };
  $('#logs-close').onclick = () => { $('#logs').hidden = true; };
  $('#logs-copy').onclick = copyLogs;
  $('#logs-all').onclick = () => setLogFilter('all');
  $('#logs-err').onclick = () => setLogFilter('err');
  $('#logs-clear').onclick = clearLogs;
  window.addEventListener('pagehide', saveLogsNow);

  // вход
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!DB.ready()) return;
    const btn = $('#login-btn'); btn.disabled = true; $('#login-error').textContent = '';
    try { await DB.signIn($('#login-email').value.trim(), $('#login-pass').value); await enterApp(); }
    catch (err) { $('#login-error').textContent = errMsg(err); logE(`Вход не удался: ${errMsg(err)}`); }
    finally { btn.disabled = false; }
  });

  // модалка
  const ov = $('#modal'); let downOnOverlay = false;
  ov.addEventListener('mousedown', (e) => { downOnOverlay = e.target === ov; });
  ov.addEventListener('click', (e) => { if (downOnOverlay && e.target === ov) closeModal(); });
  ov.addEventListener('wheel', (e) => { if (!e.target.closest('.scrolly')) e.preventDefault(); }, { passive: false });
  // блокировка браузерного зума (Ctrl+колесо, щипок на тачпаде)
  window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  $('#nav-prev').onclick = () => step(-1);
  $('#nav-next').onclick = () => step(1);
  $('#m-title').addEventListener('input', onTitleInput);
  $('#m-star').onclick = toggleStar;
  bindPanel();
  bindTabDrag();
  $('#m-trash').onclick = () => deleteImage(state.modalId);
  $('#m-img').addEventListener('error', async () => {
    const img = $('#m-img');
    if (!modalPath || !img.getAttribute('src')) return;
    if (img.dataset.retry) { logE(`Оригинал не загрузился: ${modalPath}`); return; }
    img.dataset.retry = '1';
    logI(`Ссылка устарела, обновляю: ${modalPath}`);
    urlCache.delete(modalPath);
    await ensureUrls([modalPath]);
    const c = urlCache.get(modalPath); if (c) img.src = c.url;
  });
  window.addEventListener('resize', () => { if (isModalOpen()) fitModal(); });

  // диалог: клик по затемнению = отмена
  const dl = $('#dialog');
  dl.addEventListener('click', (e) => { if (e.target === dl && activeDialog) activeDialog.cancel(); });

  // клавиши
  window.addEventListener('keydown', (e) => {
    if (activeDialog) { if (e.key === 'Escape') { e.preventDefault(); activeDialog.cancel(); } return; }
    if (viewMode !== 'gallery') return;                                  // открыт «График»: клавиши галереи не действуют
    if (state.menu) { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } return; }   // Esc: сначала список, потом модалка
    if (isModalOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !isTyping(e.target)) { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); }
      return;
    }
    if (e.key === 'F2' && !$('#app').hidden && state.activeFolder !== null && !isTyping(e.target)) { e.preventDefault(); startRename(state.activeFolder); }
  });

  // перетаскивание файлов: браузер никогда не должен открывать файл во вкладке
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!canAdd()) { logI('Перетаскивание проигнорировано (открыто окно, «График» или нет входа)'); return; }
    processFiles([...e.dataTransfer.files], 'drop');
  });
  // вставка из буфера
  window.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length || isTyping(e.target) || !canAdd()) return;
    e.preventDefault();
    processFiles(files, 'paste');
  });
}

/* ================= СТАРТ ================= */
async function boot() {
  $('#logs-title').textContent = `Логи · ${APP_VERSION}`;
  loadLogs(); renderLogs();
  bindUI();
  logI(`Запуск ${APP_VERSION}`);
  if (!DB.isConfigured()) {
    showLogin();
    $('#login-error').textContent = 'Заполни config.js: URL и публичный ключ Supabase.';
    $('#login-btn').disabled = true;
    logE('config.js не заполнен (значения «ВСТАВЬ_...»)');
    return;
  }
  if (!window.supabase) {
    showLogin();
    $('#login-error').textContent = 'Не загрузилась библиотека Supabase. Проверь интернет.';
    logE('Supabase CDN не загрузился');
    return;
  }
  const rawUrl = String(CFG.SUPABASE_URL).trim(), url = DB.supabaseUrl();
  if (rawUrl !== url) logW(`URL Supabase очищен: ${rawUrl} → ${url}`);
  logI(`Supabase: ${url}`);
  try { DB.init(); }
  catch (e) { logE(`Supabase не запустился: ${errMsg(e)}`); showLogin(); $('#login-error').textContent = errMsg(e); return; }
  DB.onSignedOut(showLogin);
  DB.onNet = setNet;
  DB.onRetry = (name, n, e) => logW(`Сбой сети, повтор ${n}/3 (${name}): ${errMsg(e)}`);
  window.addEventListener('offline', () => DB.markDown());
  window.addEventListener('online', () => DB.ping().catch(() => {}));
  try {
    const s = await DB.getSession();
    if (s) await enterApp(); else showLogin();
  } catch (e) { logE(errMsg(e)); showLogin(); }
}
boot();
