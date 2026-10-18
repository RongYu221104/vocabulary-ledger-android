import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const wwwDir = path.join(projectRoot, 'www');

function createOfflineVmContext({ initialNativeState = '', onExport = null, onAutoBackup = null } = {}) {
  let nativeDiskState = initialNativeState;
  const autoBackups = new Map();
  const exports = [];

  const elements = new Map();
  const makeEl = id => ({
    id,
    hidden: false,
    open: false,
    disabled: false,
    value: '',
    textContent: '',
    title: '',
    className: '',
    dataset: {},
    attributes: new Map(),
    classList: {
      set: new Set(),
      add(...names) { names.forEach(n => this.set.add(n)); },
      remove(...names) { names.forEach(n => this.set.delete(n)); },
      toggle(name, force) {
        const next = force === undefined ? !this.set.has(name) : Boolean(force);
        if (next) this.set.add(name); else this.set.delete(name);
        return next;
      },
      contains(name) { return this.set.has(name); }
    },
    setAttribute(k, v) { this.attributes.set(k, String(v)); },
    getAttribute(k) { return this.attributes.get(k) ?? null; },
    removeAttribute(k) { this.attributes.delete(k); },
    addEventListener() {},
    append() {},
    replaceChildren() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
    focus() {},
    blur() {},
    click() {},
    getClientRects() { return [{ width: 100, height: 40 }]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    matches() { return false; },
    closest() { return null; },
    isConnected: true
  });

  const docListeners = new Map();
  const document = {
    documentElement: makeEl('html'),
    body: makeEl('body'),
    activeElement: null,
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    createElement(tag) { return makeEl(tag); },
    createElementNS(_ns, tag) { return makeEl(tag); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn, capture) {
      const list = docListeners.get(type) || [];
      list.push({ fn, capture: Boolean(capture) });
      docListeners.set(type, list);
    }
  };

  const AndroidOffline = {
    readStateJson() { return nativeDiskState; },
    writeStateJson(raw) {
      if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return false;
      nativeDiskState = raw;
      return true;
    },
    saveAutoBackup(filename, raw) {
      autoBackups.set(filename, raw);
      if (onAutoBackup) onAutoBackup(filename, raw);
      return true;
    },
    exportJson(filename, raw) {
      exports.push({ filename, raw });
      if (onExport) onExport(filename, raw);
    }
  };

  const ctx = {
    Math,
    Date,
    Map,
    Set,
    JSON,
    Object,
    Number,
    String,
    Boolean,
    Array,
    Promise,
    Error,
    RangeError,
    TypeError,
    TextEncoder,
    TextDecoder,
    URL,
    Blob,
    Event,
    crypto,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    document,
    AndroidOffline,
    fetch() {
      throw new Error('Unexpected raw network fetch');
    },
    addEventListener() {},
    dispatchEvent() {}
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  for (const script of ['model.js', 'order.js', 'flashcards.js', 'groups.js', 'fsrs.js', 'review.js', 'storage.js', 'android-offline.js']) {
    const code = fs.readFileSync(path.join(wwwDir, 'js', script), 'utf8');
    vm.runInNewContext(code, ctx, { filename: script });
  }

  return {
    ctx,
    getDiskState: () => nativeDiskState,
    setDiskState: raw => { nativeDiskState = raw; },
    autoBackups,
    exports,
    elements,
    docListeners
  };
}

test('Android offline bundle includes all required assets, font, styles, and scripts', () => {
  for (const rel of [
    'index.html',
    'ledger.html',
    'css/styles.css',
    'css/android-offline.css',
    'fonts/SourceHanSerifSC-Regular.otf',
    'js/model.js',
    'js/order.js',
    'js/flashcards.js',
    'js/groups.js',
    'js/fsrs.js',
    'js/review.js',
    'js/review-ui.js',
    'js/storage.js',
    'js/sharing.js',
    'js/avatars.js',
    'js/community.js',
    'js/android-offline.js',
    'js/app.js'
  ]) {
    assert.ok(fs.existsSync(path.join(wwwDir, rel)), `Missing asset in www/: ${rel}`);
  }
  const html = fs.readFileSync(path.join(wwwDir, 'index.html'), 'utf8');
  assert.match(html, /css\/android-offline\.css/);
  assert.match(html, /js\/android-offline\.js/);
  assert.match(html, /本机离线/);
  assert.match(html, /已保存在本机 · 离线可用/);
});

test('Offline persistence survives app restart with full ledger, sub-ledgers, words, notes, bold examples, and FSRS review progress', async () => {
  // 1. First launch (cold start on empty disk)
  const first = createOfflineVmContext();
  const { LedgerModel: M, LedgerGroups: G, LedgerFSRS: F, LedgerReview: R, LedgerCloud: S } = first.ctx;

  const store = new S.GuestStore();
  const reviewStore = new R.GuestReviewStore();
  assert.equal(store.current.tags.length, 0);
  assert.equal(store.current.words.length, 0);

  // Add exam sub-ledgers (26-06-1-Reading, 26-06-2-Listening) and a custom ledger
  let data = M.mutate(store.current, 'addTag', { name: '26-06-1-Reading', date: '2026-06-15' });
  data = await store.save(data, { action: 'addTag' });
  data = M.mutate(data, 'addTag', { name: '26-06-2-Listening', date: '2026-06-16' });
  data = await store.save(data, { action: 'addTag' });
  data = M.mutate(data, 'addTag', { name: '高频核心词', date: '2026-10-18' });
  data = await store.save(data, { action: 'addTag' });

  const org = G.organize(data.tags);
  assert.equal(org.masters.length, 1);
  assert.equal(org.masters[0].key, '26-06');
  assert.equal(org.masters[0].subs.length, 2);
  assert.equal(org.customs.length, 1);

  // Add words with **bold** examples and notes
  const readingTagId = data.tags[0].id;
  data = M.mutate(data, 'addWord', {
    tagId: readingTagId,
    english: 'resilient',
    meaning: 'adj. 有韧性的；能迅速恢复的',
    exampleSentence: 'Local communities proved **resilient** in the face of adversity.',
    exampleTranslation: '当地社区在逆境面前表现得**坚韧不拔**。',
    note: '词根：re(回) + salire(跳) → 弹回'
  });
  data = await store.save(data, { action: 'addWord' });

  data = M.mutate(data, 'addWord', {
    tagId: readingTagId,
    english: 'ubiquitous',
    meaning: 'adj. 无所不在的；普遍存在的',
    exampleSentence: 'Smartphones have become **ubiquitous** in daily life.',
    exampleTranslation: '智能手机在日常生活中已**无处不在**。',
    note: '近义词：omnipresent, pervasive'
  });
  data = await store.save(data, { action: 'addWord' });

  // Toggle mastery on the second word
  const word1Id = data.words[0].id;
  const word2Id = data.words[1].id;
  data = M.mutate(data, 'toggleWord', { id: word2Id, mastered: true });
  data = await store.save(data, { action: 'toggleWord' });

  // Record FSRS-6 review rating on the first word
  const now = Date.now();
  const dayKey = R.dayKey(now);
  const ratedCard = F.review(F.empty(word1Id), 3, now, { retention: 0.9 });
  reviewStore.masteries.add(`${dayKey}:${word2Id}`);
  reviewStore.record({
    cards: [ratedCard],
    days: [{ ...R.zero(dayKey), flips: 2, ratings: 1, learned: 1, mastered: 1 }],
    settings: { newPerDay: 30, retention: 0.95 }
  });

  const persistedJson = first.getDiskState();
  assert.ok(persistedJson.length > 100, 'State must be written to native storage');

  // 2. Simulate force-stop / phone reboot: create a brand new VM context with only the disk state
  const second = createOfflineVmContext({ initialNativeState: persistedJson });
  const store2 = new second.ctx.LedgerCloud.GuestStore();
  const review2 = new second.ctx.LedgerReview.GuestReviewStore();

  let hydratedData = null;
  await second.ctx.__onOfflineGuestReady({
    getData: () => hydratedData,
    setData: next => { hydratedData = next; },
    getStore: () => store2,
    getReviewStore: () => review2,
    getReviewUI: () => null,
    feedback: () => {},
    status: () => {},
    render: () => {}
  });

  assert.equal(hydratedData.tags.length, 3);
  assert.equal(hydratedData.words.length, 2);
  assert.equal(hydratedData.words[0].english, 'resilient');
  assert.equal(hydratedData.words[0].note, '词根：re(回) + salire(跳) → 弹回');
  assert.equal(hydratedData.words[1].mastered, true);
  assert.equal(review2.cards.size, 1);
  assert.equal(review2.cards.get(word1Id).reps, 1);
  assert.equal(review2.settings.newPerDay, 30);
  assert.equal(review2.settings.retention, 0.95);
  assert.equal(review2.days.get(dayKey).flips, 2);
  assert.equal(review2.days.get(dayKey).mastered, 1);
  assert.equal(review2.masteries.has(`${dayKey}:${word2Id}`), true);
});

test('JSON export and import (schemaVersion 1 & 2, merge & overwrite) are 100% compatible with web format', async () => {
  const env = createOfflineVmContext();
  const { LedgerModel: M, LedgerReview: R, LedgerCloud: S } = env.ctx;
  const store = new S.GuestStore();
  const reviewStore = new R.GuestReviewStore();

  let data = M.mutate(store.current, 'addTag', { name: '25-12-1-Reading', date: '2025-12-20' });
  data = await store.save(data, { action: 'addTag' });
  data = M.mutate(data, 'addWord', {
    tagId: data.tags[0].id,
    english: 'pragmatic',
    meaning: 'adj. 务实的；讲求实际的',
    exampleSentence: 'We need a **pragmatic** approach.',
    exampleTranslation: '我们需要一种**务实的**方法。',
    note: '派生词：pragmatism'
  });
  data = await store.save(data, { action: 'addWord' });

  // Export JSON via __androidExportJson
  const reviewSec = R.toSection(reviewStore, data.words);
  const backupObj = { ...M.validate(data), exportedAt: new Date().toISOString(), review: reviewSec };
  const rawExport = JSON.stringify(backupObj, null, 2);
  env.ctx.__androidExportJson(rawExport, 'cet-vocabulary-ledger-2026-10-18.json');

  assert.equal(env.exports.length, 1);
  assert.equal(env.exports[0].filename, 'cet-vocabulary-ledger-2026-10-18.json');

  // Parse exported JSON using standard web splitBackup + M.parse
  const split = R.splitBackup(env.exports[0].raw);
  const parsedLedger = M.parse(split.ledgerRaw);
  assert.equal(parsedLedger.schemaVersion, 2);
  assert.equal(parsedLedger.tags.length, 1);
  assert.equal(parsedLedger.words[0].english, 'pragmatic');
  assert.equal(split.review.format, 'cet-review');

  // Auto-backup before restore/merge goes to saveAutoBackup without opening interactive export picker
  env.ctx.__androidExportJson(rawExport, 'cet-before-restore-2026-10-18-12345.json');
  assert.equal(env.exports.length, 1, 'Auto-backup must not trigger interactive picker');
  assert.equal(env.autoBackups.has('cet-before-restore-2026-10-18-12345.json'), true);
  for (const prefix of ['vocabulary-before-restore', 'vocabulary-before-merge', 'cet-before-merge']) {
    const name = prefix + '-2026-10-18-12345.json';
    env.ctx.__androidExportJson(rawExport, name);
    assert.equal(env.autoBackups.has(name), true, name + ' remains an automatic backup');
    assert.equal(env.exports.length, 1, 'Automatic backups must not open the export picker');
  }
  env.ctx.__androidExportJson(rawExport, 'vocabulary-ledger-2026-10-18.json');
  assert.equal(env.exports[1].filename, 'vocabulary-ledger-2026-10-18.json');
  assert.equal(JSON.parse(env.exports[1].raw).format, 'cet-vocabulary-ledger');

  // Test merging a web schemaVersion 1 backup
  const v1WebBackup = JSON.stringify({
    format: M.FORMAT,
    schemaVersion: 1,
    revision: 1,
    tags: [{ id: 'tag_v1', name: '25-12-1-Reading', date: '2025-12-20', createdAt: '2025-12-20T00:00:00.000Z', updatedAt: '2025-12-20T00:00:00.000Z' }],
    words: [{ id: 'word_v1', tagId: 'tag_v1', english: 'eloquent', meaning: 'adj. 雄辩的；有说服力的', mastered: false, createdAt: '2025-12-20T00:00:00.000Z', updatedAt: '2025-12-20T00:00:00.000Z' }]
  });
  const importedV1 = M.parse(R.splitBackup(v1WebBackup).ledgerRaw);
  const merged = M.merge(data, importedV1);
  const savedMerged = await store.save(merged, { restore: true });
  assert.equal(savedMerged.tags.length, 2);
  assert.equal(savedMerged.words.length, 2);
});

test('Cloud API calls and sign-in are blocked offline with exact required prompt', async () => {
  const env = createOfflineVmContext();
  await assert.rejects(
    () => env.ctx.fetch('/api/ledger'),
    /Android 离线版暂未开放登录与云端同步/
  );
  await assert.rejects(
    () => env.ctx.fetch('/api/review'),
    /Android 离线版暂未开放登录与云端同步/
  );
  const gate = new env.ctx.LedgerCloud.SessionGate();
  const gateRes = await gate.check();
  assert.equal(gateRes.authenticated, false);
});

test('Android back gesture state machine handles dialogs, review views, search clear, and double-back exit', () => {
  const env = createOfflineVmContext();
  const { document } = env.ctx;

  // 1. Offline notice dialog open -> back closes it
  const offlineDlg = document.getElementById('offline-notice-dialog');
  offlineDlg.open = true;
  assert.equal(env.ctx.__handleAndroidBack(), 'handled');
  assert.equal(offlineDlg.open, false);

  // 2. Review dialog in guide view (forgetting curve) -> back clicks #rv-guide-back
  const reviewDlg = document.getElementById('review-dialog');
  const rvGuideBack = document.getElementById('rv-guide-back');
  let rvGuideBackClicked = false;
  rvGuideBack.click = () => { rvGuideBackClicked = true; reviewDlg.dataset.view = 'home'; };
  reviewDlg.open = true;
  reviewDlg.dataset.view = 'guide';
  assert.equal(env.ctx.__handleAndroidBack(), 'handled');
  assert.equal(rvGuideBackClicked, true);
  assert.equal(reviewDlg.dataset.view, 'home');

  // 3. Review dialog in session view -> back clicks #rv-back
  const rvBack = document.getElementById('rv-back');
  let rvBackClicked = false;
  rvBack.click = () => { rvBackClicked = true; reviewDlg.dataset.view = 'home'; };
  reviewDlg.open = true;
  reviewDlg.dataset.view = 'session';
  assert.equal(env.ctx.__handleAndroidBack(), 'handled');
  assert.equal(rvBackClicked, true);

  // 4. Review dialog in home view -> back closes review dialog
  const rvClose = document.getElementById('rv-close');
  rvClose.click = () => { reviewDlg.open = false; };
  assert.equal(env.ctx.__handleAndroidBack(), 'handled');
  assert.equal(reviewDlg.open, false);

  // 5. Local search active -> back clears local search
  const localSearch = document.getElementById('local-search');
  localSearch.value = 'resilient';
  localSearch.dispatchEvent = () => {};
  assert.equal(env.ctx.__handleAndroidBack(), 'handled');
  assert.equal(localSearch.value, '');

  // 6. Root view -> first back returns 'toast', second back within 2s returns 'exit'
  assert.equal(env.ctx.__handleAndroidBack(), 'toast');
  assert.equal(env.ctx.__handleAndroidBack(), 'exit');
});

test('FSRS-6 forgetting curve math, retention-sensitive intervals, and SRS settings normalization match web version', () => {
  const env = createOfflineVmContext();
  const { LedgerFSRS: F, LedgerReview: R } = env.ctx;
  const now = Date.UTC(2026, 9, 18, 8, 0, 0);

  // 1. Forgetting curve retrievability R(t, S) = (1 + factor * t / S)^(-w20)
  assert.equal(F.retrievability(0, 10), 1);
  const rAtS = F.retrievability(10, 10);
  assert.ok(Math.abs(rAtS - 0.9) < 1e-6, `Retrievability at t === S must be 0.9, got ${rAtS}`);
  assert.ok(F.retrievability(5, 10) > 0.9);
  assert.ok(F.retrievability(20, 10) < 0.9);

  // 2. Target retention controls scheduled intervals: higher retention -> shorter interval
  const iv85 = F.intervalFor(10, 0.85);
  const iv90 = F.intervalFor(10, 0.90);
  const iv95 = F.intervalFor(10, 0.95);
  assert.ok(iv85 > iv90 && iv90 > iv95, `Expected iv85 (${iv85}) > iv90 (${iv90}) > iv95 (${iv95})`);

  // 3. Preview on a new card reflects target retention and guards invalid retention values
  const emptyCard = F.empty('word_1');
  const prev90 = F.preview(emptyCard, now, { retention: 0.9 });
  const prev95 = F.preview(emptyCard, now, { retention: 0.95 });
  const prevInvalid = F.preview(emptyCard, now, { retention: 'bad' });
  assert.equal(F.label(prev90[3].due - now), '2 天');
  assert.equal(F.label(prev95[3].due - now), '1 天');
  assert.equal(F.label(prevInvalid[3].due - now), F.label(prev90[3].due - now));

  // 4. normalizeSettings handles presets, custom values, zero newPerDay, numeric strings, and damaged fields
  assert.deepEqual({ ...R.normalizeSettings(null) }, { newPerDay: 20, retention: 0.9 });
  assert.deepEqual({ ...R.normalizeSettings({ newPerDay: 0, retention: 0.85 }) }, { newPerDay: 0, retention: 0.85 });
  assert.deepEqual({ ...R.normalizeSettings({ newPerDay: '50', retention: '0.95' }) }, { newPerDay: 50, retention: 0.95 });
  assert.deepEqual({ ...R.normalizeSettings({ newPerDay: 17, retention: 0.875 }) }, { newPerDay: 17, retention: 0.875 });
  assert.deepEqual({ ...R.normalizeSettings({ newPerDay: 50, retention: 2 }) }, { newPerDay: 50, retention: 0.9 });
  assert.deepEqual({ ...R.normalizeSettings({ newPerDay: -5, retention: 0.85 }) }, { newPerDay: 20, retention: 0.85 });

  // 5. R.plan respects newPerDay: 0 (due reviews still scheduled, new cards capped at 0)
  const words = [
    { id: 'w_due', english: 'alpha', meaning: 'n. 阿尔法', mastered: false },
    { id: 'w_new', english: 'beta', meaning: 'n. 贝塔', mastered: false }
  ];
  const dueCard = {
    ...F.review(F.empty('w_due'), 3, now - 5 * 86400000, { retention: 0.9 }),
    due: now - 3600000
  };
  const cardsMap = new Map([['w_due', dueCard]]);
  const planZeroNew = R.plan({
    words,
    cards: cardsMap,
    now,
    settings: { newPerDay: 0, retention: 0.9 },
    learnedToday: 0
  });
  assert.equal(planZeroNew.due.length, 1);
  assert.equal(planZeroNew.fresh.length, 0);
  assert.equal(planZeroNew.due[0], 'w_due');
});

test('Non-destructive local state migration preserves legacy v1 data and salvages partially damaged review records', async () => {
  const legacyV1Envelope = JSON.stringify({
    format: 'cet-android-offline-v1',
    savedAt: '2026-10-17T12:00:00.000Z',
    ledger: {
      // Legacy schemaVersion 1 without recordVersion or note/example fields
      format: 'cet-vocabulary-ledger',
      schemaVersion: 1,
      revision: 4,
      tags: [
        { id: 'tag_legacy', name: '25-06-1-Reading', date: '2025-06-15', createdAt: '2025-06-15T00:00:00.000Z', updatedAt: '2025-06-15T00:00:00.000Z' }
      ],
      words: [
        { id: 'word_legacy_1', tagId: 'tag_legacy', english: 'LegacyWord', meaning: 'n. 旧版词条', mastered: false, createdAt: '2025-06-15T00:00:00.000Z', updatedAt: '2025-06-15T00:00:00.000Z' }
      ]
    },
    review: {
      format: 'cet-review',
      version: 1,
      extraLegacyProperty: 'should-not-discard-state',
      settings: { newPerDay: '30', retention: 'invalid-retention' },
      cards: [
        {
          wordId: 'word_legacy_1',
          state: 2,
          stability: 6.5,
          difficulty: 5.2,
          reps: 2,
          lapses: 0,
          due: Date.UTC(2026, 9, 19),
          lastReview: Date.UTC(2026, 9, 13)
        },
        {
          wordId: '', // corrupted card entry that should be skipped without losing valid cards
          state: 'bad'
        }
      ],
      days: [
        { day: '2026-10-17', flips: 5, ratings: 2, lapses: 0, learned: 1, mastered: 0 },
        { day: 'bad-date', flips: -1 }
      ]
    },
    masteries: ['2026-10-17:word_legacy_1']
  });

  const env = createOfflineVmContext({ initialNativeState: legacyV1Envelope });
  const store = new env.ctx.LedgerCloud.GuestStore();
  const reviewStore = new env.ctx.LedgerReview.GuestReviewStore();

  let hydrated = null;
  await env.ctx.__onOfflineGuestReady({
    getData: () => hydrated,
    setData: next => { hydrated = next; },
    getStore: () => store,
    getReviewStore: () => reviewStore,
    getReviewUI: () => null,
    feedback: () => {},
    status: () => {},
    render: () => {}
  });

  assert.equal(hydrated.schemaVersion, 2);
  assert.equal(hydrated.revision, 4);
  assert.equal(hydrated.tags.length, 1);
  assert.equal(hydrated.words.length, 1);
  assert.equal(hydrated.words[0].english, 'LegacyWord');
  assert.equal(reviewStore.settings.newPerDay, 30);
  assert.equal(reviewStore.settings.retention, 0.9);
  assert.equal(reviewStore.cards.size, 1);
  assert.equal(reviewStore.cards.get('word_legacy_1').reps, 2);
  assert.equal(reviewStore.days.size, 1);
  assert.equal(reviewStore.days.get('2026-10-17').flips, 5);
  assert.equal(reviewStore.masteries.has('2026-10-17:word_legacy_1'), true);
});

