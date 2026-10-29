/* market.js — окно «График» (v4.0).
   Слои: [Rest + Stream + Cache] данные Binance — отдельно от [Chart] обёртки над KLineChart.
   Если уйдём на Lightweight Charts, менять нужно только секцию «ГРАФИК (KLineChart)».
   Из app.js используются: $, el, logI/logW/logE, toast, errMsg, isTyping, activeDialog, viewMode. */
(function () {
  'use strict';

  /* ================= НАСТРОЙКИ (одной строкой) ================= */
  const KLINE_VERSIONS = ['9.8.10', '9.8.9'];                      // KLineChart v9, версии закреплены; вторая — запасная
  const BAR_SPACE_MIN = 0.5;                                        // мин. ширина свечи в px (в библиотеке зашито 1); 0.5 = примерно вдвое больше свечей на экране
  const KLINE_PATHS = ['/dist/umd/klinecharts.min.js', '/dist/klinecharts.min.js'];   // у v9 путь файла проверяется по очереди
  const REST_BASE = 'https://fapi.binance.com';
  const WS_BASE = 'wss://fstream.binance.com/market/ws/';          // с 2026 свечи только на /market (старый /ws отключается)
  const TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
  const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
  const DEFAULT_SEL = { symbol: 'BTCUSDT', tf: '1m' };
  const PAGE_LIMIT = 1500;               // максимум свечей за запрос (вес 10)
  const HIST_MIN_GAP_MS = 800;           // пауза между запросами истории (защита при быстрой прокрутке)
  const MAX_BARS = 30000;                // сколько свечей максимум держим для одной пары
  const CACHE_MAX = 8;                   // сколько пар (монета+таймфрейм) помнить в кэше
  const WEIGHT_SOFT = 1800;              // из 2400/мин: выше этого сами делаем паузу (если Binance отдаёт заголовок веса)
  const BLOCK_429_S = 60, BLOCK_418_S = 120;   // пауза, если в ответе нет Retry-After
  const RECONNECT_BASE_MS = 1000, RECONNECT_MAX_MS = 30000, OFFLINE_AFTER = 4;
  const WATCHDOG_MS = 90000;             // нет сообщений дольше — переподключаемся
  const TICKER_MS = 30000;               // обновление метрик 24ч
  const SYMBOLS_TTL_MS = 12 * 3600e3;
  const PREFS_KEY = 'journal_market_v1', SYMBOLS_KEY = 'journal_market_symbols_v1';
  const RSI_PERIOD = 14;
  // --- снимок для слота «Основная» (кнопка «Построить график» в модалке) ---
  const EXPORT_W = 1600, EXPORT_H = 1032;   // итоговый файл ровно такого размера (пропорция 944:609, как рамка модалки)
  const CAP_MIN_W = 240;                    // минимальная ширина рамки-кадра на экране, px (высота по пропорции)
  const CAP_CUT_MIN = 0.05;                 // линия обрезки показывается и используется только в диапазоне 5%..90% ширины рамки
  const CAP_CUT_MAX = 0.90;                 // правее линии на картинке всегда пусто: минимум 10% справа
  const CAP_MIN_CANDLES = 5;                // в рамке левее линии должно быть не меньше стольких свечей (иначе отказ)
  const CAP_MIN_PIXELS = 30;                // и не меньше стольких «свечных» пикселей (зелёных/красных) на снимке
  const CAP_CANDLES = 1500;                 // сколько свечей грузится в режиме съёмки
  const CAP_AFTER_CANDLES = 500;            // запас данных справа от конца выбранного дня (endTime = конец дня + 500 свечей, но не позже «сейчас»)
  const CAP_FRAME_MARGIN = 0.03;            // стартовая рамка: отступ от каждой стороны панели свечей (доля)
  const CAP_START_X = 0.75;                 // последняя свеча выбранного дня стоит на 75% ширины рамки
  const HRAY = 'mktHRay';                // имя своего горизонтального луча

  /* ================= МЕЛОЧИ ================= */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mkErr = (code, msg, extra) => Object.assign(new Error(msg), { code }, extra || {});
  const L = (t) => 'График: ' + t;
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const cssNum = (n, d) => { const v = parseFloat(cssVar(n)); return Number.isFinite(v) ? v : d; };
  const msgOf = (e) => (e && e.message) ? e.message : String(e);

  /* ================= REST (Binance Futures) ================= */
  let blockedUntil = 0, usedWeight = 0;
  let onBlockChange = () => {};
  let histChain = Promise.resolve(), lastHistDone = 0;

  async function restGet(path, params, tag) {
    const wait = blockedUntil - Date.now();
    if (wait > 0) throw mkErr('BLOCKED', `Binance просил паузу, осталось ${Math.ceil(wait / 1000)} с`, { wait });
    const url = REST_BASE + path + '?' + new URLSearchParams(params);
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000);
    let res;
    try { res = await fetch(url, { cache: 'no-store', signal: ctl.signal }); }
    catch (e) { throw mkErr('NET', `Нет связи с Binance (${tag}): ${e.name === 'AbortError' ? 'таймаут 15 с' : msgOf(e)}`); }
    finally { clearTimeout(to); }
    const used = Number(res.headers.get('x-mbx-used-weight-1m'));     // заголовок может быть не виден браузеру (CORS) — тогда просто 0
    if (used) {
      usedWeight = used;
      if (used >= WEIGHT_SOFT) { blockedUntil = Date.now() + 15000; logW(L(`использовано веса ${used}/мин, пауза 15 с`)); onBlockChange(); }
    }
    if (res.status === 429 || res.status === 418) {
      const ra = Number(res.headers.get('retry-after'));
      const secs = ra > 0 ? ra : (res.status === 418 ? BLOCK_418_S : BLOCK_429_S);
      blockedUntil = Date.now() + secs * 1000;
      logE(L(`Binance ответил ${res.status} (${tag}): ${res.status === 418 ? 'IP временно забанен' : 'превышен лимит запросов'}, жду ${secs} с, запросы остановлены`));
      onBlockChange();
      throw mkErr('BLOCKED', `Binance ${res.status}: пауза ${secs} с`, { wait: secs * 1000 });
    }
    if (!res.ok) {
      let body = null; try { body = await res.json(); } catch { /* тела нет */ }
      throw mkErr('HTTP', `Binance ${res.status}${body && body.msg ? ` (код ${body.code}: ${body.msg})` : ''} — ${tag}`, { status: res.status, bcode: body && body.code });
    }
    try { return await res.json(); }
    catch (e) { throw mkErr('HTTP', `Binance вернул не JSON (${tag}): ${msgOf(e)}`); }
  }

  // История: строго по одному запросу, с паузой между ними; устаревшие запросы в очереди отбрасываются до отправки
  function historyGet(params, tag, isStale) {
    const run = async () => {
      if (isStale()) throw mkErr('STALE', 'устарело');
      const gap = HIST_MIN_GAP_MS - (Date.now() - lastHistDone);
      if (gap > 0) await sleep(gap);
      if (isStale()) throw mkErr('STALE', 'устарело');
      try { return await restGet('/fapi/v1/klines', params, tag); }
      finally { lastHistDone = Date.now(); }
    };
    const p = histChain.then(run, run);
    histChain = p.catch(() => {});
    return p;
  }

  const parseBar = (r) => ({ timestamp: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
  const decimalsOf = (s) => { const i = String(s).indexOf('.'); return i < 0 ? 0 : String(s).length - i - 1; };
  const guessPrecision = (rows) => Math.min(8, rows.slice(-50).reduce((m, r) => Math.max(m, decimalsOf(r[4]), decimalsOf(r[2]), decimalsOf(r[3])), 0));

  /* ================= СПИСОК МОНЕТ (exchangeInfo, один раз + кэш) ================= */
  let symbols = null, symbolsPromise = null;          // [{s, base, pp}]
  function readSymbolsCache() {
    try {
      const o = JSON.parse(localStorage.getItem(SYMBOLS_KEY) || 'null');
      if (o && Array.isArray(o.list) && o.list.length && Date.now() - o.t < SYMBOLS_TTL_MS) return o.list.map((a) => ({ s: a[0], base: a[1], pp: a[2] }));
    } catch { /* пусто или запрещено */ }
    return null;
  }
  function loadSymbols() {
    if (symbols) return Promise.resolve(symbols);
    if (symbolsPromise) return symbolsPromise;
    const cached = readSymbolsCache();
    if (cached) { symbols = cached; logI(L(`список монет из кэша: ${cached.length}`)); return Promise.resolve(symbols); }
    symbolsPromise = (async () => {
      try {
        const d = await restGet('/fapi/v1/exchangeInfo', {}, 'список монет');
        const list = (d.symbols || [])
          .filter((x) => x.quoteAsset === 'USDT' && x.contractType === 'PERPETUAL' && (x.status || x.contractStatus) === 'TRADING')
          .map((x) => ({ s: x.symbol, base: x.baseAsset, pp: x.pricePrecision }))
          .sort((a, b) => a.s.localeCompare(b.s));
        if (!list.length) throw mkErr('HTTP', 'exchangeInfo не содержит подходящих пар');
        symbols = list;
        try { localStorage.setItem(SYMBOLS_KEY, JSON.stringify({ t: Date.now(), list: list.map((x) => [x.s, x.base, x.pp]) })); } catch { /* не критично */ }
        logI(L(`список монет загружен: ${list.length} USDT-бессрочных`));
        return list;
      } catch (e) { logE(L(`список монет не загружен: ${msgOf(e)}`)); throw e; }
      finally { symbolsPromise = null; }
    })();
    return symbolsPromise;
  }

  /* ================= WEBSOCKET (поток свечей) ================= */
  const Stream = {
    gen: 0, ws: null, attempt: 0, timer: null, dog: null, lastMsg: 0, cfg: null,
    state: 'idle',                                        // idle | live | reconnecting | offline
    open(cfg) { this.close(); this.cfg = cfg; this.attempt = 0; this._connect(); this.dog = setInterval(() => this._watch(), 15000); },
    close() {
      this.gen++; clearTimeout(this.timer); clearInterval(this.dog); this.dog = null;
      if (this.ws) { const w = this.ws; this.ws = null; w.onopen = w.onmessage = w.onclose = w.onerror = null; try { w.close(); } catch { /* уже закрыт */ } }
      this._set('idle');
    },
    isOpen() { return !!this.ws && this.ws.readyState === 1; },
    kick() { if (this.cfg && !this.isOpen()) { clearTimeout(this.timer); this.attempt = 0; this._connect(); } },   // связь вернулась — не ждать паузу
    _set(s) { if (this.state !== s) { this.state = s; if (this.cfg && this.cfg.onState) this.cfg.onState(s); else statusHook(); } },
    _watch() {
      if (this.isOpen() && Date.now() - this.lastMsg > WATCHDOG_MS) { logW(L(`поток молчит больше ${WATCHDOG_MS / 1000} с, переподключаюсь`)); this._drop(); }
    },
    _drop() {                                             // закрыть текущее соединение и пойти по пути переподключения
      const g = this.gen;
      if (this.ws) { const w = this.ws; this.ws = null; w.onopen = w.onmessage = w.onclose = w.onerror = null; try { w.close(); } catch { /* ок */ } }
      this._retry(g);
    },
    _retry(g) {
      if (g !== this.gen) return;
      this.attempt++;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.attempt - 1)) + Math.random() * 300;
      this._set(this.attempt >= OFFLINE_AFTER || !navigator.onLine ? 'offline' : 'reconnecting');
      if (this.attempt === 1 || this.attempt % 5 === 0 || this.attempt === OFFLINE_AFTER) logW(L(`поток оборвался, попытка ${this.attempt}, повтор через ${(delay / 1000).toFixed(1)} с`));
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this._connect(), delay);
    },
    _connect() {
      const g = ++this.gen; const c = this.cfg;
      const url = WS_BASE + c.symbol.toLowerCase() + '@kline_' + c.tf;
      let ws;
      try { ws = new WebSocket(url); }
      catch (e) { logE(L(`WebSocket не создан: ${msgOf(e)}`)); this._retry(g); return; }
      this.ws = ws;
      ws.onopen = () => {
        if (g !== this.gen) return;
        const re = this.attempt > 0; this.attempt = 0; this.lastMsg = Date.now(); this._set('live');
        logI(L(`поток открыт: ${c.symbol} ${c.tf}${re ? ' (после переподключения)' : ''}`));
        c.onOpen(re);
      };
      ws.onmessage = (ev) => {
        if (g !== this.gen) return;
        this.lastMsg = Date.now();
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        const k = m && (m.k || (m.data && m.data.k));
        if (!k || k.s !== c.symbol || k.i !== c.tf) return;                // чужая монета или таймфрейм — игнор
        c.onBar({ timestamp: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
      };
      ws.onerror = () => { /* подробностей браузер не даёт; следом придёт close */ };
      ws.onclose = (ev) => {
        if (g !== this.gen) return;
        this.ws = null;
        logW(L(`поток закрыт (код ${ev.code}${ev.reason ? ', ' + ev.reason : ''})`));
        this._retry(g);
      };
    },
  };

  /* ================= ГРАФИК (KLineChart v9) — единственное место, знающее библиотеку ================= */
  const reportTimes = new Map();
  function report(where, e) {              // ошибка в коде библиотеки или в наших колбэках: текст + стек, одинаковая не чаще раза в минуту
    const msg = msgOf(e), key = where + '|' + msg, now = Date.now();
    if (now - (reportTimes.get(key) || 0) < 60000) return;
    reportTimes.set(key, now);
    const st = e && e.stack ? '\n' + String(e.stack).split('\n').slice(0, 6).join('\n') : '';
    logE(L(`ошибка (${where}): ${msg}${st}`));
  }
  const safe = (where, fn, fallback) => { try { return fn(); } catch (e) { report(where, e); return fallback; } };
  const libReady = () => !!(window.klinecharts && typeof window.klinecharts.init === 'function');

  const Chart = {
    chart: null, container: null, loadMoreHandler: null, colors: {},
    selectedId: null, hoverId: null, drawingId: null, tool: null, ids: new Map(), seq: 0, onToolChange: null,

    /* --- загрузка библиотеки --- */
    loadLib() {
      if (libReady()) return Promise.resolve();
      const urls = [];
      KLINE_VERSIONS.forEach((v) => KLINE_PATHS.forEach((p) => urls.push(`https://cdn.jsdelivr.net/npm/klinecharts@${v}${p}`)));
      return (async () => {
        for (const u of urls) {
          if ((await this._loadPatched(u)) || (await this._loadTag(u))) {
            let ver = ''; try { ver = typeof klinecharts.version === 'function' ? ' v' + klinecharts.version() : ''; } catch { /* ок */ }
            logI(L(`библиотека загружена: ${u}${ver}`)); return;
          }
          logW(L(`библиотека не загрузилась с ${u}`));
        }
        throw mkErr('LIB', 'KLineChart не загрузился ни по одному адресу. Проверь интернет');
      })();
    },
    // Предел сжатия свечи зашит в v9.8.10 как `var Ct=1,bt=50,` (мин./макс. ширина свечи) и снаружи не меняется. Скачиваем файл сами,
    // меняем число и запускаем как свой скрипт (ошибки библиотеки тогда читаемы). Порядок: точная строка → шаблон → без правки.
    async _loadPatched(u) {
      try {
        const r = await fetch(u); if (!r.ok) return false;
        let src = await r.text(), how = '';
        const exact = 'var Ct=1,bt=50,';
        const re = /(var \w+=)1(,\w+=50,\w+=function\(\)\{function \w+\(\w+\)\{this\._dateTimeFormat)/;
        if (src.includes(exact)) { src = src.replace(exact, () => `var Ct=${BAR_SPACE_MIN},bt=50,`); how = 'по точной строке'; }
        else if (re.test(src)) { src = src.replace(re, (m, p1, p2) => p1 + BAR_SPACE_MIN + p2); how = 'по шаблону'; }
        else { logW(L('предел сжатия не найден в файле библиотеки: запас отдаления не расширен')); return false; }
        const s = document.createElement('script');
        s.textContent = src + '\n//# sourceURL=klinecharts-patched.js';
        document.head.appendChild(s);
        if (!libReady()) return false;
        this.patched = how; logI(L(`предел сжатия изменён ${how}: ${BAR_SPACE_MIN} px вместо 1`)); return true;
      } catch (e) { logW(L(`загрузка с правкой не удалась (${msgOf(e)}), пробую обычным скриптом`)); return false; }
    },
    _loadTag(u) {
      return new Promise((res) => {
        const s = document.createElement('script'); s.src = u; s.crossOrigin = 'anonymous';
        s.onload = () => res(libReady()); s.onerror = () => { s.remove(); res(false); };
        document.head.appendChild(s);
      });
    },

    /* --- оформление --- */
    styles() {
      const c = cssVar, txt = c('--mod-market-axis-text'), line = c('--mod-market-axis-line');
      const axis = () => ({ axisLine: { color: line }, tickLine: { color: line }, tickText: { color: txt } });
      const cross = () => ({ line: { color: c('--mod-market-crosshair') }, text: { backgroundColor: c('--mod-market-crosshair-bg'), borderColor: c('--mod-market-crosshair-bg') } });
      return {
        grid: { horizontal: { color: c('--mod-market-grid'), size: cssNum('--mod-market-grid-w', 1), style: 'solid' }, vertical: { color: c('--mod-market-grid'), size: cssNum('--mod-market-grid-w', 1), style: 'solid' } },
        candle: {
          bar: { upColor: c('--mod-market-up'), downColor: c('--mod-market-down'), noChangeColor: c('--mod-market-neutral'),
                 upBorderColor: c('--mod-market-up'), downBorderColor: c('--mod-market-down'), noChangeBorderColor: c('--mod-market-neutral'),
                 upWickColor: c('--mod-market-up'), downWickColor: c('--mod-market-down'), noChangeWickColor: c('--mod-market-neutral') },
          priceMark: { high: { color: txt }, low: { color: txt }, last: { upColor: c('--mod-market-up'), downColor: c('--mod-market-down'), noChangeColor: c('--mod-market-neutral') } },
          tooltip: { text: { color: txt } },
        },
        indicator: { tooltip: { text: { color: txt } }, lastValueMark: { show: false } },
        xAxis: axis(), yAxis: axis(),
        separator: { color: line },
        crosshair: { horizontal: cross(), vertical: cross() },
      };
    },
    readColors() {
      this.colors = {
        level: cssVar('--mod-market-rsi-level'), rsi: cssVar('--mod-market-rsi'),
        line: cssVar('--mod-market-line'), hover: cssVar('--mod-market-line-hover'), active: cssVar('--mod-market-line-active'),
        w: cssNum('--mod-market-line-w', 1), wHover: cssNum('--mod-market-line-w-hover', 2), pointR: cssNum('--mod-market-point-r', 3),
      };
    },

    /* --- RSI: одна линия + пунктирные уровни 30/70 (рисуем сами), шкала фиксирована 0–100 --- */
    registerRsi() {
      const self = this;
      window.klinecharts.registerIndicator({
        name: 'MKT_RSI', shortName: 'RSI', calcParams: [RSI_PERIOD], precision: 2, minValue: 0, maxValue: 100,
        figures: [{ key: 'rsi', title: 'RSI: ', type: 'line' }],
        calc: (dataList, ind) => safe('расчёт RSI', () => {          // RSI по Уайлдеру (как в TradingView/Binance)
          const p = (ind.calcParams && ind.calcParams[0]) || RSI_PERIOD;
          const out = new Array(dataList.length); let ag = 0, al = 0;
          const val = () => (ag === 0 && al === 0 ? 50 : al === 0 ? 100 : 100 - 100 / (1 + ag / al));
          for (let i = 0; i < dataList.length; i++) {
            out[i] = {};
            if (i === 0) continue;
            const d = dataList[i].close - dataList[i - 1].close, g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
            if (i <= p) { ag += g; al += l; if (i === p) { ag /= p; al /= p; out[i].rsi = val(); } }
            else { ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p; out[i].rsi = val(); }
          }
          return out;
        }, dataList.map(() => ({}))),
        draw: ({ ctx, bounding, yAxis }) => {
          safe('уровни RSI', () => {
            ctx.save(); ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.strokeStyle = self.colors.level;
            [30, 70].forEach((v) => { const y = Math.round(yAxis.convertToPixel(v)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(bounding.width, y); ctx.stroke(); });
            ctx.restore();
          });
          return false;                                               // линию RSI рисует сама библиотека
        },
      });
    },

    /* --- свой горизонтальный луч: один клик, от точки вправо до края (встроенный horizontalRayLine в v9.8.10 требует две точки) --- */
    registerHRay() {
      window.klinecharts.registerOverlay({
        name: HRAY, totalStep: 2,                                       // totalStep 2 = одна точка
        needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,   // точка и цена на оси
        createPointFigures: ({ coordinates, bounding }) => {
          if (!coordinates || !coordinates.length) return [];
          const p = coordinates[0];
          return { type: 'line', attrs: { coordinates: [{ x: p.x, y: p.y }, { x: bounding.width, y: p.y }] } };
        },
      });
    },

    /* --- создание/пересоздание графика (пересоздание = шкалы снова автоматические) --- */
    create(container, loadMoreHandler) {
      this.container = container; this.loadMoreHandler = loadMoreHandler;
      this.readColors();
      try { this.registerRsi(); } catch (e) { report('регистрация RSI', e); }
      try { this.registerHRay(); } catch (e) { report('регистрация луча', e); }
      this.build();
    },
    build() {
      const k = window.klinecharts;
      if (this.chart) { safe('dispose', () => k.dispose(this.container)); this.chart = null; }
      const chart = k.init(this.container, { styles: this.styles() });
      if (!chart) throw mkErr('LIB', 'klinecharts.init вернул пустоту');
      this.chart = chart;
      this.ids.clear(); this.selectedId = this.hoverId = this.drawingId = null; this.tool = null; this._notify();
      safe('часовой пояс', () => chart.setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone));
      // minValue/maxValue здесь НЕ передавать: в v9.8.10 override записывает maxValue в minValue; они заданы в registerIndicator
      if (!this.noRsi) safe('RSI-панель', () => chart.createIndicator(
        { name: 'MKT_RSI', styles: { lines: [{ color: this.colors.rsi, size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] }] } },
        false, { height: cssNum('--mod-market-rsi-h', 140) }));
      const h = (ts) => (chart === this.chart ? this.loadMoreHandler(ts) : Promise.resolve({ list: [], more: false }));
      if (typeof chart.loadMore === 'function') chart.loadMore((ts) => { h(ts).then((r) => { if (chart === this.chart) safe('applyMoreData', () => chart.applyMoreData(r.list, r.more)); }).catch((e) => report('подгрузка влево', e)); });
      else if (typeof chart.setLoadDataCallback === 'function') chart.setLoadDataCallback(({ type, data, callback }) => { if (type === 'forward' && data) h(data.timestamp).then((r) => callback(r.list, r.more)); else callback([], true); });
      else logE(L('в этой версии KLineChart нет loadMore: подгрузка истории влево не работает'));
    },
    rebuild() { this.build(); },

    setPrecision(pp) { safe('точность цены', () => this.chart.setPriceVolumePrecision(pp, 0)); },
    setData(bars, more) { safe('данные', () => this.chart.applyNewData(bars, more)); },
    updateBar(bar) { safe('свеча', () => this.chart.updateData(bar)); },
    resize() { safe('resize', () => { if (this.chart) this.chart.resize(); }); },

    /* --- линии --- */
    _notify() { if (this.onToolChange) this.onToolChange(this.tool); },
    // Вид линии: 0 обычная, 1 под курсором, 2 выбрана (белая, та же толщина), 3 рисуется (без кружков и обводки).
    // Стили точки в v9.8.10: radius, borderSize, activeRadius, activeBorderSize и цвета (overlay.point).
    _ovStyles(level) {
      const c = this.colors, col = level === 2 ? c.active : level === 1 ? c.hover : c.line, size = level === 1 ? c.wHover : c.w;
      const r = level === 3 ? 0 : c.pointR;
      return { line: { color: col, size, style: 'solid' },
               point: { color: col, borderColor: col, borderSize: 0, radius: r, activeColor: col, activeBorderColor: col, activeBorderSize: 0, activeRadius: r } };
    },
    _paint(id) {
      if (!id || !this.ids.has(id) || !this.chart) return;
      const level = id === this.drawingId ? 3 : id === this.selectedId ? 2 : id === this.hoverId ? 1 : 0;
      safe('стиль линии', () => this.chart.overrideOverlay({ name: this.ids.get(id), id, styles: this._ovStyles(level) }));
    },
    select(id) { const prev = this.selectedId; this.selectedId = id; if (prev && prev !== id) this._paint(prev); this._paint(id); },
    _rm(id) { safe('удаление линии', () => { try { this.chart.removeOverlay({ id }); } catch { this.chart.removeOverlay(id); } }); this.ids.delete(id); if (this.selectedId === id) this.selectedId = null; if (this.hoverId === id) this.hoverId = null; },
    startTool(name) {                                                  // name: 'segment' (трендовая) | HRAY (свой горизонтальный луч)
      if (!this.chart) return;
      this.cancelDrawing();
      const id = 'mkt_' + (++this.seq), self = this;
      const who = (e) => (e && e.overlay && e.overlay.id) || id;
      this.ids.set(id, name); this.tool = name; this.drawingId = id; this._notify();
      const res = safe('создание линии', () => this.chart.createOverlay({
        name, id, styles: this._ovStyles(3),
        onDrawEnd: () => { safe('onDrawEnd', () => { self.drawingId = null; self.tool = null; self.select(id); self._notify(); }); return false; },
        onMouseEnter: (e) => { safe('onMouseEnter', () => { self.hoverId = who(e); self._paint(self.hoverId); }); return false; },
        onMouseLeave: (e) => { safe('onMouseLeave', () => { const i = who(e); if (self.hoverId === i) self.hoverId = null; self._paint(i); }); return false; },
        onSelected: (e) => { safe('onSelected', () => self.select(who(e))); return false; },
        onDeselected: (e) => { safe('onDeselected', () => { const i = who(e); if (self.selectedId === i) self.selectedId = null; self._paint(i); }); return false; },
        onRemoved: (e) => { safe('onRemoved', () => { const i = who(e); self.ids.delete(i); if (self.selectedId === i) self.selectedId = null; if (self.hoverId === i) self.hoverId = null; }); return false; },
      }), null);
      if (res === null || res === undefined) { this.ids.delete(id); this.drawingId = null; this.tool = null; this._notify(); }
    },
    cancelDrawing() { if (this.drawingId) { const id = this.drawingId; this.drawingId = null; this.tool = null; this._rm(id); this._notify(); } },
    removeSelected() { if (!this.selectedId) return false; this._rm(this.selectedId); return true; },
    clearDrawings() {                                                  // убирает оба вида линий
      if (!this.chart) return;
      [...this.ids.keys()].forEach((id) => this._rm(id));
      ['segment', HRAY].forEach((name) => safe('очистка', () => this.chart.removeOverlay({ name })));
      this.ids.clear(); this.selectedId = this.hoverId = this.drawingId = null; this.tool = null; this._notify();
    },
  };

  /* ================= СОСТОЯНИЕ И КЭШ ================= */
  let cap = null;                         // активная съёмка (MarketCapture) или null
  let sel = loadPrefs();                  // { symbol, tf }
  let sessId = 0;                         // растёт при смене монеты/таймфрейма: запоздалые ответы со старым id выбрасываются
  let entry = null;                       // кэш-запись текущей пары { bars, more, pp }
  const cache = new Map();                // 'SYMBOL|tf' → entry (LRU)
  let gapRunning = false, gapBuffer = new Map();
  let loadingOlder = false, loadTimer = null;
  let tickerTimer = null, tickerFails = 0;
  let view = null, chartReady = false, chartInit = null, active = false, streamWanted = false;

  function loadPrefs() {
    try {
      const o = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      if (o && /^[A-Z0-9_]{3,24}$/.test(o.symbol) && TFS.includes(o.tf)) return { symbol: o.symbol, tf: o.tf };
    } catch { /* ок */ }
    return { ...DEFAULT_SEL };
  }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(sel)); } catch { /* запрещено — не критично */ } }
  const keyOf = (s, t) => s + '|' + t;
  function cachePut(k, e) { cache.delete(k); cache.set(k, e); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }

  /* ================= СТАТУС ================= */
  const statusHook = () => renderStatus();
  let blockTick = null;
  onBlockChange = () => { renderStatus(); if (!blockTick) blockTick = setInterval(() => { if (Date.now() >= blockedUntil) { clearInterval(blockTick); blockTick = null; } renderStatus(); }, 1000); };
  function renderStatus() {
    const box = view && view.querySelector('#mm-status'); if (!box) return;
    let s = 'idle', t = '';
    const left = Math.ceil((blockedUntil - Date.now()) / 1000);
    if (left > 0) { s = 'wait'; t = `пауза лимита Binance, ${left} с`; }
    else if (Stream.state === 'live') { s = 'live'; t = 'идёт'; }
    else if (Stream.state === 'reconnecting') { s = 'wait'; t = 'переподключение'; }
    else if (Stream.state === 'offline') { s = 'off'; t = 'нет связи'; }
    else { s = 'idle'; t = '—'; }
    box.dataset.s = s; box.lastElementChild.textContent = t;
  }

  /* ================= СООБЩЕНИЕ ПОВЕРХ ГРАФИКА ================= */
  function showMsg(text, opt) {
    const m = view.querySelector('#mm-msg'); m.textContent = ''; m.classList.toggle('err', !!(opt && opt.err));
    m.appendChild(el('div', '', text));
    if (opt && opt.retry) { const b = el('button', '', 'Повторить'); b.type = 'button'; b.onclick = opt.retry; m.appendChild(b); }
    m.hidden = false;
  }
  const hideMsg = () => { view.querySelector('#mm-msg').hidden = true; };

  /* ================= ЗАГРУЗКА ИСТОРИИ ================= */
  const stale = (id) => () => id !== sessId;

  function applyBar(bar) {                  // единственная точка добавления/обновления свечи (кэш + график)
    if (!entry) return;
    const bars = entry.bars, last = bars[bars.length - 1];
    if (!last || bar.timestamp > last.timestamp) { bars.push(bar); Chart.updateBar(bar); }
    else if (bar.timestamp === last.timestamp) { bars[bars.length - 1] = bar; Chart.updateBar(bar); }
  }

  async function loadInitial(id) {
    const { symbol, tf } = sel; let delay = 3000;
    showMsg('Загрузка…');
    while (id === sessId && active) {
      try {
        cap && (cap.reqEnd = Math.min(cap.endMs + CAP_AFTER_CANDLES * TF_MS[tf], Date.now()));
        let rows = await historyGet(cap ? { symbol, interval: tf, endTime: cap.reqEnd, limit: CAP_CANDLES } : { symbol, interval: tf, limit: PAGE_LIMIT }, `история ${symbol} ${tf}`, stale(id));
        if (id !== sessId) return false;
        if (cap) {                                                    // режим съёмки: свечи после выбранного дня НЕ отбрасываем (день лишь говорит, куда перекинуть график)
          const after = rows.filter((r) => r[0] > cap.endMs).length;
          logI(L(`съёмка: запрошено до ${new Date(cap.reqEnd).toISOString()} (конец дня + ${CAP_AFTER_CANDLES} свечей, не позже «сейчас»): получено ${rows.length}, справа от конца дня ${after}, слева ${rows.length - after}`));
        }
        if (!rows.length) { showMsg(`Нет данных по ${symbol}`, { err: true }); logW(L(`${symbol} ${tf}: Binance вернул пустую историю`)); return false; }
        const listed = symbols && symbols.find((x) => x.s === symbol);
        entry = { bars: rows.map(parseBar), more: rows.length >= PAGE_LIMIT, pp: listed && Number.isInteger(listed.pp) ? listed.pp : guessPrecision(rows) };
        if (!cap) cachePut(keyOf(symbol, tf), entry);                // кэш живого графика режим съёмки не трогает
        Chart.setPrecision(entry.pp); Chart.setData(entry.bars, entry.more);
        hideMsg(); logI(L(`история ${symbol} ${tf}: ${entry.bars.length} свечей`));
        if (cap) MarketCapture.afterData();
        return true;
      } catch (e) {
        if (e.code === 'STALE') return false;
        if (e.code === 'HTTP' && e.status === 400) { showMsg(`Монета не найдена или недоступна: ${symbol}`, { err: true }); logE(L(msgOf(e))); return false; }
        const wait = e.code === 'BLOCKED' ? e.wait + 500 : delay;
        if (e.code !== 'BLOCKED') logE(L(`история не загрузилась: ${msgOf(e)}; повтор через ${Math.round(wait / 1000)} с`));
        showMsg(e.code === 'BLOCKED' ? 'Binance просит паузу, загрузка продолжится сама' : 'Не удалось загрузить историю, пробую снова…', { err: true });
        await sleep(wait); delay = Math.min(delay * 2, 30000);
      }
    }
    return false;
  }

  // Дозагрузка пропущенного (после обрыва, возврата на вкладку, открытия потока). Пока идёт — свечи из потока копятся и применяются потом по порядку.
  async function syncGap(id) {
    if (gapRunning || !entry || !entry.bars.length) return;
    gapRunning = true; gapBuffer = new Map();
    const { symbol, tf } = sel; let delay = 3000;
    try {
      while (id === sessId && active) {
        try {
          const last = entry.bars[entry.bars.length - 1].timestamp;
          const missing = Math.floor((Date.now() - last) / TF_MS[tf]) + 2;
          if (missing >= PAGE_LIMIT) {                                 // дыра больше одной страницы: проще начать заново
            logW(L(`пропущено около ${missing} свечей, перезагружаю историю`));
            cache.delete(keyOf(symbol, tf)); gapRunning = false;
            if (await loadInitial(id)) { gapRunning = true; }
            return;
          }
          const rows = await historyGet({ symbol, interval: tf, startTime: last, limit: Math.max(2, missing) }, `дозагрузка ${symbol} ${tf}`, stale(id));
          if (id !== sessId) return;
          rows.forEach((r) => applyBar(parseBar(r)));
          if (rows.length > 2) logI(L(`дозагружено свечей: ${rows.length}`));
          return;
        } catch (e) {
          if (e.code === 'STALE') return;
          const wait = e.code === 'BLOCKED' ? e.wait + 500 : delay;
          if (e.code !== 'BLOCKED') logE(L(`дозагрузка не удалась: ${msgOf(e)}; повтор через ${Math.round(wait / 1000)} с`));
          await sleep(wait); delay = Math.min(delay * 2, 30000);
        }
      }
    } finally {
      if (id === sessId) { const buf = [...gapBuffer.values()].sort((a, b) => a.timestamp - b.timestamp); gapBuffer = new Map(); buf.forEach(applyBar); }
      gapRunning = false;
    }
  }

  // Прокрутка влево: график просит свечи старше ts. Возвращает { list, more }.
  function onLoadMore(ts) {
    const id = sessId, e0 = entry;
    return new Promise((resolve) => {
      const done = (list, more) => { loadingOlder = false; resolve({ list, more }); };
      if (!e0 || loadingOlder) return resolve({ list: [], more: !!(e0 && e0.more) });
      if (!e0.more) return resolve({ list: [], more: false });
      if (e0.bars.length >= MAX_BARS) { logW(L(`достигнут предел ${MAX_BARS} свечей, дальше не грузим`)); e0.more = false; return resolve({ list: [], more: false }); }
      loadingOlder = true;
      clearTimeout(loadTimer);
      loadTimer = setTimeout(async () => {                         // небольшая пауза: если пользователь ещё мотает, лишний запрос не нужен
        if (id !== sessId) return done([], false);
        try {
          const rows = await historyGet({ symbol: sel.symbol, interval: sel.tf, endTime: ts - 1, limit: PAGE_LIMIT }, `старые свечи ${sel.symbol} ${sel.tf}`, stale(id));
          if (id !== sessId) return done([], false);
          const first = e0.bars[0] ? e0.bars[0].timestamp : Infinity;
          const list = rows.map(parseBar).filter((b) => b.timestamp < first);
          e0.bars = list.concat(e0.bars);
          e0.more = rows.length >= PAGE_LIMIT && list.length > 0;
          logI(L(`подгружено старых свечей: ${list.length}${e0.more ? '' : ' (это начало истории)'}`));
          done(list, e0.more);
        } catch (e) {
          if (e.code === 'STALE') return done([], false);
          logE(L(`старые свечи не загрузились: ${msgOf(e)}`));
          await sleep(e.code === 'BLOCKED' ? Math.min(e.wait, 5000) : 2000);   // пауза, чтобы график не долбил запросами подряд
          done([], true);
        }
      }, 300);
    });
  }

  /* ================= МЕТРИКИ 24ч ================= */
  const fmtUsd = (v) => (v >= 1e9 ? (v / 1e9).toFixed(1) + 'B$' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M$' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K$' : v.toFixed(0) + '$');
  async function fetchTicker() {
    const id = sessId, symbol = sel.symbol;
    if (!active || document.hidden || Date.now() < blockedUntil) return;
    try {
      const d = await restGet('/fapi/v1/ticker/24hr', { symbol }, 'метрики 24ч');
      if (id !== sessId) return;
      const p = Number(d.priceChangePercent), v = Number(d.quoteVolume);
      view.querySelector('#mm-metrics').textContent = `Объём 24ч: ${fmtUsd(v)} · Изм. 24ч: ${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
      tickerFails = 0;
    } catch (e) {
      if (id !== sessId) return;
      if (tickerFails++ === 0) logW(L(`метрики 24ч не обновились: ${msgOf(e)}`));
    }
  }
  function startTicker() { stopTicker(); tickerFails = 0; fetchTicker(); tickerTimer = setInterval(fetchTicker, TICKER_MS); }
  function stopTicker() { clearInterval(tickerTimer); tickerTimer = null; }

  /* ================= УПРАВЛЕНИЕ: смена монеты/таймфрейма, пауза/возобновление ================= */
  function connectStream() {
    const id = sessId, { symbol, tf } = sel;
    streamWanted = true;
    Stream.open({
      symbol, tf,
      onOpen: () => { if (id === sessId) syncGap(id); },           // при каждом открытии (и первом, и после обрыва) закрываем дыру
      onBar: (bar) => { if (id !== sessId) return; if (gapRunning) gapBuffer.set(bar.timestamp, bar); else applyBar(bar); },
      onState: () => renderStatus(),
    });
  }

  async function select(symbol, tf, capture) {                    // capture: режим съёмки (без потока, метрик, кэша и записи выбора в localStorage)
    sessId++; const id = sessId;
    Stream.close(); stopTicker(); clearTimeout(loadTimer);
    gapRunning = false; gapBuffer = new Map(); loadingOlder = false; entry = null;
    sel = { symbol, tf }; if (!capture) savePrefs(); syncControls();
    view.querySelector('#mm-metrics').textContent = '';
    safe('пересоздание графика', () => Chart.rebuild());           // чистые шкалы (авто) и без линий при каждой смене монеты/таймфрейма
    logI(L(`выбрано ${symbol} ${tf}`));
    const hit = capture ? null : cache.get(keyOf(symbol, tf));
    if (hit) { entry = hit; cachePut(keyOf(symbol, tf), hit); Chart.setPrecision(hit.pp); Chart.setData(hit.bars, hit.more); hideMsg(); }
    else if (!(await loadInitial(id))) { if (!capture && id === sessId && entry) { connectStream(); startTicker(); } return; }
    if (id !== sessId || capture) return;
    connectStream(); startTicker();
  }

  function pause() {                       // окно скрыто: поток и опрос не нужны, график и кэш остаются
    if (!streamWanted && !tickerTimer) return;
    Stream.close(); stopTicker(); streamWanted = false;
    logI(L('пауза: поток закрыт'));
    renderStatus();
  }
  function resume() {                      // вернулись: то же состояние, дозагрузка пропущенного, линии не трогаем
    if (!chartReady || streamWanted || cap) return;
    Chart.resize();
    if (!entry) { select(sel.symbol, sel.tf); return; }          // история так и не загрузилась — начинаем заново
    connectStream(); startTicker();
  }

  /* ================= ИНТЕРФЕЙС ================= */
  const ICON_LINE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 18L19 6"/><circle cx="5" cy="18" r="2" fill="currentColor"/><circle cx="19" cy="6" r="2" fill="currentColor"/></svg>';
  const ICON_HRAY = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h15M16 8l4 4-4 4"/><circle cx="5" cy="12" r="2" fill="currentColor"/></svg>';
  const ICON_CLEAR = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h12M8 7V4h4v3M5 7l1 13h8l1-13"/><path d="M17 12l4 4M21 12l-4 4"/></svg>';

  function buildView() {
    view = $('#mm-view');
    view.innerHTML = `
      <div class="mod-market-top">
        <div class="mod-market-sym">
          <input id="mm-sym" class="mod-market-input" type="text" spellcheck="false" autocomplete="off" aria-label="Монета">
          <div id="mm-list" class="mod-market-list" hidden></div>
        </div>
        <div id="mm-tfs" class="mod-market-tfs"></div>
        <span id="mm-status" class="mod-market-status" data-s="idle"><i class="mod-market-dot"></i><span>—</span></span>
      </div>
      <div id="mm-cap-bar" class="mod-market-cap-bar" hidden>
        <span id="mm-cap-title" class="mod-market-cap-title"></span>
        <span id="mm-cap-status" class="mod-market-cap-status"></span>
        <button type="button" id="mm-cap-save" class="mod-market-cap-btn">Сохранить</button>
        <button type="button" id="mm-cap-cancel" class="mod-market-cap-btn">Отмена</button>
      </div>
      <div class="mod-market-body">
        <div class="mod-market-tools">
          <button type="button" id="mm-tool-line" class="mod-market-tool" title="Трендовая линия (две точки)">${ICON_LINE}</button>
          <button type="button" id="mm-tool-hray" class="mod-market-tool" title="Горизонтальный луч (один клик, вправо)">${ICON_HRAY}</button>
          <button type="button" id="mm-tool-clear" class="mod-market-tool" title="Очистить всё">${ICON_CLEAR}</button>
        </div>
        <div class="mod-market-main">
          <div id="mm-metrics" class="mod-market-metrics"></div>
          <div id="mm-chartwrap" class="mod-market-chartwrap">
            <div id="mm-chart" class="mod-market-chart"></div>
            <div id="mm-cap-prev" class="mod-market-cap-prev" hidden>
              <div class="mod-market-cap-prev-label">Оригинал</div>
              <img id="mm-cap-prev-img" alt="" draggable="false">
            </div>
            <div id="mm-msg" class="mod-market-msg" hidden></div>
          </div>
        </div>
      </div>`;
    const tfs = view.querySelector('#mm-tfs');
    TFS.forEach((t) => { const b = el('button', 'mod-market-tf', t); b.type = 'button'; b.dataset.tf = t; b.onclick = () => { if (chartReady && t !== sel.tf) select(sel.symbol, t); }; tfs.appendChild(b); });
    bindSymbolSearch();
    const toolBtn = (id, name) => { view.querySelector(id).onclick = () => { if (!chartReady) return; if (Chart.tool === name) Chart.cancelDrawing(); else Chart.startTool(name); }; };
    toolBtn('#mm-tool-line', 'segment'); toolBtn('#mm-tool-hray', HRAY);
    Chart.onToolChange = (t) => { view.querySelector('#mm-tool-line').classList.toggle('active', t === 'segment'); view.querySelector('#mm-tool-hray').classList.toggle('active', t === HRAY); };
    view.querySelector('#mm-tool-clear').onclick = () => { if (chartReady) { Chart.clearDrawings(); logI(L('линии очищены (все виды)')); } };
    // колесо над графиком масштабирует график; страницу и браузерный зум оно не трогает
    view.querySelector('#mm-chartwrap').addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    syncControls();
  }
  function deleteSelectedLine() { if (Chart.removeSelected()) logI(L('линия удалена')); else toast('Сначала выбери линию кликом'); }
  function syncControls() {
    if (!view) return;
    view.querySelector('#mm-sym').value = sel.symbol;
    view.querySelectorAll('.mod-market-tf').forEach((b) => b.classList.toggle('active', b.dataset.tf === sel.tf));
  }

  /* --- поиск монеты --- */
  let listItems = [], listActive = 0;
  function bindSymbolSearch() {
    const inp = view.querySelector('#mm-sym'), box = view.querySelector('#mm-list');
    const close = () => { box.hidden = true; };
    const choose = (s) => { close(); inp.blur(); if (s !== sel.symbol && chartReady) select(s, sel.tf); else syncControls(); };
    const paint = () => {
      box.textContent = '';
      if (!symbols) {
        const n = el('div', 'mod-market-note', symbolsPromise ? 'Загрузка списка монет…' : 'Список монет не загружен');
        if (!symbolsPromise) { const b = el('button', '', 'Повторить'); b.type = 'button'; b.onmousedown = (e) => { e.preventDefault(); loadSymbols().then(() => { filter(); }, () => { paint(); }); paint(); }; n.appendChild(b); }
        box.appendChild(n); box.hidden = false; return;
      }
      if (!listItems.length) { box.appendChild(el('div', 'mod-market-note', 'Ничего не найдено')); box.hidden = false; return; }
      listItems.forEach((x, i) => {
        const r = el('div', 'mod-market-item' + (i === listActive ? ' active' : ''));
        r.appendChild(el('span', '', x.s)); r.appendChild(el('small', '', x.base));
        r.onmousedown = (e) => { e.preventDefault(); choose(x.s); };
        r.onmousemove = () => { if (listActive !== i) { listActive = i; box.querySelectorAll('.mod-market-item').forEach((n, j) => n.classList.toggle('active', j === i)); } };
        box.appendChild(r);
      });
      box.hidden = false;
    };
    const filter = () => {
      const q = inp.value.trim().toUpperCase(); listActive = 0;
      if (symbols) {
        const m = symbols.filter((x) => !q || x.s.includes(q) || x.base.toUpperCase().includes(q));
        m.sort((a, b) => (b.s.startsWith(q) - a.s.startsWith(q)) || (a.s.indexOf(q) - b.s.indexOf(q)) || a.s.localeCompare(b.s));
        listItems = m.slice(0, 100);
      }
      paint();
    };
    inp.addEventListener('focus', () => { if (cap) { inp.blur(); return; } inp.select(); if (!symbols) loadSymbols().then(filter, paint); filter(); });
    inp.addEventListener('input', filter);
    inp.addEventListener('blur', () => { close(); syncControls(); });
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (box.hidden) filter();
        if (!listItems.length) return;
        listActive = (listActive + (e.key === 'ArrowDown' ? 1 : -1) + listItems.length) % listItems.length;
        paint(); const a = box.querySelector('.mod-market-item.active'); if (a) a.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (symbols && listItems.length) choose(listItems[listActive].s);
        else { const v = inp.value.trim().toUpperCase(); if (!symbols && /^[A-Z0-9]{2,20}USDT$/.test(v)) choose(v); }   // список не загрузился: берём введённый тикер как есть
      } else if (e.key === 'Escape') { e.preventDefault(); close(); inp.blur(); }
    });
  }

  /* ================= ПЕРЕКЛЮЧАТЕЛЬ ОКОН ================= */
  let galleryScroll = 0;
  function setView(mode) {
    if (mode === viewMode) return;
    const g = $('#view-gallery');
    if (mode === 'market') {
      galleryScroll = window.scrollY;
      g.hidden = true; view.hidden = false; document.body.classList.add('mod-market-on');
      viewMode = 'market'; active = true;
      window.scrollTo(0, 0);
      openChart();
    } else {
      if (cap) MarketCapture.cancel('выход через «Формации»', true);
      active = false; pause();
      view.hidden = true; g.hidden = false; document.body.classList.remove('mod-market-on');
      viewMode = 'gallery';
      window.scrollTo(0, galleryScroll);                           // галерея стоит там, где её оставили
    }
    $('#mm-tab-gallery').classList.toggle('active', mode === 'gallery');
    $('#mm-tab-market').classList.toggle('active', mode === 'market');
  }

  // Первое открытие: грузим библиотеку, создаём график, выбираем сохранённую монету. Дальше только resume().
  function openChart() {
    if (chartReady) { requestAnimationFrame(() => { Chart.resize(); if (cap) MarketCapture.load(); else resume(); }); return; }
    if (chartInit) return;
    showMsg('Загрузка графика…');
    chartInit = (async () => {
      try {
        await Chart.loadLib();
        await new Promise((r) => requestAnimationFrame(r));          // дать окну получить размер
        Chart.create($('#mm-chart'), onLoadMore);
        chartReady = true;
        new ResizeObserver(() => Chart.resize()).observe($('#mm-chartwrap'));
        logI(L('создан'));
        loadSymbols().catch(() => {});                              // список монет подгружаем фоном
        if (cap) await MarketCapture.load(); else await select(sel.symbol, sel.tf);
      } catch (e) {
        logE(L(`не запустился: ${msgOf(e)}`));
        showMsg('График не запустился: ' + msgOf(e), { err: true, retry: () => { chartInit = null; openChart(); } });
        chartInit = null; chartReady = false; Chart.chart = null;
      }
    })();
  }

  /* ================= СОБЫТИЯ ================= */
  function bind() {
    $('#mm-tab-gallery').onclick = () => setView('gallery');
    $('#mm-tab-market').onclick = () => setView('market');
    const nav = $('#topnav'), syncNav = () => { nav.hidden = $('#app').hidden; };      // верхняя панель показывается вместе с #app (вне экрана входа)
    syncNav(); new MutationObserver(syncNav).observe($('#app'), { attributes: true, attributeFilter: ['hidden'] });
    // вышли из аккаунта (#app скрыт) — отпустить поток; вернулись — продолжить
    new MutationObserver(() => {
      if (viewMode !== 'market') return;
      if ($('#app').hidden) pause(); else if (active) resume();
    }).observe($('#app'), { attributes: true, attributeFilter: ['hidden'] });
    window.addEventListener('online', () => { if (viewMode === 'market') Stream.kick(); });
    window.addEventListener('offline', () => { if (viewMode === 'market' && streamWanted) { Stream.state = 'offline'; renderStatus(); logW(L('браузер сообщает: нет сети')); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && viewMode === 'market' && streamWanted) { Stream.kick(); fetchTicker(); } });
    // ошибки из кода библиотеки: показать стек (app.js пишет только короткую строку)
    window.addEventListener('error', (ev) => {
      if (!chartReady && !chartInit) return;
      const st = ev.error && ev.error.stack ? String(ev.error.stack) : '';
      if (!(/klinecharts|market\.js/.test(st + ' ' + (ev.filename || '')) || ev.message === 'Script error.')) return;
      report('окно', Object.assign(new Error(`${ev.message} (${ev.filename || 'без адреса'}:${ev.lineno || 0})`), { stack: st }));
    });
    window.addEventListener('keydown', (e) => {
      if (viewMode !== 'market' || !chartReady) return;
      try { if (activeDialog) return; } catch { /* нет диалога */ }
      if (isTyping(e.target)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelectedLine(); }
      else if (e.key === 'Escape' && Chart.drawingId) { e.preventDefault(); Chart.cancelDrawing(); }
      else if (e.key === 'Enter' && MarketCapture.isActive() && !e.target.closest('button')) { e.preventDefault(); MarketCapture.toggleCut(); }   // «обрезка» в режиме съёмки
    });
  }


  /* ================= РЕЖИМ СЪЁМКИ: ручной кадр для слота «Основная» (MarketCapture) =================
     Окно «График» работает как обычно, но без потока и метрик, с монетой и ТФ из записи (заблокированы) и 1500 свечей вокруг выбранного дня (до +500 свечей справа от конца дня).
     Поверх графика рамка-кадр с пропорцией EXPORT_W:EXPORT_H; «Сохранить» вырезает область рамки из снимка библиотеки. */
  const MarketCapture = (() => {
    const S = (t) => 'Съёмка: ' + t;
    const RATIO = EXPORT_W / EXPORT_H;
    const kyiv = (ms) => new Date(ms).toLocaleString('ru-RU', { timeZone: 'Europe/Kyiv', hour12: false });
    const utc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const both = (ms) => `${utc(ms)} (Киев ${kyiv(ms)})`;
    const frames = (n) => new Promise((r) => { const f = (i) => (i <= 0 ? r() : requestAnimationFrame(() => f(i - 1))); f(n); });
    const loadImage = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('снимок графика не открылся как картинка')); i.src = url; });
    let frame = null, drag = null, layer = null, frameEl = null, dims = [];
    let cutRatio = 0.75, cutOn = false, cutDim = null, cutLine = null, cutDown = null;   // линия обрезки: доля ширины рамки, без привязки к свечам и времени; cutOn: «обрезано» (правее линии фон закрыт полностью)
    const el$ = (id) => view.querySelector(id);
    const chartBox = () => el$('#mm-chart');
    // Границы кадра: только основная панель свечей (без шкал и RSI): левый верхний угол контейнера, размер из getSize
    const bounds = () => { const m = Chart.chart ? safe('getSize', () => Chart.chart.getSize('candle_pane', 'main'), null) : null; return m && m.width > 0 && m.height > 0 ? { w: m.width, h: m.height } : { w: chartBox().clientWidth, h: chartBox().clientHeight }; };
    const clampFrame = () => {
      if (!frame) return;
      const B = bounds();
      frame.w = Math.min(Math.max(frame.w, Math.min(CAP_MIN_W, B.w)), B.w, B.h * RATIO);
      frame.h = frame.w / RATIO;
      frame.x = Math.min(Math.max(frame.x, 0), B.w - frame.w);
      frame.y = Math.min(Math.max(frame.y, 0), B.h - frame.h);
    };
    function paint() {
      if (!layer) return;
      layer.hidden = !frame;
      if (!frame) return;
      const W = chartBox().clientWidth, H = chartBox().clientHeight, f = frame;
      frameEl.style.cssText = `left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px;`;
      const set = (d, l, t, w, h) => { d.style.cssText = `left:${l}px;top:${t}px;width:${Math.max(0, w)}px;height:${Math.max(0, h)}px;`; };
      set(dims[0], 0, 0, W, f.y); set(dims[1], 0, f.y + f.h, W, H - f.y - f.h); set(dims[2], 0, f.y, f.x, f.h); set(dims[3], f.x + f.w, f.y, W - f.x - f.w, f.h);
      updateCut();
    }
    // Линия и затемнение: только из доли ширины рамки (график под ними двигается, линия стоит на месте)
    function updateCut() {
      if (!frame || !cutLine) return;
      const cx = cutRatio * frame.w - 1, inner = frame.w - 2;              // координаты внутри рамки (минус её граница 1 px)
      cutLine.style.left = `${cx}px`; cutDim.style.left = `${cx}px`; cutDim.style.width = `${Math.max(0, inner - cx)}px`;
      cutDim.classList.toggle('on', cutOn);
    }
    function toggleCut() {                                                 // Enter или двойной клик по линии: «обрезано» (фон непрозрачно) ↔ затемнение
      if (!cap || !frame) return;
      cutOn = !cutOn; updateCut();
      logI(S(`обрезка ${cutOn ? 'включена' : 'выключена'} (линия ${(cutRatio * 100).toFixed(1)}% рамки)`));
    }
    const setStatus = (t, err) => { const e = el$('#mm-cap-status'); if (e) { e.textContent = t || ''; e.classList.toggle('err', !!err); } };
    const lockUi = (on) => {
      view.classList.toggle('mod-market-cap-on', on);
      el$('#mm-cap-bar').hidden = !on;
      el$('#mm-sym').readOnly = on;
      view.querySelectorAll('.mod-market-tf').forEach((b) => { b.disabled = on; });
      if (on) { el$('#mm-metrics').textContent = ''; } else hidePrev();
    };
    function initDom() {
      const wrap = el$('#mm-chartwrap');
      layer = document.createElement('div'); layer.className = 'mod-market-cap-layer'; layer.hidden = true;
      dims = [0, 1, 2, 3].map(() => { const d = document.createElement('div'); d.className = 'mod-market-cap-dim'; layer.appendChild(d); return d; });
      frameEl = document.createElement('div'); frameEl.className = 'mod-market-cap-frame';
      ['top', 'bottom', 'left', 'right'].forEach((e) => { const d = document.createElement('div'); d.className = 'mod-market-cap-edge'; d.dataset.edge = e; frameEl.appendChild(d); });
      ['nw', 'ne', 'sw', 'se'].forEach((c) => { const d = document.createElement('div'); d.className = 'mod-market-cap-h'; d.dataset.corner = c; frameEl.appendChild(d); });
      cutDim = document.createElement('div'); cutDim.className = 'mod-market-cap-cutdim'; frameEl.appendChild(cutDim);
      cutLine = document.createElement('div'); cutLine.className = 'mod-market-cap-cut';
      cutLine.innerHTML = '<i class="mod-market-cap-cut-line"></i>'; frameEl.appendChild(cutLine);
      layer.appendChild(frameEl); wrap.appendChild(layer);
      cutLine.addEventListener('pointerdown', (e) => {                    // линия обрезки: двигается свободно по горизонтали в обе стороны
        if (!frame || e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        cutDown = { sx: e.clientX, moved: false };
        try { cutLine.setPointerCapture(e.pointerId); } catch { /* ок */ }
      });
      cutLine.addEventListener('pointermove', (e) => {
        if (!cutDown || !frame) return;
        if (!cutDown.moved) {                                              // перетаскиванием считается сдвиг больше 3 px (иначе двойной клик снимал бы обрезку сам)
          if (Math.abs(e.clientX - cutDown.sx) <= 3) return;
          cutDown.moved = true;
          if (cutOn) { cutOn = false; logI(S('обрезка выключена (начато перетаскивание линии)')); }
        }
        const rc = layer.getBoundingClientRect();
        cutRatio = Math.min(Math.max((e.clientX - rc.left - frame.x) / frame.w, CAP_CUT_MIN), CAP_CUT_MAX);   // зажим 5%..90% только при перетаскивании
        updateCut();
      });
      const cutEnd = () => { if (!cutDown) return; const mv = cutDown.moved; cutDown = null; if (mv && frame) logI(S(`линия обрезки: ${(cutRatio * 100).toFixed(1)}% ширины рамки (x=${(frame.x + cutRatio * frame.w).toFixed(1)})`)); };
      cutLine.addEventListener('pointerup', cutEnd); cutLine.addEventListener('pointercancel', cutEnd);
      cutLine.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); toggleCut(); });
      frameEl.addEventListener('pointerdown', (e) => {                    // ловим только границу и ручки; внутри рамки события идут к графику
        const h = e.target.closest('[data-corner]'), ed = e.target.closest('[data-edge]');
        if ((!h && !ed) || !frame || e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        drag = { mode: h ? h.dataset.corner : 'move', sx: e.clientX, sy: e.clientY, f: { ...frame } };
        try { e.target.setPointerCapture(e.pointerId); } catch { /* ок */ }
      });
      frameEl.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const B = bounds(), f0 = drag.f, dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (drag.mode === 'move') { frame = { ...f0, x: f0.x + dx, y: f0.y + dy }; }
        else {                                                             // масштаб за угол с сохранением пропорции; противоположный угол стоит на месте
          const sx = drag.mode.includes('e') ? 1 : -1, sy = drag.mode.includes('s') ? 1 : -1;
          const ax = sx > 0 ? f0.x : f0.x + f0.w, ay = sy > 0 ? f0.y : f0.y + f0.h;
          const px = (sx > 0 ? f0.x + f0.w : f0.x) + dx, py = (sy > 0 ? f0.y + f0.h : f0.y) + dy;
          const maxW = Math.min(sx > 0 ? B.w - ax : ax, (sy > 0 ? B.h - ay : ay) * RATIO);
          const w = Math.min(Math.max(Math.max(Math.abs(px - ax), Math.abs(py - ay) * RATIO), Math.min(CAP_MIN_W, maxW)), maxW), h = w / RATIO;
          frame = { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
        }
        clampFrame(); paint();
      });
      const end = () => { drag = null; };
      frameEl.addEventListener('pointerup', end); frameEl.addEventListener('pointercancel', end);
      new ResizeObserver(() => { clampFrame(); paint(); positionPrev(); }).observe(wrap);   // окно изменилось: рамка остаётся в границах, доля линии сохраняется
      el$('#mm-cap-save').onclick = () => save();
      el$('#mm-cap-cancel').onclick = () => cancel('кнопка «Отмена»');
    }
    // «Свечные» пиксели (зелёные/красные) на снимке: независимая проверка, что свечи действительно нарисованы в кадре (convertToPixel отдаёт x и для свечей за экраном)
    const isCandlePx = (r, g, b) => (g - r >= 30 && g >= b) || (r - g >= 40 && r - b >= 40);
    const countCandlePx = (d) => { let c = 0; for (let i = 0; i < d.data.length; i += 4) if (isCandlePx(d.data[i], d.data[i + 1], d.data[i + 2])) c++; return c; };
    async function withCleanChart(fn) {                                  // без подсказки, перекрестия и метки последней цены (она цветная и сбивала бы подсчёт)
      const chart = Chart.chart;
      safe('скрыть подсказки', () => chart.setStyles({ candle: { tooltip: { showRule: 'none' }, priceMark: { last: { show: false } } }, crosshair: { show: false } }));
      try { await frames(2); await sleep(80); return await fn(); }
      finally { safe('вернуть подсказки', () => chart.setStyles({ candle: { tooltip: { showRule: 'always' }, priceMark: { last: { show: true } } }, crosshair: { show: true } })); }
    }
    async function candlePixels(f) {                                     // число свечных пикселей в области рамки; null, если снимок не получился
      return withCleanChart(async () => {
        const url = safe('getConvertPictureUrl (проверка)', () => Chart.chart.getConvertPictureUrl(false, 'png', cssVar('--mod-market-bg') || '#0B0B0B'), null);
        if (!url || typeof url !== 'string') return null;
        try {
          const img = await loadImage(url), box = chartBox(), sx = img.naturalWidth / box.clientWidth, sy = img.naturalHeight / box.clientHeight;
          const w = Math.max(1, Math.min(1000, Math.round(f.w))), h = Math.max(1, Math.round(w * f.h / f.w));
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, f.x * sx, f.y * sy, f.w * sx, f.h * sy, 0, 0, w, h);
          return countCandlePx(ctx.getImageData(0, 0, w, h));
        } catch (e) { logW(S(`проверка пикселей не удалась: ${msgOf(e)}`)); return null; }
      });
    }
    // Начальное положение (v5.8): график должен быть ВИДЕН. Рамка максимально крупная (CAP_FRAME_MARGIN), последняя свеча выбранного дня на CAP_START_X ширины рамки (важнее видимость, чем точные 75%).
    // Каждая попытка проверяется по факту: x свечи дня в рамке, число свечей в рамке (по x каждой свечи) и свечные пиксели на снимке.
    async function afterData() {
      if (!cap || !Chart.chart || !entry || !entry.bars.length) return;
      const id = sessId, chart = Chart.chart, bars = entry.bars;
      safe('resize', () => Chart.resize());
      await frames(2);
      let B = bounds();
      safe('отступ справа', () => { if (typeof chart.setMaxOffsetRightDistance === 'function') chart.setMaxOffsetRightDistance(B.w); chart.setOffsetRightDistance(0.25 * B.w); });   // справа пустой запас
      await frames(2); await sleep(120);
      if (!cap || id !== sessId) return;
      B = bounds();
      const w = Math.min(B.w * (1 - 2 * CAP_FRAME_MARGIN), B.h * (1 - 2 * CAP_FRAME_MARGIN) * RATIO), h = w / RATIO;
      frame = { x: (B.w - w) / 2, y: (B.h - h) / 2, w, h };
      clampFrame(); paint(); positionPrev();
      let di = -1; for (let i = bars.length - 1; i >= 0; i--) if (bars[i].timestamp <= cap.endMs) { di = i; break; }
      if (di < 0) { setStatus('Нет свечей до конца выбранного дня', true); logW(S(`в загруженных данных нет свечей с открытием ≤ ${both(cap.endMs)}`)); return; }
      const dayTs = bars[di].timestamp, tfms = TF_MS[cap.timeframe];
      const has = (m) => typeof chart[m] === 'function';
      logI(S(`позиционирование: свечей загружено ${bars.length}, индекс свечи дня ${di} (${both(dayTs)}), закрытие ${both(dayTs + tfms)}${dayTs + tfms > Date.now() ? ' (свеча ещё не закрыта)' : ''}; справа от неё ${bars.length - 1 - di}; панель свечей ${Math.round(B.w)}×${Math.round(B.h)}, рамка ${Math.round(frame.w)}×${Math.round(frame.h)} в (${Math.round(frame.x)}, ${Math.round(frame.y)})`));
      logI(S(`методы библиотеки: scrollToTimestamp ${has('scrollToTimestamp')}, scrollByDistance ${has('scrollByDistance')}, scrollToDataIndex ${has('scrollToDataIndex')}, scrollToRealTime ${has('scrollToRealTime')}, getVisibleRange ${has('getVisibleRange')}`));
      const list0 = () => safe('getDataList', () => chart.getDataList(), []);
      const px = (ts) => safe('x свечи', () => chart.convertToPixel({ timestamp: ts }, { paneId: 'candle_pane' }).x, NaN);
      const stepNow = () => { const l = list0(), n = l.length; return n >= 2 ? px(l[n - 1].timestamp) - px(l[n - 2].timestamp) : NaN; };
      const target = () => frame.x + CAP_START_X * frame.w;
      const f2 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '?');
      // проверка по факту: x свечи дня, сколько свечей реально в рамке и в панели, свечные пиксели
      async function inspect(label) {
        if (!cap || id !== sessId) return { ok: false, stop: true };
        const list = list0(), f = frame, P = bounds();
        const xDay = px(dayTs);
        let inFrame = 0, inPane = 0;
        for (const b of list) { const x = px(b.timestamp); if (x >= f.x && x <= f.x + f.w) inFrame++; if (x >= 0 && x <= P.w) inPane++; }
        const pix = await candlePixels(f);
        const vr = has('getVisibleRange') ? safe('getVisibleRange', () => chart.getVisibleRange(), null) : null;
        const dayIn = Number.isFinite(xDay) && xDay >= f.x + 2 && xDay <= f.x + f.w - 2;
        const ok = dayIn && inFrame >= CAP_MIN_CANDLES && (pix === null || pix >= CAP_MIN_PIXELS);
        logI(S(`проверка (${label}): x свечи дня ${f2(xDay)} (рамка ${f2(f.x)}..${f2(f.x + f.w)}), свечей в рамке ${inFrame}, в панели ${inPane} из ${list.length}, шаг ${f2(stepNow())} px, свечных пикселей ${pix === null ? 'нет снимка' : pix}${vr ? `, getVisibleRange ${JSON.stringify(vr)}` : ''} → ${ok ? 'ВИДНО' : 'НЕ видно'}`));
        return { ok, xDay, inFrame, pix };
      }
      async function refine() {                                           // подгонка scrollByDistance; знак определяется по факту сдвига
        let sign = 1, x = px(dayTs);
        for (let it = 1; it <= 3 && Number.isFinite(x); it++) {
          const err = target() - x;
          if (!(Math.abs(err) > 1)) break;
          if (!has('scrollByDistance')) { logW(S('scrollByDistance недоступен, точная подгонка невозможна')); break; }
          safe('scrollByDistance', () => chart.scrollByDistance(err * sign, 0));
          await frames(3);
          const x2 = px(dayTs), moved = x2 - x;
          if (Math.abs(moved) > 0.5 && moved * err < 0) sign = -sign;
          logI(S(`подгонка ${it}: нужно ${f2(err)} px, сдвинуло ${f2(moved)} px, x=${f2(x2)}`));
          x = x2;
        }
      }
      const idxNow = () => { const l = list0(); let lo = 0, hi = l.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1, t = l[m].timestamp; if (t === dayTs) return m; if (t < dayTs) lo = m + 1; else hi = m - 1; } return -1; };
      const toRealTime = async () => { if (has('scrollToRealTime')) safe('scrollToRealTime', () => chart.scrollToRealTime(0)); safe('отступ справа', () => chart.setOffsetRightDistance(0.25 * B.w)); await frames(3); };
      let v, way = '';
      // (1) scrollToTimestamp + подгонка scrollByDistance
      if (has('scrollToTimestamp')) { safe('scrollToTimestamp', () => chart.scrollToTimestamp(dayTs, 0)); await frames(3); await refine(); v = await inspect('путь 1: scrollToTimestamp + scrollByDistance'); if (v.ok) way = 'scrollToTimestamp + scrollByDistance'; }
      // (2) scrollToDataIndex по индексу свечи в getDataList
      if (!way && !v?.stop && has('scrollToDataIndex')) {
        await toRealTime(); const ix = idxNow();
        safe('scrollToDataIndex', () => chart.scrollToDataIndex(ix, 0)); await frames(3);
        if (has('scrollByDistance')) await refine();
        v = await inspect(`путь 2: scrollToDataIndex(${ix})`); if (v.ok) way = 'scrollToDataIndex';
      }
      // (3) от «реального времени» сдвигом на нужное число свечей × шаг (оба знака)
      if (!way && !v?.stop && has('scrollByDistance')) {
        for (const sgn of [1, -1]) {
          await toRealTime();
          const err3 = target() - px(dayTs);
          safe('scrollByDistance', () => chart.scrollByDistance(sgn * err3, 0));
          await frames(3);
          v = await inspect(`путь 3: scrollToRealTime + сдвиг (знак ${sgn > 0 ? '+' : '−'})`);
          if (v.ok) { way = `scrollToRealTime + scrollByDistance (знак ${sgn > 0 ? '+' : '−'})`; break; }
        }
      }
      if (!cap || id !== sessId) return;
      if (!way) {                                                         // (4) не вышло: хотя бы конец загруженных данных, чтобы график был виден
        await toRealTime();
        const msg = 'Не удалось показать выбранный день: показан конец загруженных данных, подвинь график';
        setStatus(msg, true); logE(S(`${msg}; свеча дня не встала в рамку ни одним способом (см. строки «проверка» выше)`));
        const vv = await inspect('запасной путь: scrollToRealTime');
        if (!(vv.inFrame >= CAP_MIN_CANDLES)) logW(S(`даже конец данных не виден в рамке (свечей в рамке ${vv.inFrame}): проверь, что график вообще отрисован`));
      } else logI(S(`позиционирование: сработал путь «${way}»`));
      // линия обрезки: на правом краю свечи дня, доля считается один раз; дальше линия сама никуда не едет
      const xr = px(dayTs) + stepNow() / 2;
      cutRatio = way && Number.isFinite(xr) ? Math.min(Math.max((xr - frame.x) / frame.w, CAP_CUT_MIN), CAP_CUT_MAX) : 0.75; cutOn = false;   // не вышло позиционирование: линия по умолчанию на 75%
      updateCut();
      if (way) setStatus('');
      logI(S(`график готов: линия ${(cutRatio * 100).toFixed(1)}% рамки (правый край свечи дня x=${f2(xr)}), рамка ${Math.round(frame.w)}×${Math.round(frame.h)}`));
    }
    // Окошко «Оригинал» в левом нижнем углу области графика (DOM поверх графика, pointer-events: none, в файл не попадает)
    function positionPrev() {
      const p = el$('#mm-cap-prev'); if (!p || p.hidden || !Chart.chart) return;
      const B = bounds(), gap = cssNum('--mod-market-cap-preview-gap', 12);
      p.style.bottom = `${Math.max(0, chartBox().clientHeight - B.h) + gap}px`;      // над нижней границей панели свечей (оси и RSI не перекрываются)
    }
    function hidePrev() {
      const p = el$('#mm-cap-prev'); if (!p || p.hidden) return;
      p.hidden = true; el$('#mm-cap-prev-img').removeAttribute('src');
    }
    function showPrev(url) {
      const p = el$('#mm-cap-prev'), img = el$('#mm-cap-prev-img');
      if (!url) return;
      const t = setTimeout(() => { img.onload = img.onerror = null; logW(S('превью оригинала не загрузилось за 8 с, окошка не будет')); }, 8000);
      img.onload = () => { clearTimeout(t); if (!cap) return; p.hidden = false; positionPrev(); logI(S(`окошко «Оригинал» показано (${img.naturalWidth}×${img.naturalHeight})`)); };
      img.onerror = () => { clearTimeout(t); logW(S('превью оригинала не открылось (ошибка загрузки картинки), окошка не будет')); };
      img.src = url;
    }
    function load() { return select(cap.symbol, cap.timeframe, true); }
    function start(o) {
      if (cap) return false;
      cap = { ...o, busy: false, prev: { ...sel } };
      frame = null;
      lockUi(true); setStatus('Загрузка свечей…');
      const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(o.pickedDay || ''), dayTxt = dm ? `${dm[3]}.${dm[2]}.${dm[1]}` : new Date(o.endMs).toLocaleDateString('ru-RU');
      el$('#mm-cap-title').textContent = `Режим съёмки: ${o.symbol} ${o.timeframe}, день ${dayTxt}`;
      el$('#mm-sym').value = o.symbol;
      view.querySelectorAll('.mod-market-tf').forEach((b) => b.classList.toggle('active', b.dataset.tf === o.timeframe));
      logI(S(`старт: ${o.symbol} ${o.timeframe}, день ${o.pickedDay || '?'}, конец дня ${both(o.endMs)}`));
      showPrev(o.previewUrl);
      Chart.noRsi = true;                                             // в режиме съёмки RSI не создаётся (панель свечей выше); график пересоздастся при выходе
      cutOn = false; cutDown = null;
      setView('market');                                              // откроет график; данные грузит openChart → MarketCapture.load
      if (chartReady) load();
      return true;
    }
    // Выход: прежний вид живого графика (выбор монеты и ТФ возвращается, данные перезагрузятся при следующем открытии вкладки)
    function exit(noView) {
      const c = cap; cap = null; frame = null; drag = null; cutOn = false; cutDown = null;
      lockUi(false); paint(); setStatus('');
      sessId++; entry = null; sel = c.prev; syncControls();
      Chart.noRsi = false;                                             // живой график снова с RSI
      safe('пересоздание графика', () => Chart.rebuild());
      if (!noView && viewMode === 'market') setView('gallery');
      return c;
    }
    function cancel(why, noView) {
      if (!cap) return;
      const c = exit(noView);
      logI(S(`отмена (${why})`));
      if (c.onCancel) c.onCancel();
    }
    async function save() {
      if (!cap || cap.busy) return;
      if (!frame || !Chart.chart) { setStatus('Рамка ещё не готова: дождись загрузки графика', true); return; }
      const c = cap; c.busy = true; setStatus('Сохранение…');
      el$('#mm-cap-save').disabled = true;
      const t00 = performance.now();
      let ok = false;
      try {
        if (c.beforeSave && !(await c.beforeSave())) { setStatus('Сохранение отменено'); logI(S('сохранение отменено (замена основной не подтверждена)')); return; }
        const chart = Chart.chart, box = chartBox(), cw = box.clientWidth, ch = box.clientHeight, f = { ...frame };
        logI(S(`сохранение: контейнер ${cw}×${ch}, рамка ${Math.round(f.w)}×${Math.round(f.h)} в (${Math.round(f.x)}, ${Math.round(f.y)}), devicePixelRatio ${window.devicePixelRatio}`));
        // свечи в рамке считаются по реальному x каждой свечи (не по индексам и формулам): «До» = последняя свеча, центр которой левее линии; «От» = первая свеча, целиком попадающая в рамку слева
        const cutX = f.x + cutRatio * f.w;
        const list = safe('getDataList', () => chart.getDataList(), []), n = list.length;
        const pxb = (ts) => safe('x свечи', () => chart.convertToPixel({ timestamp: ts }, { paneId: 'candle_pane' }).x, NaN);
        let step = n >= 2 ? pxb(list[n - 1].timestamp) - pxb(list[n - 2].timestamp) : NaN;
        if (!(step > 0)) step = safe('getBarSpace', () => { const b = chart.getBarSpace(); return b && (b.bar || b); }, NaN);
        if (!(step > 0)) throw mkErr('SHOT', 'не удалось определить шаг свечей на графике (convertToPixel)');
        let firstTs = null, lastTs = null, inFrame = 0, inPane = 0;
        const Pw = bounds().w;
        for (let i = 0; i < n; i++) {
          const x = pxb(list[i].timestamp);
          if (!Number.isFinite(x)) continue;
          if (x >= 0 && x <= Pw) inPane++;
          if (x - step / 2 >= f.x - 0.5 && x <= cutX) { if (firstTs === null) firstTs = list[i].timestamp; lastTs = list[i].timestamp; inFrame++; }
        }
        logI(S(`геометрия: свечей загружено ${n}, в панели ${inPane}, шаг ${step.toFixed(2)} px, линия x=${cutX.toFixed(1)} (${(cutRatio * 100).toFixed(2)}% рамки), обрезка ${cutOn ? 'включена' : 'не включена'}`));
        const pts = safe('convertFromPixel', () => chart.convertFromPixel([{ x: f.x }, { x: cutX }], { paneId: 'candle_pane' }), null);   // только для диагностики
        if (pts && pts.length === 2) logI(S(`convertFromPixel (диагностика): слева dataIndex=${pts[0].dataIndex} ts=${pts[0].timestamp != null ? both(pts[0].timestamp) : '?'}; у линии dataIndex=${pts[1].dataIndex} ts=${pts[1].timestamp != null ? both(pts[1].timestamp) : '?'}`));
        logI(S(`свечей в рамке левее линии ${inFrame}${firstTs !== null ? `: первая («От») ${both(firstTs)}, последняя («До») ${both(lastTs)}` : ''}`));
        if (inFrame < CAP_MIN_CANDLES) { logW(S(`отказ: в кадре левее линии ${inFrame} свечей, нужно не меньше ${CAP_MIN_CANDLES} (в панели видно ${inPane} из ${n}, рамка x ${f.x.toFixed(1)}..${(f.x + f.w).toFixed(1)}, линия x=${cutX.toFixed(1)})`)); throw mkErr('SHOT', 'В кадре нет свечей: подвинь график'); }
        if (lastTs + TF_MS[c.timeframe] > Date.now()) logW(S('последняя свеча до линии ещё не закрыта: «До» это время её открытия'));
        // без подсказки свечи, перекрестия и метки последней цены (линии пользователя не попадают: includeOverlay = false)
        const bg = cssVar('--mod-market-bg') || '#0B0B0B';
        let url;
        safe('скрыть подсказки', () => chart.setStyles({ candle: { tooltip: { showRule: 'none' }, priceMark: { last: { show: false } } }, crosshair: { show: false } }));
        try {
          await frames(2); await sleep(120);
          url = chart.getConvertPictureUrl(false, 'png', bg);
        } finally {
          safe('вернуть подсказки', () => chart.setStyles({ candle: { tooltip: { showRule: 'always' }, priceMark: { last: { show: true } } }, crosshair: { show: true } }));
        }
        if (!url || typeof url !== 'string') throw mkErr('SHOT', 'библиотека не вернула картинку');
        const img = await loadImage(url);
        const rawW = img.naturalWidth, rawH = img.naturalHeight, sx = rawW / cw, sy = rawH / ch;      // devicePixelRatio и отношение картинки библиотеки к контейнеру
        const cx = f.x * sx, cy = f.y * sy, cWid = f.w * sx, cHei = f.h * sy;
        const scale = EXPORT_W / cWid;                                                                   // во сколько раз вырезка увеличена до итогового размера
        logI(S(`снимок: библиотека отдала ${rawW}×${rawH} (масштаб ${sx.toFixed(3)}×${sy.toFixed(3)}); вырезка ${Math.round(cWid)}×${Math.round(cHei)} из (${Math.round(cx)}, ${Math.round(cy)}); итог ${EXPORT_W}×${EXPORT_H}, увеличение ${scale.toFixed(2)}×`));
        if (scale > 1.5) logW(S(`вырезка меньше итогового размера: картинка увеличивается в ${scale.toFixed(2)} раза и будет менее резкой (увеличь рамку или масштаб экрана)`));
        if (cx + cWid > rawW + 1 || cy + cHei > rawH + 1) throw mkErr('SHOT', 'рамка выходит за снимок');
        const cv = document.createElement('canvas'); cv.width = EXPORT_W; cv.height = EXPORT_H;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, EXPORT_W, EXPORT_H);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, cx, cy, Math.min(cWid, rawW - cx), Math.min(cHei, rawH - cy), 0, 0, EXPORT_W, EXPORT_H);
        const cutPx = Math.round(cutRatio * EXPORT_W);                                                       // всё правее линии заливается фоном графика (линия и затемнение DOM, в файл не попадают)
        if (cutPx < EXPORT_W) { ctx.fillStyle = bg; ctx.fillRect(cutPx, 0, EXPORT_W - cutPx, EXPORT_H); }
        logI(S(`правее линии (x>${cutPx} из ${EXPORT_W}) залито фоном ${bg}`));
        const pixCnt = cutPx > 0 ? countCandlePx(ctx.getImageData(0, 0, cutPx, EXPORT_H)) : 0;          // защита от пустой картинки: левее линии должны быть свечные пиксели
        logI(S(`свечных пикселей левее линии: ${pixCnt} (нужно ≥ ${CAP_MIN_PIXELS})`));
        if (pixCnt < CAP_MIN_PIXELS) { logW(S(`отказ: снимок пустой (свечных пикселей ${pixCnt} < ${CAP_MIN_PIXELS}), свечей по x в рамке ${inFrame}; ничего не записано`)); throw mkErr('SHOT', 'В кадре нет свечей: подвинь график'); }
        const fw = cssNum('--mod-market-frame-w', 1);                                                    // тонкая рамка вокруг картинки
        ctx.strokeStyle = cssVar('--mod-market-frame') || '#2a2a2a'; ctx.lineWidth = fw;
        ctx.strokeRect(fw / 2, fw / 2, EXPORT_W - fw, EXPORT_H - fw);
        const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
        if (!blob) throw mkErr('SHOT', 'не удалось сохранить снимок в PNG');
        logI(S(`файл ${EXPORT_W}×${EXPORT_H}, PNG ${(blob.size / 1024).toFixed(0)} КБ, снимок и вырезка ${Math.round(performance.now() - t00)} мс`));
        let ver = ''; try { ver = typeof klinecharts.version === 'function' ? klinecharts.version() : ''; } catch { /* ок */ }
        await c.onSave({ blob, width: EXPORT_W, height: EXPORT_H, params: {
          mode: 'manual', anchor_end_ms: lastTs, first_ms: firstTs, last_ms: lastTs, candles_in_frame: inFrame,
          picked_day: c.pickedDay || null, cut_right: true, cut_x_ratio: +cutRatio.toFixed(4), cut_max: CAP_CUT_MAX, after_candles: CAP_AFTER_CANDLES, candles_left_of_cut: inFrame, cut_confirmed: cutOn, version: 'v5.8',
          dpr: window.devicePixelRatio, scale: +scale.toFixed(3), frame_px: { w: Math.round(f.w), h: Math.round(f.h) },
          source: 'binance_usdm', klinecharts: ver || null },
          range: { from: new Date(firstTs).toISOString(), to: new Date(lastTs).toISOString() } });
        ok = true;
      } catch (e) {
        logE(S(`не сохранено: ${msgOf(e)}`));
        setStatus(msgOf(e), true);                                  // остаёмся в режиме съёмки
      } finally {
        c.busy = false; el$('#mm-cap-save').disabled = false;
      }
      if (ok) { exit(false); logI(S('готово, возврат в «Формации»')); if (c.onDone) c.onDone(); }
    }
    return { start, cancel, afterData, load, initDom, toggleCut, isActive: () => !!cap };
  })();
  window.MarketCapture = MarketCapture;

  buildView();
  MarketCapture.initDom();
  bind();
  // для проверки в консоли и тестов
  window.MarketUI = { setView, state: () => ({ sel, sessId, bars: entry ? entry.bars.length : 0, stream: Stream.state }) };
})();
