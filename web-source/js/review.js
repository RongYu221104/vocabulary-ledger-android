(function (root, factory) {
  'use strict';
  const api = factory(root.LedgerCurve, root.LedgerReviewPreference);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LedgerReview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (F, preference) {
  'use strict';
  // Smart review data: one memory state per word (the fixed ladder in curve.js), one counter row per local day, and
  // two settings (only the daily new-word allowance is used now; `retention` stays for old rows and backups).
  // It lives beside the ledger, never inside it: ratings do not bump the ledger revision, so reviewing on one
  // device never turns an edit on another device into a version conflict. Words are referenced by their stable id;
  // a state whose word no longer exists is simply ignored (and comes back if a backup restores that word).
  const FORMAT = 'cet-review', VERSION = 1;
  const LIMITS = Object.freeze({ cards: 20000, days: 36600, batch: 500, delta: 100000, bytes: 16 * 1024 * 1024 });
  const DEFAULTS = Object.freeze({ newPerDay: 20, retention: 0.9 });
  // Presets offered in 复习设置; any positive integer up to MAX_NEW is accepted as a custom allowance.
  const NEW_PER_DAY = Object.freeze([10, 20, 30, 50, 100, 200, 300, 500, 1000]);
  const MAX_NEW = 9999;
  const RETENTION = Object.freeze([0.85, 0.9, 0.95]);
  const COUNTERS = Object.freeze(['flips', 'ratings', 'lapses', 'learned', 'mastered']);
  // A memory is "sturdy" once it has reached the curve's 7-day loop.
  const STURDY_DAYS = 7;
  const ID = /^[a-zA-Z0-9_-]{1,80}$/, DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

  class ReviewError extends Error { constructor(message, code = 'validation') { super(message); this.name = 'ReviewError'; this.code = code; } }
  const fail = message => { throw new ReviewError(message); };
  const isInt = (x, lo, hi) => Number.isSafeInteger(x) && x >= lo && x <= hi;
  const isNum = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
  function exact(obj, keys) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('复习数据结构不合法。');
    const own = Object.keys(obj); if (own.length !== keys.length || keys.some(k => !Object.hasOwn(obj, k))) fail('复习数据字段缺失或包含未知字段。');
  }
  function card(c) {
    exact(c, ['wordId', 'state', 'stability', 'difficulty', 'reps', 'lapses', 'due', 'lastReview']);
    if (typeof c.wordId !== 'string' || !ID.test(c.wordId)) fail('复习记录的词条 ID 不合法。');
    if (!isInt(c.state, 1, 3) || !isNum(c.stability, 0.001, 36500) || !isNum(c.difficulty, 1, 10) || !isInt(c.reps, 1, 1e6) || !isInt(c.lapses, 0, 1e6) || !isInt(c.due, 0, 8.64e15) || !isInt(c.lastReview, 1, 8.64e15)) fail('复习记录数值不合法。');
    return { wordId: c.wordId, state: c.state, stability: c.stability, difficulty: c.difficulty, reps: c.reps, lapses: c.lapses, due: c.due, lastReview: c.lastReview };
  }
  function validDay(key) {
    if (typeof key !== 'string' || !DAY_KEY.test(key)) return false;
    const d = new Date(key + 'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === key && key >= '2000-01-01';
  }
  function day(d, max = LIMITS.delta) {
    exact(d, ['day', ...COUNTERS]);
    if (!validDay(d.day)) fail('学习日期不合法。');
    const out = { day: d.day }; for (const k of COUNTERS) { if (!isInt(d[k], 0, max)) fail('学习统计数值不合法。'); out[k] = d[k]; }
    return out;
  }
  function settings(s) {
    exact(s, ['newPerDay', 'retention', ...(Object.hasOwn(s || {}, 'utcOffsetMinutes') ? ['utcOffsetMinutes'] : [])]);
    if (!isInt(s.newPerDay, 0, MAX_NEW) || !isNum(s.retention, 0.7, 0.99)) fail('复习设置不合法。');
    if (s.utcOffsetMinutes != null && !validOffset(s.utcOffsetMinutes)) fail('UTC/GMT 偏移须为 -12 至 +14 小时内的 15 分钟倍数。');
    return normalizeSettings(s);
  }
  // Lenient reader for settings that come from storage, a backup or a form control. Each field is coerced from a
  // number or numeric string and falls back to its own default when missing, blank, non-numeric or out of range, so
  // the scheduler can never see undefined/NaN. `settings()` above stays strict for what is written to the server.
  const numeric = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
  function normalizeSettings(s) {
    const src = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
    const n = numeric(src.newPerDay), r = numeric(src.retention);
    return { newPerDay: isInt(n, 0, MAX_NEW) ? n : DEFAULTS.newPerDay, retention: isNum(r, 0.7, 0.99) ? r : DEFAULTS.retention, ...(validOffset(src.utcOffsetMinutes) ? { utcOffsetMinutes: src.utcOffsetMinutes } : Object.hasOwn(src, 'utcOffsetMinutes') && src.utcOffsetMinutes === null ? { utcOffsetMinutes: null } : {}) };
  }
  // The optional `review` section of a JSON backup. Older backups simply have none.
  function section(value) {
    // `settings` may be missing or damaged in older/hand-edited backups: it is read leniently, never fatal.
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'settings')) value = { ...value, settings: null };
    exact(value, ['format', 'version', 'settings', 'cards', 'days']);
    if (value.format !== FORMAT || value.version !== VERSION) fail('不支持此复习数据版本；账本部分未受影响。');
    if (!Array.isArray(value.cards) || !Array.isArray(value.days) || value.cards.length > LIMITS.cards || value.days.length > LIMITS.days) fail('复习数据超出上限。');
    const cards = value.cards.map(c => card(c)), days = value.days.map(d => day(d, 1e7));
    if (new Set(cards.map(c => c.wordId)).size !== cards.length || new Set(days.map(d => d.day)).size !== days.length) fail('复习数据存在重复记录。');
    return { format: FORMAT, version: VERSION, settings: normalizeSettings(value.settings), cards, days };
  }
  // A backup is the ledger object plus an optional `review` key. The ledger validator never sees that key.
  function splitBackup(raw) {
    let value;
    try { value = JSON.parse(String(raw).replace(/^﻿/, '')); } catch { return { ledgerRaw: raw, review: null }; }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'review')) return { ledgerRaw: raw, review: null };
    const { review, ...ledger } = value;
    return { ledgerRaw: JSON.stringify(ledger), review: section(review) };
  }

  const pad = n => String(n).padStart(2, '0');
  const dayKey = ms => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const validOffset = v => isInt(v, -720, 840) && v % 15 === 0;
  const statisticsOffset = (ms, opts) => validOffset(opts?.utcOffsetMinutes) ? opts.utcOffsetMinutes : -new Date(ms).getTimezoneOffset();
  const statisticsDay = (ms, opts) => F.keyAt(ms, -statisticsOffset(ms, opts));
  const statisticsStart = (ms, opts) => validOffset(opts?.utcOffsetMinutes) ? Date.parse(statisticsDay(ms, opts) + 'T00:00:00Z') - opts.utcOffsetMinutes * 60000 : F.startOfDay(ms);
  const statisticsEnd = (ms, opts) => validOffset(opts?.utcOffsetMinutes) ? statisticsStart(ms, opts) + 86400000 : endOfToday(ms);
  const offsetLabel = minutes => 'UTC/GMT' + (minutes < 0 ? '-' : '+') + Math.floor(Math.abs(minutes) / 60) + (minutes % 60 ? ':' + pad(Math.abs(minutes) % 60) : '');
  const zero = key => ({ day: key, flips: 0, ratings: 0, lapses: 0, learned: 0, mastered: 0 });
  const endOfToday = now => { const d = new Date(F.startOfDay(now)); d.setDate(d.getDate() + 1); return d.getTime(); };

  // What today's session should hold for one scope: cards due before midnight (oldest first) and new words up to
  // the day's allowance (in entry order). Mastered words have left the schedule; unmarking brings them back as they were.
  function plan({ words, cards, now, settings: opts = DEFAULTS, learnedToday = 0, scope = null }) {
    const end = endOfToday(now), due = [], fresh = [];
    for (const w of words) {
      if (w.mastered || (scope && !scope.has(w.tagId))) continue;
      const c = cards.get(w.id);
      if (!c) fresh.push(w.id); else if (isDue(c, now)) due.push(w.id);
    }
    due.sort((a, b) => cards.get(a).due - cards.get(b).due);
    const allowance = Math.max(0, normalizeSettings(opts).newPerDay - learnedToday);
    return { due, fresh: fresh.slice(0, allowance), freshTotal: fresh.length, allowance };
  }
  // New words are spread among the reviews (one after every three) so a session never ends on a block of unknowns.
  function interleave(due, fresh) {
    const out = [], spread = fresh.slice();
    due.forEach((id, i) => { out.push(id); if ((i + 1) % 3 === 0 && spread.length) out.push(spread.shift()); });
    return out.concat(spread);
  }
  // Due means "on or before today" in the learner's calendar; dates are kept at noon (see curve.js), and older FSRS
  // learning steps due later today count as due too.
  const isDue = (c, now) => c.due < endOfToday(now);
  // 提前巩固: studied, unmastered words that are not due yet, the soonest first. Practising them never moves a date.
  function ahead({ words, cards, now, scope = null, limit = 20 }) {
    const end = endOfToday(now);
    return words.filter(w => !w.mastered && (!scope || scope.has(w.tagId)) && cards.has(w.id) && cards.get(w.id).due >= end)
      .sort((a, b) => cards.get(a.id).due - cards.get(b.id).due).slice(0, limit).map(w => w.id);
  }
  // Where a word stands in memory: four tiers, mutually exclusive, read from stored state only (never from dates,
  // ages or counts). 已掌握 (the ledger's own mark) wins; otherwise a word with no review state was never answered
  // (未学习); a card the curve placed on its 7-day interval is 巩固中; any other answered card is 记忆中. A word
  // forgotten while on the 7-day interval stays there: 忘记 never moves the curve (curve.js), so it stays 巩固中.
  // Legacy FSRS cards (minute steps, or a non-ladder stability) count as 记忆中 until their next 记得 places them.
  const TIERS = Object.freeze(['fresh', 'memorizing', 'consolidating', 'mastered']);
  function stage(word, c) {
    if (word.mastered) return 'mastered';
    if (!c) return 'fresh';
    return F.inLoop(c) ? 'consolidating' : 'memorizing';
  }
  // Every word in scope lands in exactly one tier, counted once by id: the tiers always add up to `total`.
  function distribution(words, cards, scope = null) {
    const out = { fresh: 0, memorizing: 0, consolidating: 0, mastered: 0, total: 0 }, seen = new Set();
    for (const w of words) {
      if ((scope && !scope.has(w.tagId)) || seen.has(w.id)) continue;
      seen.add(w.id); out[stage(w, cards.get(w.id))]++; out.total++;
    }
    return out;
  }
  // Consecutive days with any study, ending today (or yesterday, so a streak is not "lost" before today's session).
  function streak(days, now, opts) {
    const active = key => { const d = days.get(key); return Boolean(d && (d.flips || d.ratings || d.mastered)); };
    let key = statisticsDay(now, opts); if (!active(key)) key = F.addDays(key, -1);
    let n = 0; while (active(key) && n < 3650) { n++; key = F.addDays(key, -1); }
    return n;
  }
  function trend(days, now, n = 30, opts) {
    const out = [], last = statisticsDay(now, opts);
    for (let i = 0; i < n; i++) { const key = F.addDays(last, i - n + 1); out.push({ ...zero(key), ...(days.get(key) || {}) }); }
    return out;
  }
  // Per word, today (distinct words, not answers). Only words still in the ledger count: a deleted word's leftover
  // state never inflates the day. `answered`: rated at least once today (记得 or 忘记). `finished`: answered today and
  // no longer due (a word forgotten today is still waiting). Ratings that changed nothing (提前巩固) leave lastReview
  // as it was, so they count in the day's 作答 events but not here.
  function today(words, cards, now, opts) {
    const start = statisticsStart(now, opts), end = statisticsEnd(now, opts), out = { answered: 0, finished: 0 }, seen = new Set();
    for (const w of words) {
      const c = cards.get(w.id); if (!c || seen.has(w.id) || c.lastReview < start || c.lastReview >= end) continue;
      seen.add(w.id); out.answered++; if (!isDue(c, now)) out.finished++;
    }
    return out;
  }
  const reviewedToday = (cards, now, words = [...cards.keys()].map(id => ({ id }))) => today(words, cards, now).finished;
  // Daily counters roll over at the learner's local midnight (this device's clock and time zone).
  const untilReset = (now, opts) => statisticsEnd(now, opts) - now;
  // The next moment anything in scope becomes due (for the "all done" line).
  function nextDue({ words, cards, scope = null }) {
    let best = Infinity; for (const w of words) { if (w.mastered || (scope && !scope.has(w.tagId))) continue; const c = cards.get(w.id); if (c && c.due < best) best = c.due; }
    return best === Infinity ? null : best;
  }

  // Merge import: the imported words land with ids decided by LedgerModel.merge, which appends them in file order
  // after the existing words. `map` is imported id → merged id; existing states always win for existing words.
  function mergeSection(current, incoming, map) {
    const cards = new Map(current.cards), days = new Map(current.days);
    for (const c of incoming.cards) { const id = map.get(c.wordId); if (id && !cards.has(id)) cards.set(id, { ...c, wordId: id }); }
    // Backups carry aggregates, not event identities: max prevents importing the same history twice.
    for (const d of incoming.days) { const at = days.get(d.day) || zero(d.day); days.set(d.day, Object.fromEntries([['day', d.day], ...COUNTERS.map(k => [k, Math.max(at[k], d[k])])])); }
    return { cards, days, settings: { ...current.settings } };
  }
  function toSection(state, words = null) {
    const keep = words ? new Set(words.map(w => w.id)) : null;
    return { format: FORMAT, version: VERSION, settings: { ...state.settings }, cards: [...state.cards.values()].filter(c => !keep || keep.has(c.wordId)), days: [...state.days.values()].filter(d => COUNTERS.some(k => d[k])).sort((a, b) => a.day.localeCompare(b.day)) };
  }

  // ── Stores ────────────────────────────────────────────────────────────────────────────────────────────────
  // Both keep the whole review state in page memory. A guest's dies with the page (and travels in the JSON backup);
  // the cloud store also queues changes and syncs them in small idempotent batches.
  class LocalState {
    constructor() { this.cards = new Map(); this.days = new Map(); this.settings = { ...DEFAULTS }; this.loaded = false; this.revision = 0; }
    apply({ cards = [], days = [], settings: next = null }) {
      for (const c of cards) { const old = this.cards.get(c.wordId); if (!old || c.lastReview >= old.lastReview) this.cards.set(c.wordId, c); }
      for (const d of days) { const at = this.days.get(d.day) || zero(d.day); this.days.set(d.day, Object.fromEntries([['day', d.day], ...COUNTERS.map(k => [k, at[k] + (d[k] || 0)])])); }
      if (next) this.settings = normalizeSettings({ ...this.settings, ...next });
    }
    reset(sectionValue) {
      this.cards = new Map(sectionValue.cards.map(c => [c.wordId, c])); this.days = new Map(sectionValue.days.map(d => [d.day, d]));
      this.settings = normalizeSettings(sectionValue.settings); this.loaded = true;
    }
    clear() { this.cards = new Map(); this.days = new Map(); this.settings = { ...DEFAULTS }; this.loaded = false; this.revision = 0; }
  }
  class GuestReviewStore extends LocalState {
    constructor({ onChange = () => {} } = {}) { super(); this.settings = normalizeSettings({ ...this.settings, ...preference?.read() }); this.mode = 'guest'; this.loaded = true; this.onChange = onChange; this.status = 'local'; }
    async load() { return null; }
    record(change) { this.apply(change); if (change.settings) preference?.write(this.settings); this.onChange(); }
    async replace(sectionValue) { this.reset(sectionValue); this.loaded = true; this.onChange(); }
    get pending() { return false; }
    flush() { return Promise.resolve(); }
    dispose() { this.clear(); this.onChange = () => {}; }
  }
  class CloudReviewStore extends LocalState {
    constructor(identity, { onAuth = () => {}, onStatus = () => {}, fetcher = (...a) => fetch(...a), random = () => crypto.randomUUID() } = {}) {
      super(); this.mode = 'cloud'; this.identity = identity; this.onAuth = onAuth; this.onStatus = onStatus; this.fetcher = fetcher; this.random = random;
      this.generation = 0; this.queue = { cards: new Map(), days: new Map(), settings: null, events: [] }; this.batch = null; this.flight = null; this.changeSeq = 0; this.loadSeq = 0;
      this.retryTimer = null; this.flushTimer = null; this.failures = 0; this.status = 'synced'; this.controllers = new Set();
    }
    setStatus(status) { if (status !== this.status) { this.status = status; this.onStatus(status); } }
    async request(method, body, keepalive = false) {
      const generation = this.generation, sourceKey = this.identity?.key, c = new AbortController(); if(!keepalive)this.controllers.add(c);
      const timer = setTimeout(() => c.abort(), 30000); let response;
      const auth = message => Object.assign(new ReviewError(message, 'auth'), { sourceKey });
      try {
        const [verb, query = ''] = method.split('?');
        response = await this.fetcher('/api/review' + (query ? '?' + query : ''), { method: verb, credentials: 'same-origin', cache: 'no-store', keepalive, signal: c.signal,
          headers: { 'X-Ledger-Session': this.identity?.key || '', ...(verb === 'POST' ? { 'Content-Type': 'application/json', 'X-Ledger-Request': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      } catch { throw new ReviewError('复习进度暂未同步：连接失败。', 'network'); }
      finally { clearTimeout(timer); this.controllers.delete(c); }
      if (generation !== this.generation) throw auth('会话已结束。');
      if (response.redirected || response.headers.get('content-type')?.includes('text/html')) throw auth('登录已失效。');
      const result = await response.json().catch(() => ({ error: '复习数据无法解析。' }));
      if (generation !== this.generation) throw auth('会话已结束。');
      if (!response.ok) { const error = new ReviewError(result.error || '复习进度同步失败。', response.status === 401 || response.status === 403 ? 'auth' : result.code || 'cloud'); if (error.code === 'auth') error.sourceKey = sourceKey; throw error; }
      return result;
    }
    async load() {
      if (this.pending) return this.error || null;
      const generation = this.generation, seq = ++this.loadSeq, change = this.changeSeq;
      try {
        const result = await this.request('GET');
        if (generation !== this.generation || seq !== this.loadSeq || change !== this.changeSeq || this.pending) return null;
        const fresh = section({ format: FORMAT, version: VERSION, settings: result.settings, cards: result.cards, days: result.days });
        // Changes still waiting to sync stay on top of what the server returned.
        this.reset(fresh); this.revision = result.revision || 0;
        this.error = null; return null;
      } catch (error) { this.error = error; if (error.code === 'auth') this.onAuth(error); return error; }
    }
    // Export reads the complete day history (GET keeps only recent days) and adds anything not yet synced.
    async exportSection(words) {
      await this.flush(); if (this.pending) throw new ReviewError('复习记录尚未确认同步，请先重试，避免导出重复统计。', 'network');
      const result = await this.request('GET?history=all');
      const full = section({ format: FORMAT, version: VERSION, settings: result.settings, cards: result.cards, days: result.days });
      if(this.pending)throw new ReviewError('导出期间又有新复习记录，请同步后重试。','network');
      this.reset(full);this.revision=result.revision||0;
      const merged = new LocalState(); merged.reset(full);
      merged.apply({ cards: [...(this.batch?.cards || []), ...this.queue.cards.values()], days: [...(this.batch?.days || []), ...this.queue.days.values()], settings: this.queue.settings || this.batch?.settings || null });
      return toSection(merged, words);
    }
    record({ cards = [], days = [], settings: next = null, events = [] }) {
      if (!this.loaded) throw new ReviewError('请先读取云端复习进度。');
      this.changeSeq++;
      this.apply({ cards, days, settings: next });
      for (const c of cards) { const old=this.queue.cards.get(c.wordId);if(!old||c.lastReview>=old.lastReview)this.queue.cards.set(c.wordId, c); }
      this.queue.events.push(...events);
      for (const d of days) { const at = this.queue.days.get(d.day) || zero(d.day); this.queue.days.set(d.day, Object.fromEntries([['day', d.day], ...COUNTERS.map(k => [k, at[k] + (d[k] || 0)])])); }
      if (next) this.queue.settings = { ...this.settings };
      this.setStatus('pending'); clearTimeout(this.flushTimer); this.flushTimer = setTimeout(() => this.flush(), 900);
    }
    get pending() { return Boolean(this.batch || this.queue.cards.size || this.queue.days.size || this.queue.settings || this.queue.events.length); }
    take() {
      if (this.batch) return this.batch;
      if (!this.queue.cards.size && !this.queue.days.size && !this.queue.settings && !this.queue.events.length) return null;
      const cards = [...this.queue.cards.values()].slice(0, LIMITS.batch);
      for (const c of cards) this.queue.cards.delete(c.wordId);
      const events = this.queue.events.splice(0, LIMITS.batch);
      this.batch = { action: 'sync', requestId: this.random(), cards: events.length ? [] : cards, ...(!cards.length||events.length?{events}:{}), days: [...this.queue.days.values()].map(d => events.length ? { ...d, ratings: 0, lapses: 0, learned: 0 } : d), ...(this.queue.settings ? { settings: this.queue.settings } : {}) };
      this.queue.days = new Map(); this.queue.settings = null;
      return this.batch;
    }
    // One request in flight; a failed batch is retried unchanged (same requestId), so the server applies it once.
    flush({ keepalive = false } = {}) {
      clearTimeout(this.flushTimer); this.flushTimer = null;
      if (this.flight && !keepalive) return this.flight;
      const batch = this.take(); if (!batch) { this.setStatus('synced'); return Promise.resolve(); }
      if (keepalive) {
        this.request('POST', batch, true).catch(() => {});
        // An in-flight batch and new queued work have different receipts; send both before account disposal.
        const original=this.batch;this.batch=null;
        while(this.pending){const extra=this.take();if(!extra)break;this.request('POST',extra,true).catch(()=>{});this.batch=null;}
        this.batch=original;return Promise.resolve();
      }
      const generation = this.generation;
      clearTimeout(this.retryTimer); this.retryTimer = null;
      this.flight = this.request('POST', batch).then(result => {
        if (generation !== this.generation) return;
        if(result.ok!==true||(batch.events&&!result.data))throw new ReviewError('云端未确认复习保存，请重试。','cloud');
        const acknowledged=result.data?section({format:FORMAT,version:VERSION,cards:result.data.cards,days:result.data.days,settings:result.data.settings}):null;
        if (this.batch === batch) this.batch = null; this.failures = 0; this.flight = null;
        if (result.data) {
          const d=result.data;
          this.reset(acknowledged); this.revision=d.revision||0;
          this.apply({days:[...this.queue.days.values()].map(x=>this.queue.events.length?{...x,ratings:0,lapses:0,learned:0}:x),settings:this.queue.settings});
          if(!this.queue.events.length)this.apply({cards:[...this.queue.cards.values()]});
          for(const e of this.queue.events){const before=this.cards.get(e.wordId),next=F.apply(before||null,e);this.apply({cards:next?[next]:[],days:[{...zero(e.statisticsDay??e.day),ratings:1,lapses:e.grade===1?1:0,learned:before?0:1}]});}
        }
        if (this.pending) return this.flush(); this.setStatus('synced');
      }).catch(error => {
        this.flight = null; if (generation !== this.generation) return;
        if (error.code === 'auth') { this.onAuth(error); return; }
        if (['validation','csrf','conflict'].includes(error.code)) { this.error = error; this.setStatus('error'); return; }
        this.failures++; this.setStatus('offline'); clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.flush(), Math.min(60000, 2000 * 2 ** Math.min(this.failures, 5)));
      });
      return this.flight;
    }
    // Restore/merge: the whole state is replaced in one server batch, after anything queued has been sent.
    async replace(value) {
      await this.flush(); if(this.pending) throw new ReviewError('仍有未同步复习记录，请先重试。','network');
      await this.request('POST', { action: 'replace', requestId: this.random(), expectedRevision: this.revision, settings: value.settings, cards: value.cards, days: value.days });
      this.revision++;
      this.reset(value); this.setStatus('synced');
    }
    dispose() {
      this.generation++; for (const c of this.controllers) c.abort(); this.controllers.clear();
      clearTimeout(this.retryTimer); clearTimeout(this.flushTimer); this.flight = null; this.batch = null;
      this.queue = { cards: new Map(), days: new Map(), settings: null, events: [] }; this.identity = null; this.clear(); this.onAuth = this.onStatus = () => {};
    }
  }

  return Object.freeze({ FORMAT, VERSION, LIMITS, DEFAULTS, NEW_PER_DAY, MAX_NEW, RETENTION, COUNTERS, STURDY_DAYS, ReviewError, card, day, settings, normalizeSettings, section, splitBackup, validDay, dayKey, validOffset, statisticsOffset, statisticsDay, statisticsStart, statisticsEnd, offsetLabel, zero, endOfToday, isDue, plan, interleave, ahead, TIERS, stage, distribution, streak, trend, today, reviewedToday, untilReset, nextDue, mergeSection, toSection, GuestReviewStore, CloudReviewStore });
});
