(function () {
  'use strict';

  window.__OFFLINE_APP = true;
  document.documentElement.classList.add('is-android-offline');

  const M = window.LedgerModel;
  const R = window.LedgerReview;
  const S = window.LedgerCloud;
  const $ = id => document.getElementById(id);

  const OFFLINE_PROMPT = 'Android 离线版暂未开放登录与云端同步';
  const ENVELOPE_FORMAT = 'cet-android-offline-v1';
  const IDB_NAME = 'cet_vocabulary_ledger_offline_v1';
  const IDB_VERSION = 1;
  const IDB_STATE_STORE = 'state';
  const IDB_BACKUP_STORE = 'backups';
  const PRIMARY_KEY = 'primary';

  // Block any accidental network calls to cloud endpoints so offline mode is 100% self-contained.
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (
      url.startsWith('/api/') ||
      url.startsWith('/signin-') ||
      url.startsWith('/signout-') ||
      url.includes('/api/ledger') ||
      url.includes('/api/review') ||
      url.includes('/api/session') ||
      url.includes('/api/shares') ||
      url.includes('/api/community') ||
      url.includes('/api/profile')
    ) {
      throw new TypeError(OFFLINE_PROMPT);
    }
    if (!nativeFetch) throw new TypeError(OFFLINE_PROMPT);
    return nativeFetch(input, init);
  };

  function emptyReviewSection() {
    return {
      format: R.FORMAT,
      version: R.VERSION,
      settings: R.normalizeSettings ? R.normalizeSettings(R.DEFAULTS) : { ...R.DEFAULTS },
      cards: [],
      days: []
    };
  }

  function migrateLedgerObject(rawLedger) {
    if (!rawLedger || typeof rawLedger !== 'object' || Array.isArray(rawLedger)) {
      throw new Error('Invalid ledger object');
    }
    try {
      return M.validate(rawLedger);
    } catch {
      // Non-destructive fallback for legacy local state missing top-level metadata or containing extra keys
      return M.validate({
        format: M.FORMAT,
        schemaVersion: Number.isInteger(rawLedger.schemaVersion) ? rawLedger.schemaVersion : 1,
        revision: Number.isInteger(rawLedger.revision) && rawLedger.revision >= 0 ? rawLedger.revision : 0,
        tags: Array.isArray(rawLedger.tags) ? rawLedger.tags : [],
        words: Array.isArray(rawLedger.words) ? rawLedger.words : []
      });
    }
  }

  function migrateReviewSection(rawReview) {
    if (!rawReview || typeof rawReview !== 'object' || Array.isArray(rawReview)) {
      return emptyReviewSection();
    }
    try {
      return R.section(rawReview);
    } catch (err) {
      // Non-destructive salvage: keep normalized settings and every valid card/day record
      console.warn('[AndroidOffline] Salvaging review section during migration:', err);
      const settings = R.normalizeSettings ? R.normalizeSettings(rawReview.settings) : { ...R.DEFAULTS };
      const cards = [];
      const seenWords = new Set();
      if (Array.isArray(rawReview.cards)) {
        for (const item of rawReview.cards) {
          try {
            const c = R.card(item);
            if (!seenWords.has(c.wordId)) {
              seenWords.add(c.wordId);
              cards.push(c);
            }
          } catch {}
        }
      }
      const days = [];
      const seenDays = new Set();
      if (Array.isArray(rawReview.days)) {
        for (const item of rawReview.days) {
          try {
            const d = R.day(item, 1e7);
            if (!seenDays.has(d.day)) {
              seenDays.add(d.day);
              days.push(d);
            }
          } catch {}
        }
      }
      return {
        format: R.FORMAT,
        version: R.VERSION,
        settings,
        cards,
        days
      };
    }
  }

  function parseEnvelope(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      // Accept either our wrapped envelope or a direct ledger backup with optional review section.
      if (parsed.format === ENVELOPE_FORMAT && parsed.ledger) {
        const ledger = migrateLedgerObject(parsed.ledger);
        const review = migrateReviewSection(parsed.review);
        const masteries = Array.isArray(parsed.masteries)
          ? parsed.masteries.filter(x => typeof x === 'string' && x.length <= 120)
          : [];
        return {
          format: ENVELOPE_FORMAT,
          savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
          ledger,
          review,
          masteries
        };
      }
      if (parsed.tags && parsed.words) {
        const ledger = migrateLedgerObject(parsed);
        const review = migrateReviewSection(parsed.review);
        return {
          format: ENVELOPE_FORMAT,
          savedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : new Date().toISOString(),
          ledger,
          review,
          masteries: []
        };
      }
    } catch (err) {
      console.warn('[AndroidOffline] Ignored invalid stored state:', err);
    }
    return null;
  }

  function reviewActivityScore(env) {
    const rev = env?.review;
    if (!rev) return 0;
    const cardScore = Array.isArray(rev.cards)
      ? rev.cards.reduce((sum, c) => sum + 1 + (Number(c?.reps) || 0) + (Number(c?.lapses) || 0), 0)
      : 0;
    const dayScore = Array.isArray(rev.days)
      ? rev.days.reduce((sum, d) => sum + (Number(d?.flips) || 0) + (Number(d?.ratings) || 0) + (Number(d?.learned) || 0) + (Number(d?.mastered) || 0), 0)
      : 0;
    return cardScore + dayScore;
  }

  function pickFresherEnvelope(a, b) {
    if (!a) return b;
    if (!b) return a;
    const revA = Number(a.ledger?.revision || 0);
    const revB = Number(b.ledger?.revision || 0);
    if (revA !== revB) return revA > revB ? a : b;
    const scoreA = reviewActivityScore(a);
    const scoreB = reviewActivityScore(b);
    if (scoreA !== scoreB) return scoreA > scoreB ? a : b;
    const timeA = String(a.savedAt || '');
    const timeB = String(b.savedAt || '');
    return timeB > timeA ? b : a;
  }

  // IndexedDB persistence layer (works in both Android WebView and desktop Chromium/Playwright)
  let dbPromise = null;
  function openIdb() {
    if (dbPromise) return dbPromise;
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    dbPromise = new Promise(resolve => {
      try {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STATE_STORE)) db.createObjectStore(IDB_STATE_STORE);
          if (!db.objectStoreNames.contains(IDB_BACKUP_STORE)) db.createObjectStore(IDB_BACKUP_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  }

  async function idbReadState() {
    const db = await openIdb();
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(IDB_STATE_STORE, 'readonly');
        const req = tx.objectStore(IDB_STATE_STORE).get(PRIMARY_KEY);
        req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function idbWriteState(raw) {
    const db = await openIdb();
    if (!db) return false;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(IDB_STATE_STORE, 'readwrite');
        tx.objectStore(IDB_STATE_STORE).put(raw, PRIMARY_KEY);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  async function idbSaveBackup(filename, raw) {
    const db = await openIdb();
    if (!db) return false;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(IDB_BACKUP_STORE, 'readwrite');
        tx.objectStore(IDB_BACKUP_STORE).put({ filename, raw, savedAt: new Date().toISOString() }, filename);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  function nativeReadStateSync() {
    try {
      if (window.AndroidOffline && typeof window.AndroidOffline.readStateJson === 'function') {
        const raw = window.AndroidOffline.readStateJson();
        if (raw) return parseEnvelope(raw);
      }
    } catch (err) {
      console.warn('[AndroidOffline] Native read error:', err);
    }
    return null;
  }

  function nativeWriteStateSync(raw) {
    try {
      if (window.AndroidOffline && typeof window.AndroidOffline.writeStateJson === 'function') {
        return Boolean(window.AndroidOffline.writeStateJson(raw));
      }
    } catch (err) {
      console.warn('[AndroidOffline] Native write error:', err);
    }
    return false;
  }

  // Active references to the live ledger store and review store
  let activeLedgerStore = null;
  let activeReviewStore = null;
  let bootEnvelope = nativeReadStateSync();
  let appBridge = null;

  function buildCurrentEnvelope() {
    const ledger = activeLedgerStore ? M.validate(activeLedgerStore.current) : M.empty();
    const review = activeReviewStore
      ? R.toSection(activeReviewStore, ledger.words)
      : emptyReviewSection();
    const masteries = activeReviewStore?.masteries instanceof Set
      ? [...activeReviewStore.masteries]
      : [];
    return {
      format: ENVELOPE_FORMAT,
      savedAt: new Date().toISOString(),
      ledger,
      review,
      masteries
    };
  }

  async function persistEverything() {
    const envelope = buildCurrentEnvelope();
    const raw = JSON.stringify(envelope);
    const nativeOk = nativeWriteStateSync(raw);
    const idbOk = await idbWriteState(raw);
    if (!nativeOk && !idbOk && window.AndroidOffline) {
      throw new S.StorageError('本地存储写入失败，请检查手机剩余存储空间。');
    }
    return envelope;
  }

  function persistEverythingSyncAndAsync() {
    try {
      const envelope = buildCurrentEnvelope();
      const raw = JSON.stringify(envelope);
      const nativeOk = nativeWriteStateSync(raw);
      idbWriteState(raw).then(idbOk => {
        if (!nativeOk && !idbOk) reportPersistenceFailure();
      }).catch(() => { if (!nativeOk) reportPersistenceFailure(); });
    } catch (err) {
      console.warn('[AndroidOffline] Background persist warning:', err);
      reportPersistenceFailure();
    }
  }

  function reportPersistenceFailure() {
    appBridge?.feedback?.('复习进度尚未保存到本机，请检查剩余存储空间并导出 JSON 备份；当前页面仍保留进度。', true);
    appBridge?.status?.('本机保存失败 · 请导出备份');
  }

  // Replace SessionGate so it never touches network /api/session
  class OfflineSessionGate {
    constructor() {
      this.generation = 0;
    }
    invalidate() {
      this.generation++;
    }
    async check() {
      return { authenticated: false };
    }
  }

  // Subclass GuestStore with durable OfflineLedgerStore
  const BaseGuestStore = S.GuestStore;
  class OfflineLedgerStore extends BaseGuestStore {
    constructor() {
      super();
      if (bootEnvelope) {
        this.current = M.clone(bootEnvelope.ledger);
      }
      this._dirty = false;
      activeLedgerStore = this;
    }
    get dirty() {
      return false;
    }
    set dirty(value) {
      this._dirty = Boolean(value);
      // When app.js toggles mastery off, it mutates reviewStore.masteries & days and sets store.dirty = true.
      if (value && activeReviewStore) {
        queueMicrotask(() => persistEverythingSyncAndAsync());
      }
    }
    async load() {
      const env = await loadPersistedEnvelope();
      if (env) this.current = M.clone(env.ledger);
      return { data: M.clone(this.current), error: null };
    }
    async revision() {
      return this.current.revision;
    }
    async save(nextData, meta = {}) {
      const saved = await super.save(nextData, meta);
      this._dirty = false;
      await persistEverything();
      return saved;
    }
    dispose() {
      super.dispose();
      this._dirty = false;
    }
  }

  // Wrap GuestReviewStore so every FSRS rating, flip, setting change, or restore persists to disk immediately.
  const BaseGuestReviewStore = R.GuestReviewStore;
  class OfflineReviewStore extends BaseGuestReviewStore {
    constructor(opts = {}) {
      super(opts);
      this.masteries = new Set();
      if (bootEnvelope) {
        this.reset(bootEnvelope.review);
        this.masteries = new Set(bootEnvelope.masteries || []);
      }
      this.loaded = true;
      activeReviewStore = this;
    }
    record(change) {
      super.record(change);
      persistEverythingSyncAndAsync();
    }
    async replace(sectionValue) {
      await super.replace(sectionValue);
      await persistEverything();
    }
  }

  async function loadPersistedEnvelope() {
    const nativeEnv = nativeReadStateSync();
    const idbRaw = await idbReadState();
    const idbEnv = parseEnvelope(idbRaw);
    const chosen = pickFresherEnvelope(nativeEnv, idbEnv);
    if (chosen) {
      bootEnvelope = chosen;
      const raw = JSON.stringify(chosen);
      if (chosen !== nativeEnv) nativeWriteStateSync(raw);
      if (chosen !== idbEnv) await idbWriteState(raw);
    }
    return chosen;
  }

  // Patch window.LedgerCloud and window.LedgerReview before app.js executes
  window.LedgerCloud = Object.freeze({
    ...S,
    GuestStore: OfflineLedgerStore,
    SessionGate: OfflineSessionGate,
    session: async () => ({ authenticated: false })
  });

  window.LedgerReview = Object.freeze({
    ...R,
    GuestReviewStore: OfflineReviewStore
  });

  // Hook called by www/js/app.js inside load() once DOM & stores are ready
  window.__onOfflineGuestReady = async function (bridge) {
    appBridge = bridge;
    const chosen = await loadPersistedEnvelope();
    if (chosen) {
      const store = bridge.getStore();
      const reviewStore = bridge.getReviewStore();
      store.current = M.clone(chosen.ledger);
      bridge.setData(M.clone(chosen.ledger));
      reviewStore.reset(chosen.review);
      reviewStore.masteries = new Set(chosen.masteries || []);
      reviewStore.loaded = true;
    }
    decorateOfflineUI();
    bridge.render();
  };

  // Save on visibilitychange / pagehide as an extra durability safeguard
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeLedgerStore) {
      persistEverythingSyncAndAsync();
    }
  });
  window.addEventListener('pagehide', () => {
    if (activeLedgerStore) {
      persistEverythingSyncAndAsync();
    }
  });

  // ── JSON Export & Automatic Backup Bridge ───────────────────────────────────────────────────────────────
  window.__lastExportedJson = null;
  window.__lastAutoBackupJson = null;

  window.__androidExportJson = function (raw, filename) {
    const isAutoBackup = /^(?:vocabulary|cet)-before-(?:restore|merge)-/.test(filename);
    if (isAutoBackup) {
      window.__lastAutoBackupJson = { filename, raw };
      idbSaveBackup(filename, raw);
      try {
        if (window.AndroidOffline && typeof window.AndroidOffline.saveAutoBackup === 'function') {
          window.AndroidOffline.saveAutoBackup(filename, raw);
          return;
        }
      } catch (err) {
        console.warn('[AndroidOffline] saveAutoBackup error:', err);
      }
      return;
    }

    window.__lastExportedJson = { filename, raw };
    idbSaveBackup(filename, raw);
    if (window.AndroidOffline && typeof window.AndroidOffline.exportJson === 'function') {
      try {
        window.AndroidOffline.exportJson(filename, raw);
        return;
      } catch (err) {
        console.warn('[AndroidOffline] exportJson error:', err);
      }
    }
    // Browser / Playwright fallback: trigger standard Blob download
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  window.__onAndroidExportResult = function (ok, detail) {
    if (!appBridge) return;
    if (ok) {
      appBridge.feedback('已导出账本 JSON' + (detail ? `（${detail}）` : '') + '，请妥善保管。');
    } else if (detail === 'cancelled') {
      appBridge.feedback('已取消导出 JSON。');
    } else {
      appBridge.feedback('导出 JSON 失败：' + (detail || '无法写入目标文件'), true);
    }
  };

  // ── Offline Notice Dialog & Cloud Entry Interception ────────────────────────────────────────────────────
  let offlineDialogReturnFocus = null;

  function ensureOfflineDialog() {
    let dialog = $('offline-notice-dialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = 'offline-notice-dialog';
    dialog.setAttribute('aria-labelledby', 'offline-notice-title');
    dialog.setAttribute('aria-describedby', 'offline-notice-desc');

    const head = document.createElement('div');
    head.className = 'offline-notice-head';

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'art offline-notice-art');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('aria-hidden', 'true');
    const p1 = document.createElementNS(svgNS, 'path');
    p1.setAttribute('class', 'art-clay');
    p1.setAttribute('d', 'M14 18c10-6 26-5 34 3 6 6 5 20-2 27-8 7-22 8-31 2-7-5-9-24-1-32z');
    const p2 = document.createElementNS(svgNS, 'path');
    p2.setAttribute('class', 'art-paper art-ink');
    p2.setAttribute('d', 'M18 14c10-.8 19-.5 28 .8l-.8 35c-9-.8-18-1-27.2-.4z');
    const p3 = document.createElementNS(svgNS, 'path');
    p3.setAttribute('class', 'art-ink art-thin');
    p3.setAttribute('d', 'M24 24h16M24 31h12M24 38h14');
    svg.append(p1, p2, p3);

    const titles = document.createElement('div');
    const kicker = document.createElement('p');
    kicker.className = 'offline-notice-kicker';
    kicker.textContent = 'Offline Edition · 本机离线版';
    const h2 = document.createElement('h2');
    h2.id = 'offline-notice-title';
    h2.textContent = OFFLINE_PROMPT;
    titles.append(kicker, h2);
    head.append(svg, titles);

    const body = document.createElement('div');
    body.id = 'offline-notice-desc';
    body.className = 'offline-notice-body';
    const pMain = document.createElement('p');
    pMain.id = 'offline-notice-feature';
    pMain.textContent = '当前为独立安装的 Android 离线版，无需联网即可完整使用全部账本管理、词条录入、卡片背诵与遗忘曲线智能复习功能。';
    const pSub = document.createElement('p');
    pSub.textContent = '所有账本、词条及复习记录均自动持久保存在手机本地存储中。如需跨设备迁移或备份，请使用顶部「导出 JSON」与「导入恢复」。';
    const badge = document.createElement('span');
    badge.className = 'offline-notice-badge';
    badge.textContent = '本机自动持久化 · 飞行模式可用 · 兼容网页版 JSON';
    body.append(pMain, pSub, badge);

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.id = 'offline-notice-export';
    exportBtn.className = 'quiet';
    exportBtn.textContent = '导出 JSON 备份';
    exportBtn.addEventListener('click', () => {
      dialog.close();
      $('export-button')?.click();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.id = 'offline-notice-close';
    closeBtn.className = 'primary';
    closeBtn.textContent = '我知道了';
    closeBtn.addEventListener('click', () => dialog.close());

    actions.append(exportBtn, closeBtn);
    dialog.append(head, body, actions);

    dialog.addEventListener('close', () => {
      if (offlineDialogReturnFocus?.isConnected && offlineDialogReturnFocus.getClientRects().length) {
        offlineDialogReturnFocus.focus({ preventScroll: true });
      }
      offlineDialogReturnFocus = null;
    });

    document.body.append(dialog);
    return dialog;
  }

  function showOfflinePrompt(featureName, opener) {
    const dialog = ensureOfflineDialog();
    const featureLine = $('offline-notice-feature');
    if (featureLine) {
      featureLine.textContent = featureName
        ? `「${featureName}」属于联网云端功能；${OFFLINE_PROMPT}。`
        : `${OFFLINE_PROMPT}。当前所有学习数据均安全保存在手机本机。`;
    }
    if (appBridge?.feedback) {
      appBridge.feedback(OFFLINE_PROMPT);
    }
    const fb = $('feedback');
    if (fb) {
      fb.textContent = OFFLINE_PROMPT;
      fb.classList.add('is-visible');
    }
    if (!dialog.open) {
      offlineDialogReturnFocus = opener || document.activeElement;
      dialog.showModal();
      $('offline-notice-close')?.focus({ preventScroll: true });
    }
  }

  function decorateOfflineUI() {
    const signIn = $('sign-in');
    if (signIn) {
      signIn.setAttribute('href', '#offline-login-disabled');
      signIn.removeAttribute('target');
    }
    for (const id of ['community-open', 'sharing-open', 'sharing-manage']) {
      const el = $(id);
      if (el) {
        el.dataset.offlineDisabled = 'true';
        el.setAttribute('aria-disabled', 'true');
        el.title = OFFLINE_PROMPT;
      }
    }
  }

  // Intercept cloud-only actions in capture phase so they never navigate or open cloud dialogs
  document.addEventListener('click', e => {
    const signIn = e.target.closest?.('#sign-in, #auth-continue');
    if (signIn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showOfflinePrompt('登录 ChatGPT 与云端同步', signIn);
      return;
    }
    const communityBtn = e.target.closest?.('#community-open, #account-name');
    if (communityBtn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showOfflinePrompt('个人资料与公开社区', communityBtn);
      return;
    }
    const sharingBtn = e.target.closest?.('#sharing-open, #sharing-manage');
    if (sharingBtn) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showOfflinePrompt('在线分享链接（离线版请使用导出/导入 JSON）', sharingBtn);
    }
  }, true);

  // ── Soft Keyboard Adaptation ────────────────────────────────────────────────────────────────────────────
  function scrollFocusedFieldIntoView(target) {
    if (!target || !target.matches?.('input, textarea, select')) return;
    setTimeout(() => {
      if (document.activeElement === target && target.isConnected) {
        try {
          target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        } catch {
          target.scrollIntoView();
        }
      }
    }, 120);
  }

  document.addEventListener('focusin', e => {
    scrollFocusedFieldIntoView(e.target);
  });

  if (window.visualViewport) {
    let lastHeight = window.visualViewport.height;
    window.visualViewport.addEventListener('resize', () => {
      const currentHeight = window.visualViewport.height;
      if (currentHeight < lastHeight - 80 && document.activeElement) {
        scrollFocusedFieldIntoView(document.activeElement);
      }
      lastHeight = currentHeight;
    });
  }

  // ── Android System Back Gesture Handler ─────────────────────────────────────────────────────────────────
  let lastBackExitAttempt = 0;

  window.__handleAndroidBack = function () {
    const offlineDialog = $('offline-notice-dialog');
    if (offlineDialog?.open) {
      offlineDialog.close();
      return 'handled';
    }
    const confirmDialog = $('confirm-dialog');
    if (confirmDialog?.open) {
      const cancelBtn = $('cancel-confirm');
      if (cancelBtn && !cancelBtn.disabled) cancelBtn.click();
      else confirmDialog.close();
      return 'handled';
    }
    const editorDialog = $('editor-dialog');
    if (editorDialog?.open) {
      $('cancel-editor')?.click();
      return 'handled';
    }
    for (const id of ['auth-dialog', 'sharing-dialog', 'community-dialog']) {
      const dlg = $(id);
      if (dlg?.open) {
        dlg.close();
        return 'handled';
      }
    }
    const reviewDialog = $('review-dialog');
    if (reviewDialog?.open) {
      const viewMode = reviewDialog.dataset.view;
      if (viewMode === 'guide') {
        $('rv-guide-back')?.click();
        return 'handled';
      }
      if (viewMode === 'session') {
        $('rv-back')?.click();
        return 'handled';
      }
      $('rv-close')?.click();
      return 'handled';
    }
    const openTip = document.querySelector('.tip-wrap.is-open');
    if (openTip) {
      openTip.classList.remove('is-open');
      openTip.querySelector('.help-tip')?.setAttribute('aria-expanded', 'false');
      return 'handled';
    }
    const ledgerBar = $('ledger-bar');
    if (ledgerBar && ledgerBar.classList.contains('tools-open')) {
      $('bar-tools-toggle')?.click();
      return 'handled';
    }
    const localSearch = $('local-search');
    if (localSearch && localSearch.value) {
      localSearch.value = '';
      localSearch.dispatchEvent(new Event('input', { bubbles: true }));
      return 'handled';
    }
    const globalSearch = $('global-search');
    if (globalSearch && globalSearch.value) {
      $('clear-global')?.click();
      return 'handled';
    }
    if (document.activeElement && document.activeElement.matches?.('input, textarea, select')) {
      document.activeElement.blur();
      return 'handled';
    }

    const now = Date.now();
    if (now - lastBackExitAttempt < 2000) {
      lastBackExitAttempt = 0;
      return 'exit';
    }
    lastBackExitAttempt = now;
    if (appBridge?.feedback) {
      appBridge.feedback('再按一次返回键退出应用');
    }
    return 'toast';
  };
})();
