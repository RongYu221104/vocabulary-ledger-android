(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LedgerOfficial = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // 官方词汇账本 · data layer. Pure functions (normalize a catalog and its entries, search, map entries to ledger
  // words, pick a free name) plus a pluggable source that fetches them. The UI (official-ui.js) and the copy into
  // 我的账本 (app.js → importTag) only ever see the normalized shapes below, so a later source — a Worker API, a
  // contributions queue — only has to return the same raw JSON. Raw data is never mutated or written anywhere.
  //
  // Catalog (default /official/catalog.json):
  //   { format: 'vocabulary-ledger-official', version: 1, updatedAt?, categories?: [{ id, name, en?, description?, order? }],
  //     ledgers: [{ id, title, category, summary?, description?, source?: string | { name, url?, license?, note? },
  //                 contributor?: { name, kind: 'official' | 'community' }, labels?: [string], count?, version?, updatedAt?,
  //                 status?: 'ready' | 'preparing', copyable?: boolean, entries?: 'file.json', chunks?: ['a.json', …] }] }
  // Entries file: [entry, …] or { format: 'vocabulary-ledger-official-entries', version: 1, entries: [entry, …] }
  //   entry: { id?, english, pos?: string | [string], meaning, senses?: [{ pos?, meaning }],
  //            examples?: [{ en, zh? }] (or example + translation), derivatives?: [string | { word, pos?, meaning? }],
  //            note?, source? }
  const FORMAT = 'vocabulary-ledger-official', ENTRIES = 'vocabulary-ledger-official-entries', VERSION = 1;
  const CATALOG_URL = '/official/catalog.json';
  // Same caps as the ledger model (lib/model.mjs), so whatever can be shown can also be copied.
  const LIMITS = Object.freeze({ title: 120, english: 200, meaning: 4000, example: 12000, note: 4000, entries: 20000, ledgers: 500, summary: 600, description: 4000, label: 24 });
  // Built-in shelves. A catalog may rename, reorder or add to them; an empty shelf still shows what it will hold.
  const CATEGORIES = Object.freeze([
    { id: 'exam', name: '考试词库', en: 'Exams', description: '四六级、考研、雅思、托福等考试的高频与真题词汇。', order: 1 },
    { id: 'stem', name: '数理词汇', en: 'Math & Science', description: '数学、物理等学科的术语与常用表达，配例句与派生词。', order: 2 },
    { id: 'community', name: '优质投稿', en: 'Contributions', description: '经审核收录的用户账本，标明投稿人与来源。', order: 3 }
  ]);
  class OfficialError extends Error { constructor(message, code = 'data') { super(message); this.name = 'OfficialError'; this.code = code; } }

  const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
  // Text from data files: NFC, \n line ends, no control characters or lone surrogates, trimmed. Never throws.
  function str(value, multiline = false) {
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string') return '';
    let s = value.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(LONE, '');
    if (!multiline) s = s.replace(/\s+/g, ' ');
    return s.replace(/[ \t]+\n/g, '\n').trim();
  }
  const list = value => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]);
  // Search keys ignore case, width (ＡＢＣ), spacing and the **bold** markers examples may carry.
  const key = value => String(value || '').normalize('NFKC').replace(/\*\*/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const ledgerKey = value => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase(); // = LedgerModel.normalize

  function source(value) {
    if (typeof value === 'string') return str(value) ? { name: str(value).slice(0, 200) } : null;
    if (!value || typeof value !== 'object') return null;
    const name = str(value.name).slice(0, 200); if (!name) return null;
    const out = { name };
    const url = str(value.url);
    if (/^https?:\/\/[^\s]+$/i.test(url) && url.length <= 500) out.url = url;
    for (const field of ['license', 'note']) { const v = str(value[field], field === 'note').slice(0, 400); if (v) out[field] = v; }
    return out;
  }
  // Entry files must live on this site (the page CSP allows nothing else) and be JSON.
  function resolve(path, base, origin) {
    if (typeof path !== 'string' || !path || path.length > 300) return null;
    try { const url = new URL(path, base); return url.origin === origin && /\.json$/i.test(url.pathname) ? url.href : null; } catch { return null; }
  }
  function normalizeCategory(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = str(raw.id).toLowerCase(), name = str(raw.name).slice(0, 24); if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || !name) return null;
    return { id, name, en: str(raw.en).slice(0, 40), description: str(raw.description).slice(0, 200), order: Number.isFinite(raw.order) ? raw.order : 100 };
  }
  // A malformed ledger is left out (and reported); it never takes the catalog down with it.
  function normalizeLedger(raw, { base, origin } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OfficialError('账本条目不是对象。');
    const id = str(raw.id);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new OfficialError('账本 ID 不合法：' + (id || '（空）'));
    const title = str(raw.title).slice(0, LIMITS.title); if (!title) throw new OfficialError('账本缺少名称：' + id);
    const category = str(raw.category).toLowerCase() || 'exam';
    const out = { id, title, category, summary: str(raw.summary).slice(0, LIMITS.summary), description: str(raw.description, true).slice(0, LIMITS.description), source: source(raw.source),
      contributor: raw.contributor && typeof raw.contributor === 'object' && str(raw.contributor.name) ? { name: str(raw.contributor.name).slice(0, 60), kind: raw.contributor.kind === 'community' ? 'community' : 'official' } : null,
      labels: list(raw.labels).map(x => str(x).slice(0, LIMITS.label)).filter(Boolean).slice(0, 6),
      count: Number.isSafeInteger(raw.count) && raw.count >= 0 ? raw.count : null, version: str(raw.version).slice(0, 40), updatedAt: str(raw.updatedAt).slice(0, 40),
      copyable: raw.copyable !== false, files: [] };
    const site = origin || (typeof location !== 'undefined' ? location.origin : 'http://localhost'), from = base || site + CATALOG_URL;
    const paths = Array.isArray(raw.chunks) ? raw.chunks : raw.entries ? [raw.entries] : [];
    for (const p of paths.slice(0, 200)) { const url = resolve(p, from, site); if (!url) throw new OfficialError('词条文件路径不合法：' + id); out.files.push(url); }
    // Without entry files a ledger can only be announced (整理中), never opened or copied.
    out.status = out.files.length && raw.status !== 'preparing' ? 'ready' : 'preparing';
    out.search = key([title, out.summary, out.source?.name, out.contributor?.name, ...out.labels].join(' '));
    return out;
  }
  function normalizeCatalog(raw, options = {}) {
    if (raw == null) return { updatedAt: '', categories: CATEGORIES.map(c => ({ ...c })), ledgers: [], problems: [] };
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new OfficialError('词库目录格式不正确。');
    if (raw.format !== undefined && raw.format !== FORMAT) throw new OfficialError('不认识的词库目录格式。');
    if (raw.version !== undefined && (!Number.isInteger(raw.version) || raw.version > VERSION)) throw new OfficialError('词库目录版本较新，请刷新页面后再试。', 'version');
    const categories = new Map(CATEGORIES.map(c => [c.id, { ...c }]));
    for (const c of list(raw.categories).map(normalizeCategory).filter(Boolean)) categories.set(c.id, { ...categories.get(c.id), ...c, description: c.description || categories.get(c.id)?.description || '', en: c.en || categories.get(c.id)?.en || '' });
    const ledgers = [], problems = [], seen = new Set();
    for (const item of list(raw.ledgers).slice(0, LIMITS.ledgers)) {
      try {
        const l = normalizeLedger(item, options);
        if (seen.has(l.id)) throw new OfficialError('账本 ID 重复：' + l.id);
        seen.add(l.id);
        if (!categories.has(l.category)) categories.set(l.category, { id: l.category, name: l.category, en: '', description: '', order: 200 });
        ledgers.push(l);
      } catch (e) { problems.push(e.message); }
    }
    return { updatedAt: str(raw.updatedAt).slice(0, 40), categories: [...categories.values()].sort((a, b) => a.order - b.order), ledgers, problems };
  }

  function derivative(value) {
    if (typeof value === 'string') { const text = str(value); return text ? { text } : null; }
    if (!value || typeof value !== 'object') return null;
    const word = str(value.word || value.english); if (!word) return null;
    return { word, pos: str(value.pos), meaning: str(value.meaning) };
  }
  const derivativeText = d => d.text || [d.word, d.pos, d.meaning].filter(Boolean).join(' ');
  // Accepts the documented shape plus a few common spellings, so a word list made elsewhere needs no rewrite.
  function normalizeEntry(raw, index = 0, ledgerId = 'official') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const english = str(raw.english ?? raw.word ?? raw.headword);
    if (!english || english.length > LIMITS.english || !/[a-zA-Z]/.test(english)) return null;
    const pos = list(raw.pos ?? raw.partOfSpeech).map(x => str(x)).filter(Boolean);
    const senses = list(raw.senses).map(s => (s && typeof s === 'object' ? { pos: str(s.pos), meaning: str(s.meaning ?? s.definition, true) } : null)).filter(s => s?.meaning);
    const meaning = str(raw.meaning ?? raw.definition ?? raw.zh, true);
    if (!meaning && !senses.length) return null;
    const examples = list(raw.examples).map(x => (typeof x === 'string' ? { en: str(x, true), zh: '' } : x && typeof x === 'object' ? { en: str(x.en ?? x.sentence ?? x.english, true), zh: str(x.zh ?? x.translation ?? x.chinese, true) } : null)).filter(x => x?.en);
    const single = str(raw.example ?? raw.exampleSentence, true);
    if (single) examples.unshift({ en: single, zh: str(raw.translation ?? raw.exampleTranslation, true) });
    const derivatives = list(raw.derivatives ?? raw.derived ?? raw.derivations).flatMap(d => (typeof d === 'string' ? d.split(/[;；\n]/) : [d])).map(derivative).filter(Boolean).slice(0, 40);
    const entry = { id: str(raw.id).slice(0, 80) || ledgerId + ':' + index, english, pos, senses, meaning, examples: examples.slice(0, 12), derivatives, note: str(raw.note ?? raw.notes ?? raw.remark, true), source: str(raw.source).slice(0, 200) };
    entry.lead = key(english);
    entry.text = key([meaning, ...senses.map(s => s.pos + ' ' + s.meaning), ...pos, ...examples.flatMap(x => [x.en, x.zh]), ...derivatives.map(derivativeText), entry.note, entry.source].join('\n'));
    return entry;
  }
  function normalizeEntries(raw, ledgerId = 'official', offset = 0) {
    let items = raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (raw.format !== undefined && raw.format !== ENTRIES) throw new OfficialError('不认识的词条文件格式。');
      if (raw.version !== undefined && (!Number.isInteger(raw.version) || raw.version > VERSION)) throw new OfficialError('词条文件版本较新，请刷新页面后再试。', 'version');
      items = raw.entries;
    }
    if (!Array.isArray(items)) throw new OfficialError('词条文件格式不正确。');
    const entries = []; let skipped = 0;
    items.forEach((x, i) => { const e = normalizeEntry(x, offset + i, ledgerId); if (e) entries.push(e); else skipped++; });
    return { entries, skipped };
  }

  // Ranked search over thousands of entries without an index: headword exact → prefix → word start → anywhere,
  // then meanings, examples, derivatives and notes. Ties keep the ledger's own order.
  function search(entries, query) {
    const q = key(query); if (!q) return entries;
    const hits = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i], at = e.lead.indexOf(q);
      const rank = at === 0 ? (e.lead.length === q.length ? 0 : 1) : at > 0 ? (/[\s\-'(/]/.test(e.lead[at - 1]) ? 2 : 3) : e.text.includes(q) ? 4 : -1;
      if (rank >= 0) hits.push(rank * 1e6 + i);
    }
    hits.sort((a, b) => a - b);
    return hits.map(h => entries[h % 1e6]);
  }

  // Cut to a ledger field's cap without splitting a surrogate pair (the model rejects a lone half).
  const clip = (text, max) => (text.length > max ? text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : text);
  // One official entry → the fields of a ledger word. 词性 joins the meaning, 派生词 and 来源 join the note. Entries
  // that share a headword become one word (a ledger keeps each English form once per 账本), their parts in order.
  function toWords(entries) {
    const byKey = new Map(), order = []; let clipped = 0, merged = 0;
    for (const e of entries) {
      const k = ledgerKey(e.english);
      const senses = e.senses.length ? e.senses.map(s => [s.pos, s.meaning].filter(Boolean).join(' ')) : [[e.pos.join(' / '), e.meaning].filter(Boolean).join(' ')];
      const notes = [];
      if (e.derivatives.length) notes.push('派生：' + e.derivatives.map(derivativeText).join('；'));
      if (e.note) notes.push(e.note);
      if (e.source) notes.push('来源：' + e.source);
      const part = { meaning: senses.join('\n'), en: e.examples.map(x => x.en), zh: e.examples.map(x => x.zh), note: notes.join('\n') };
      if (byKey.has(k)) { merged++; byKey.get(k).parts.push(part); } else { const w = { english: e.english, parts: [part] }; byKey.set(k, w); order.push(w); }
    }
    const words = order.map(w => {
      const join = (field, max) => { const text = w.parts.map(p => p[field]).filter(Boolean).join('\n'); if (text.length > max) clipped++; return clip(text, max); };
      // A translation only stays with its sentence: a ledger word cannot carry a translation without one.
      const en = w.parts.flatMap(p => p.en).join('\n'), zh = w.parts.flatMap(p => p.zh);
      if (en.length > LIMITS.example) clipped++;
      const exampleSentence = clip(en, LIMITS.example), exampleTranslation = exampleSentence && zh.some(Boolean) ? clip(zh.join('\n').trim(), LIMITS.example) : '';
      return { english: w.english, meaning: join('meaning', LIMITS.meaning), exampleSentence, exampleTranslation, note: join('note', LIMITS.note) };
    });
    return { words, merged, clipped };
  }
  // A free ledger name: the title itself, then 「标题 · 副本 2」, 「· 副本 3」…, never longer than a ledger name may be.
  function freeName(title, names) {
    const taken = new Set([...names].map(ledgerKey)), base = clip(title, LIMITS.title);
    if (!taken.has(ledgerKey(base))) return base;
    for (let n = 2; n < 10000; n++) { const tail = ' · 副本 ' + n, name = clip(title, LIMITS.title - tail.length) + tail; if (!taken.has(ledgerKey(name))) return name; }
    throw new OfficialError('同名账本过多，请先整理后再复制。');
  }

  // ── Source ─────────────────────────────────────────────────────────────────────────────────────────────
  // The default source reads static JSON from this site. Swap it with useSource({ catalog, entries }) — same raw shapes.
  async function getJson(url, signal, optional = false) {
    let response;
    try { response = await fetch(url, { credentials: 'same-origin', cache: 'no-cache', signal, headers: { Accept: 'application/json' } }); }
    catch (e) { if (e.name === 'AbortError') throw e; throw new OfficialError('连不上词库，检查网络后再试一次。', 'network'); }
    if (optional && (response.status === 404 || response.status === 410)) return null;
    if (!response.ok) throw new OfficialError('词库暂时取不到（' + response.status + '），稍后再试。', 'network');
    if (!/json/i.test(response.headers.get('content-type') || '')) { if (optional) return null; throw new OfficialError('词库文件格式不正确。'); }
    try { return await response.json(); } catch { throw new OfficialError('词库文件损坏，暂时无法读取。'); }
  }
  function staticSource(url = CATALOG_URL) {
    return {
      async catalog({ signal } = {}) {
        const href = new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost/').href;
        return normalizeCatalog(await getJson(href, signal, true), { base: href, origin: new URL(href).origin });
      },
      // Keep at most four chunks in flight. Consume in catalog order so entry IDs, sorting and progress stay stable.
      async entries(ledger, { signal, onChunk } = {}) {
        const all = []; let skipped = 0;
        const pending = new Map(); let next = 0;
        const preload = () => {
          while (next < ledger.files.length && pending.size < 4) {
            const index = next++;
            // Attach rejection handlers immediately: a later chunk may fail before the first chunk finishes.
            pending.set(index, getJson(ledger.files[index], signal).then(value => ({ value }), error => ({ error })));
          }
        };
        preload();
        for (let i = 0; i < ledger.files.length; i++) {
          const result = await pending.get(i); pending.delete(i);
          if (result.error) throw result.error;
          preload();
          const part = normalizeEntries(result.value, ledger.id, all.length + skipped);
          const room = LIMITS.entries - all.length; all.push(...part.entries.slice(0, room)); skipped += part.skipped + Math.max(0, part.entries.length - room);
          onChunk?.({ entries: all, loaded: i + 1, parts: ledger.files.length, skipped });
        }
        return { entries: all, skipped };
      }
    };
  }
  let current = staticSource();
  return { FORMAT, ENTRIES, VERSION, CATALOG_URL, LIMITS, CATEGORIES, OfficialError,
    normalizeCatalog, normalizeLedger, normalizeEntry, normalizeEntries, search, toWords, freeName, key, staticSource,
    source: () => current, useSource(next) { current = next || staticSource(); } };
});
