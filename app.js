/* app.js — интерфейс. С Supabase общается только через DB (storage.js). */
const APP_VERSION = 'v1.1';
const CFG = window.APP_CONFIG;
const $ = (s, r = document) => r.querySelector(s);

/* ================= ЛОГИ И УВЕДОМЛЕНИЯ ================= */
const logLines = [];
function log(level, msg) {
  const line = `[${new Date().toLocaleTimeString('ru-RU')}] [${level}] ${msg}`;
  logLines.push(line);
  const d = document.createElement('div');
  d.className = 'log-' + level;
  d.textContent = line;
  const body = $('#logs-body');
  body.appendChild(d);
  body.scrollTop = body.scrollHeight;
  (level === 'ERR' ? console.error : console.log)(line);
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
  const text = `Журнал сетапов ${APP_VERSION}\n` + logLines.join('\n');
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

const folderName = (id) => id === null || id === undefined ? 'Не отсортированные' : ((state.folders.find((f) => f.id === id) || {}).name || '?');
const isTyping = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
const byDateDesc = (a, b) => new Date(b.created_at) - new Date(a.created_at);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

/* ================= ПОДПИСАННЫЕ ССЫЛКИ ================= */
const urlCache = new Map(); // path -> { url, exp }
async function ensureUrls(paths) {
  const now = Date.now();
  const need = [...new Set(paths.filter(Boolean))].filter((p) => !urlCache.has(p) || urlCache.get(p).exp - now < 10 * 60 * 1000);
  if (!need.length) return;
  try {
    const res = await DB.signUrls(need, CFG.SIGNED_URL_TTL);
    res.forEach((r) => {
      if (r.error || !r.signedUrl) { logE(`Нет ссылки для ${r.path}: ${r.error}`); return; }
      urlCache.set(r.path, { url: r.signedUrl, exp: now + CFG.SIGNED_URL_TTL * 1000 });
    });
  } catch (e) { logE(errMsg(e)); }
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
}
async function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  logI('Вход выполнен');
  try { state.folders = await DB.listFolders(); }
  catch (e) { logE(errMsg(e)); toast('Не удалось загрузить папки'); }
  renderTabs();
  await loadImages();
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
  if (id !== null) t.addEventListener('dblclick', () => startRename(id)); // «Не отсортированные» не переименовать
  return t;
}
async function setActiveFolder(id) {
  if (id === state.activeFolder) return;
  state.activeFolder = id;
  state.images = [];
  renderTabs();
  renderGrid();
  await loadImages();
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
async function loadImages() {
  const seq = ++state.loadSeq;
  const folder = state.activeFolder;
  try {
    const rows = await DB.listImages(folder);
    await ensureUrls(rows.map((r) => r.preview_path));
    if (seq !== state.loadSeq) return;        // успели переключить вкладку
    state.images = rows;
    renderGrid();
    logI(`Вкладка «${folderName(folder)}»: ${rows.length} шт.`);
  } catch (e) {
    if (seq !== state.loadSeq) return;
    logE(errMsg(e)); toast('Не удалось загрузить картинки');
  }
}
function renderGrid() {
  const grid = $('#grid'); grid.textContent = '';
  state.pending.filter((p) => p.folderId === state.activeFolder).forEach((p) => grid.appendChild(pendingCard(p)));
  state.images.forEach((im) => grid.appendChild(imageCard(im)));
}
function imageCard(im) {
  const c = el('div', 'card'); c.dataset.id = im.id;
  c.innerHTML = `<div class="thumb"><img alt="" draggable="false"><button class="trash" title="Удалить навсегда">${ICON_TRASH}</button></div><div class="cap"></div>`;
  const img = $('img', c);
  img.style.setProperty('--w', im.width || 235);
  img.style.setProperty('--h', im.height || 153);
  img.loading = 'lazy';
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

/* ================= МОДАЛКА ================= */
const isModalOpen = () => !$('#modal').hidden;
const canAdd = () => !$('#app').hidden && !isModalOpen() && !activeDialog;
let modalPath = null;
let titleTimer = null, titleDirty = null;   // автосохранение названия

function cssNum(name) { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)); }
// Модалка всегда 1354×654; уменьшается целиком только если окно меньше. Зум не определяем.
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
async function openModal(id) {
  const im = state.images.find((x) => x.id === id);
  if (!im) return;
  await flushTitle();
  state.modalId = id;
  $('#modal').hidden = false;
  fitModal();
  const img = $('#m-img');
  img.removeAttribute('src'); delete img.dataset.retry;
  sizeModalImage(im);
  modalPath = im.original_path;
  $('#m-title').value = im.title;
  $('#m-star').classList.toggle('on', !!im.is_favorite);
  updateNav();
  await ensureUrls([im.original_path]);
  if (state.modalId === id) { const c = urlCache.get(im.original_path); if (c) img.src = c.url; }
}
function closeModal() {
  if (!isModalOpen()) return;
  flushTitle();
  $('#modal').hidden = true;
  state.modalId = null; modalPath = null;
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
function onTitleInput() {
  const im = state.images.find((x) => x.id === state.modalId);
  if (!im) return;
  im.title = $('#m-title').value;
  updateCaption(im.id);
  titleDirty = { id: im.id, value: im.title };
  clearTimeout(titleTimer);
  titleTimer = setTimeout(flushTitle, 600);
}
async function flushTitle() {
  clearTimeout(titleTimer); titleTimer = null;
  if (!titleDirty) return;
  const { id, value } = titleDirty; titleDirty = null;
  try { await DB.updateImage(id, { title: value.trim() }); logI(`Название сохранено: «${value.trim()}»`); }
  catch (e) { logE(errMsg(e)); toast('Не удалось сохранить название'); }
}
async function toggleStar() {
  const im = state.images.find((x) => x.id === state.modalId);
  if (!im) return;
  im.is_favorite = !im.is_favorite;
  $('#m-star').classList.toggle('on', im.is_favorite);
  try { await DB.updateImage(im.id, { is_favorite: im.is_favorite }); logI(`Избранное ${im.is_favorite ? 'включено' : 'выключено'}: «${im.title}»`); }
  catch (e) {
    im.is_favorite = !im.is_favorite;
    if (state.modalId === im.id) $('#m-star').classList.toggle('on', im.is_favorite);
    logE(errMsg(e)); toast('Не удалось сохранить избранное');
  }
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
  if (titleDirty && titleDirty.id === id) { clearTimeout(titleTimer); titleDirty = null; }
  const idx = state.images.findIndex((x) => x.id === id);
  try { await DB.deleteImage(im); }
  catch (e) {
    logE(errMsg(e));
    if (/файлы остались/.test(errMsg(e))) { state.images.splice(idx, 1); renderGrid(); }
    toast('Ошибка при удалении, подробности в логах');
    return;
  }
  state.images.splice(idx, 1);
  logI(`Удалено навсегда: «${im.title || 'Без названия'}»`);
  renderGrid();
  if (isModalOpen() && state.modalId === id) {
    const next = state.images[idx];          // следующая картинка встала на место удалённой
    if (next) openModal(next.id); else closeModal();
  }
}

/* ================= СОБЫТИЯ ================= */
function bindUI() {
  // логи
  $('#logs-toggle').onclick = () => { $('#logs').hidden = !$('#logs').hidden; };
  $('#logs-close').onclick = () => { $('#logs').hidden = true; };
  $('#logs-copy').onclick = copyLogs;

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
  ov.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  // блокировка браузерного зума (Ctrl+колесо, щипок на тачпаде)
  window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  $('#nav-prev').onclick = () => step(-1);
  $('#nav-next').onclick = () => step(1);
  $('#m-title').addEventListener('input', onTitleInput);
  $('#m-star').onclick = toggleStar;
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
    if (!canAdd()) { logI('Перетаскивание проигнорировано (открыто окно или нет входа)'); return; }
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
  try {
    const s = await DB.getSession();
    if (s) await enterApp(); else showLogin();
  } catch (e) { logE(errMsg(e)); showLogin(); }
}
boot();
