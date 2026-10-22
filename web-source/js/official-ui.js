(function () {
  'use strict';
  // 官方词汇账本 · browsing UI. One full-height sheet: an index (分类, 查找, the shelf of ledgers) beside a reading sheet
  // (简介, 来源, 词条 with search, 首字母 and pages, 复制到我的账本). Phones show the index, then the opened ledger with a
  // way back. Official ledgers are flat and read-only here; the only write is the copy, which app.js performs through
  // the host it mounts (see app.js → officialUI). Everything shown comes from LedgerOfficial's normalized shapes.
  const O = window.LedgerOfficial, $ = id => document.getElementById(id);
  const dialog = $('official-dialog'), index = $('of-index'), shelf = $('of-shelf'), sheet = $('of-sheet'), cats = $('of-cats'), find = $('of-find'), live = $('of-live');
  const PAGE = 50, KEEP = 4, LETTERS_FROM = 120;
  const narrow = matchMedia('(max-width: 760px)');
  let host = null, catalog = null, catalogTask = null, catalogError = null, category = 'all', current = null, returnFocus = null, generation = 0;
  // Loaded ledgers (most recent last): { entries, skipped, done, error, task, controller, loaded, parts, words, letters }.
  const books = new Map();
  // Copies made in this page for the current account: ledger id → { tagId, name, fresh }.
  const copies = new Map();
  let reading = { query: '', letter: '', page: 1, cache: null };

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  function button(text, cls, fn) { const b = el('button', cls, text); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; }
  const art = id => { const t = $(id); return t ? t.content.firstElementChild.cloneNode(true) : el('span'); };
  const num = n => Number(n).toLocaleString('zh-CN');
  const say = text => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); };
  function enter(node) { node.classList.remove('is-entering'); void node.offsetWidth; node.classList.add('is-entering'); }
  // **bold** pairs, as in the ledger; an unpaired trailing marker stays literal. Only text nodes and <strong>.
  function rich(node, raw) { const parts = raw.split('**'); if (parts.length % 2 === 0) { const last = parts.pop(); parts[parts.length - 1] += '**' + last; } parts.forEach((s, i) => { if (s) node.append(i % 2 ? el('strong', '', s) : document.createTextNode(s)); }); return node; }
  function loading(box, text) { const n = el('div', 'cm-loading'), dots = el('span', 'cm-dots'); n.setAttribute('role', 'status'); dots.setAttribute('aria-hidden', 'true'); dots.append(el('i'), el('i'), el('i')); n.append(dots, el('span', '', text)); box.replaceChildren(n); }
  function failure(box, text, retry) { const n = el('div', 'cm-error'); n.setAttribute('role', 'alert'); n.append(el('p', '', text), button('再试一次', 'quiet', retry)); box.replaceChildren(n); }
  const categoryOf = id => catalog?.categories.find(c => c.id === id);
  const ledgerOf = id => catalog?.ledgers.find(l => l.id === id) || null;
  const icon = d => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'hi'); s.setAttribute('aria-hidden', 'true'); p.setAttribute('class', 'hi-ink'); p.setAttribute('d', d); s.append(p); return s; };
  const CHEVRON = 'M9.6 6.4c1.7 1.9 3.5 3.8 5.4 5.7-1.9 1.8-3.7 3.7-5.5 5.6';

  /* ---------- Frame ---------- */
  function open() {
    if (dialog.open) return;
    returnFocus = document.activeElement; dialog.showModal();
    ensureCatalog();
    if (current && ledgerOf(current)) showBook(current, false); else showShelf(false);
    (current ? sheet.querySelector('.of-book-title') : $('of-title'))?.focus({ preventScroll: true });
  }
  function close() { if (dialog.open) dialog.close(); }
  function setView(view) {
    dialog.dataset.view = view;
    $('of-back').hidden = view !== 'book';
  }
  // 撤销复制 is offered only right after a copy; leaving that ledger or the library settles it.
  const settle = () => { for (const c of copies.values()) c.fresh = false; };
  dialog.addEventListener('close', () => {
    settle();
    // A half-loaded ledger stops downloading; finished ones stay for the next visit.
    for (const [id, b] of books) if (!b.done) { b.controller?.abort(); books.delete(id); }
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
  // Esc on a phone first steps back from a ledger to the shelf, like the back button.
  dialog.addEventListener('cancel', e => { if (narrow.matches && dialog.dataset.view === 'book') { e.preventDefault(); back(); } });
  $('of-close').addEventListener('click', close);
  $('of-back').addEventListener('click', () => back());
  function back() { const from = current; showShelf(true); (shelf.querySelector(`[data-ledger="${CSS.escape(from || '')}"]`) || $('of-title')).focus({ preventScroll: true }); }
  dialog.addEventListener('keydown', e => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing && !e.target.closest('input,textarea,select')) {
      const target = dialog.dataset.view === 'book' || !narrow.matches ? sheet.querySelector('.of-search input') : null;
      const field = target || (find.getClientRects().length ? find : null);
      if (field) { e.preventDefault(); field.focus(); field.select(); }
      return;
    }
    if (e.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button,input,select,a[href],[tabindex="0"]')].filter(n => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
  });

  /* ---------- Catalog and shelf ---------- */
  function ensureCatalog() {
    if (catalog || catalogTask) return catalogTask;
    catalogError = null; loading(shelf, '正在取出官方词库目录…'); cats.replaceChildren(); find.closest('.of-find').hidden = true;
    const g = generation;
    catalogTask = O.source().catalog().then(c => {
      if (g !== generation) return;
      catalog = c; catalogTask = null;
      if (c.problems.length) console.warn('官方词库目录中有条目被跳过：', c.problems);
      renderShelf(); if (!current) renderWelcome();
    }, e => {
      if (g !== generation) return;
      catalogTask = null; catalogError = e;
      failure(shelf, e.message || '暂时取不到官方词库目录。', () => { ensureCatalog(); });
      if (!current) renderWelcome();
    });
    return catalogTask;
  }
  function showShelf(animate) {
    settle(); current = null; setView('shelf');
    if (catalog) renderShelf();
    renderWelcome(); if (animate) enter(index);
  }
  const visibleLedgers = () => {
    const q = O.key(find.value);
    return catalog.ledgers.filter(l => (category === 'all' || l.category === category) && (!q || l.search.includes(q)));
  };
  function renderShelf() {
    const all = catalog.ledgers, frag = document.createDocumentFragment();
    find.closest('.of-find').hidden = all.length < 6;
    // 分类: 全部 plus every shelf, even an empty one (it still says what it will hold).
    const chips = [['all', '全部', all.length], ...catalog.categories.map(c => [c.id, c.name, all.filter(l => l.category === c.id).length])];
    cats.replaceChildren(...chips.map(([id, name, n]) => {
      const b = button('', 'chip' + (n ? '' : ' is-quiet'), () => { if (category === id) return; category = id; renderShelf(); pulseChip(b); });
      b.dataset.category = id; b.setAttribute('aria-pressed', String(category === id)); b.append(el('span', 'chip-label', name), el('span', 'chip-count', String(n))); return b;
    }));
    const list = visibleLedgers();
    if (!all.length && category === 'all') {
      const n = el('div', 'of-shelf-empty'); n.append(el('p', 'of-shelf-note', '官方词库正在整理'), el('p', 'hint', '第一批考试词库校对完成后，会出现在这里。'));
      frag.append(n);
    } else if (!list.length) {
      const c = categoryOf(category), n = el('div', 'of-shelf-empty');
      if (find.value.trim()) n.append(el('p', 'of-shelf-note', '没有找到「' + find.value.trim() + '」'), el('p', 'hint', '试试账本名称、来源或投稿人。'));
      else n.append(el('p', 'of-shelf-note', (c?.name || '这一类') + ' · 即将收录'), el('p', 'hint', c?.description || '整理完成后会出现在这里。'));
      frag.append(n);
    } else {
      const groups = category === 'all' ? catalog.categories.map(c => [c, list.filter(l => l.category === c.id)]).filter(([, ls]) => ls.length) : [[categoryOf(category), list]];
      for (const [c, ls] of groups) {
        if (category === 'all') frag.append(el('p', 'of-shelf-head', c.name));
        const ul = el('ul', 'of-rows');
        for (const l of ls) ul.append(row(l));
        frag.append(ul);
      }
    }
    shelf.replaceChildren(frag);
  }
  function pulseChip(b) { const n = cats.querySelector(`[data-category="${CSS.escape(b.dataset.category)}"]`); if (!n) return; n.classList.remove('is-picked'); void n.offsetWidth; n.classList.add('is-picked'); }
  function row(l) {
    const li = el('li'), b = button('', 'of-row', () => showBook(l.id, true, b));
    b.dataset.ledger = l.id; b.setAttribute('aria-current', String(current === l.id));
    const title = el('span', 'of-row-title', l.title), meta = el('span', 'of-row-meta');
    const count = books.get(l.id)?.done ? books.get(l.id).entries.length : l.count;
    if (l.status === 'preparing') meta.append(el('span', 'of-row-state', '整理中'));
    else if (count != null) meta.append(el('span', 'num', num(count) + ' 条'));
    if (l.source?.name) meta.append(el('span', '', l.source.name));
    else if (l.contributor) meta.append(el('span', '', (l.contributor.kind === 'community' ? '投稿 · ' : '') + l.contributor.name));
    if (copies.has(l.id)) meta.append(el('span', 'of-row-copied', '已复制'));
    b.append(title, meta, icon(CHEVRON)); li.append(b); return li;
  }
  let findTimer = 0;
  find.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => { if (catalog) renderShelf(); }, 90); });
  find.addEventListener('keydown', e => { if (e.key === 'Escape' && find.value && !e.isComposing) { e.preventDefault(); e.stopPropagation(); find.value = ''; if (catalog) renderShelf(); } });

  // The reading sheet before a ledger is opened: what this place is and what each shelf will hold.
  function renderWelcome() {
    if (current) return;
    const box = el('div', 'of-welcome'), text = el('div', 'of-welcome-text');
    sheet.classList.toggle('has-ledgers', Boolean(catalog?.ledgers.length));
    box.append(art('art-official'));
    const empty = !catalog?.ledgers.length;
    text.append(el('h3', 'of-welcome-title', empty ? '官方词库正在整理' : '从左侧挑一本翻开'),
      el('p', 'of-welcome-lede', empty
        ? '这里将收录由词汇账本整理、校对的公共词库：每个词条带词性、释义、双语例句、派生词和备注，并标明来源。第一批考试词库校对完成后就会上架。'
        : '每个词条带词性、释义、双语例句、派生词和备注，并标明来源。官方账本只供浏览，复制一份到「我的账本」后即可自由编辑。'));
    if (catalogError && !catalog) text.append(el('p', 'of-welcome-error', '目录暂时取不到：' + catalogError.message));
    const dl = el('dl', 'of-plan');
    for (const c of catalog?.categories || O.CATEGORIES) {
      const n = catalog ? catalog.ledgers.filter(l => l.category === c.id).length : 0, item = el('div');
      const dt = el('dt'); dt.append(el('span', '', c.name)); if (c.en) { const en = el('span', 'of-plan-en', c.en); en.lang = 'en'; dt.append(en); }
      item.append(dt, el('dd', '', c.description || ''), el('dd', 'of-plan-count', n ? num(n) + ' 本' : '即将收录'));
      dl.append(item);
    }
    const steps = el('ol', 'of-steps');
    for (const [k, v] of [['浏览', '逐条查看释义、例句与派生词'], ['查找', '按英文、中文或首字母定位'], ['复制', '收进我的账本，随意增删与复习']]) { const li = el('li'); li.append(el('b', '', k), el('span', '', v)); steps.append(li); }
    text.append(dl, steps); box.append(text);
    sheet.replaceChildren(box); sheet.scrollTop = 0;
  }

  /* ---------- One ledger ---------- */
  function showBook(id, animate = true, from = null) {
    const l = ledgerOf(id); if (!l) return;
    const switched = current !== id; if (switched) settle(); current = id; setView('book');
    if (switched) reading = { query: '', letter: '', page: 1, cache: null };
    for (const b of shelf.querySelectorAll('.of-row')) b.setAttribute('aria-current', String(b.dataset.ledger === id));
    renderBook(l);
    if (animate) { enter(sheet); sheet.scrollTop = 0; }
    if (from || animate) sheet.querySelector('.of-book-title')?.focus({ preventScroll: true });
    if (l.status === 'ready') load(l);
  }
  function load(l) {
    let b = books.get(l.id);
    if (b && (b.done || b.task)) { books.delete(l.id); books.set(l.id, b); return; }
    b = { entries: [], skipped: 0, done: false, error: null, loaded: 0, parts: l.files.length, controller: new AbortController(), words: null, letters: null };
    books.set(l.id, b);
    // Keep a few finished ledgers in memory; drop the oldest beyond that.
    while ([...books.values()].filter(x => x.done).length > KEEP) { const [old] = [...books].find(([, x]) => x.done); books.delete(old); }
    const g = generation;
    b.task = O.source().entries(l, { signal: b.controller.signal, onChunk: p => { if (books.get(l.id) !== b || g !== generation) return; b.entries = p.entries; b.loaded = p.loaded; b.skipped = p.skipped; reading.cache = null; if (current === l.id) refreshBook(l); } })
      .then(r => { if (books.get(l.id) !== b) return; b.entries = r.entries; b.skipped = r.skipped; r.entries.forEach((e, i) => { e.folio = i + 1; }); b.done = true; b.task = null; reading.cache = null; if (current === l.id) { refreshBook(l); say(`${l.title}：${num(r.entries.length)} 条词条已载入。`); } if (catalog) for (const n of shelf.querySelectorAll(`[data-ledger="${CSS.escape(l.id)}"]`)) n.closest('li').replaceWith(row(l)); })
      .catch(e => { if (books.get(l.id) !== b) return; b.task = null; if (e.name === 'AbortError') { books.delete(l.id); return; } b.error = e; if (current === l.id) refreshBook(l); });
    refreshBook(l);
  }
  function renderBook(l) {
    const c = categoryOf(l.category), box = el('article', 'of-book');
    const head = el('header', 'of-book-head'), kicker = el('p', 'of-book-kicker');
    kicker.append(el('span', '', c?.name || '官方账本'), el('span', '', l.contributor?.kind === 'community' ? '用户投稿 · ' + l.contributor.name : '官方整理' + (l.contributor ? ' · ' + l.contributor.name : '')));
    const title = el('h3', 'of-book-title', l.title); title.tabIndex = -1;
    head.append(kicker, title);
    if (l.summary) head.append(el('p', 'of-book-summary', l.summary));
    if (l.description) {
      const d = el('p', 'of-book-desc preserve-lines', l.description); head.append(d);
      if (l.description.length > 100) { d.classList.add('is-folded'); const more = button('展开简介', 'quiet of-more-desc', () => { const folded = d.classList.toggle('is-folded'); more.textContent = folded ? '展开简介' : '收起简介'; more.setAttribute('aria-expanded', String(!folded)); }); more.setAttribute('aria-expanded', 'false'); head.append(more); }
    }
    const facts = el('dl', 'of-facts');
    const fact = (k, v) => { const d = el('div'); d.append(el('dt', '', k)); const dd = el('dd'); if (v instanceof Node) dd.append(v); else dd.textContent = v; d.append(dd); facts.append(d); return dd; };
    const count = fact('词条', ''); count.className = 'num of-fact-count'; count.textContent = l.count != null ? num(l.count) : '—';
    if (l.source) {
      let v = l.source.name;
      if (l.source.url) { const a = el('a', '', l.source.name); a.href = l.source.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; v = a; }
      fact('来源', v);
      if (l.source.license) fact('授权', l.source.license);
    }
    if (l.version) fact('版本', l.version);
    if (l.updatedAt) fact('更新', l.updatedAt);
    head.append(facts);
    if (l.source?.note) head.append(el('p', 'of-source-note', l.source.note));
    if (l.labels.length) { const tags = el('p', 'of-labels'); for (const t of l.labels) tags.append(el('span', '', t)); head.append(tags); }
    const copy = el('div', 'of-copy'); copy.id = 'of-copy';
    const body = el('div', 'of-entries-area'); body.id = 'of-entries-area';
    box.append(head, copy, body); sheet.replaceChildren(box);
    refreshBook(l);
  }
  // Re-render what depends on loading progress: the count, the copy area and the entries.
  function refreshBook(l) {
    if (current !== l.id || !$('of-entries-area')) return;
    const b = books.get(l.id), area = $('of-entries-area');
    if (b?.done) sheet.querySelector('.of-fact-count').textContent = num(b.entries.length);
    renderCopy(l);
    if (l.status === 'preparing') {
      const n = el('div', 'cm-state of-preparing'); n.append(art('art-closed'), el('p', 'cm-state-title', '词条整理中'), el('p', 'cm-state-text', '这本账本正在校对。接入后即可逐条浏览、查找，并复制到我的账本。'));
      area.replaceChildren(n); return;
    }
    if (!b || (!b.entries.length && !b.done && !b.error)) { ghosts(area); return; }
    if (b.error && !b.entries.length) { failure(area, b.error.message || '词条暂时取不到。', () => { books.delete(l.id); load(l); }); return; }
    if (b.done && !b.entries.length) { const n = el('div', 'cm-state'); n.append(art('art-blank'), el('p', 'cm-state-title', '这本账本还没有词条'), el('p', 'cm-state-text', '整理完成后会出现在这里。')); area.replaceChildren(n); return; }
    renderEntries(l, b);
  }
  function ghosts(area) {
    const ol = el('ol', 'of-entries of-ghosts'); ol.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i++) { const li = el('li', 'cm-ghost of-ghost'); li.append(el('b'), el('i')); ol.append(li); }
    const n = el('div'); n.append(el('p', 'of-loading-note', '正在翻开账本…'), ol); n.firstChild.setAttribute('role', 'status'); area.replaceChildren(n);
  }

  /* ---------- Entries: search, 首字母, pages ---------- */
  function results(b) {
    const k = reading.query + '\u0000' + reading.letter + '\u0000' + b.entries.length;
    if (reading.cache?.key !== k) {
      let list = O.search(b.entries, reading.query);
      if (reading.letter) list = list.filter(e => initial(e) === reading.letter);
      reading.cache = { key: k, list };
    }
    return reading.cache.list;
  }
  const initial = e => { const c = e.lead.normalize('NFD')[0] || ''; return /[a-z]/.test(c) ? c.toUpperCase() : '#'; };
  function renderEntries(l, b) {
    const area = $('of-entries-area');
    let tools = area.querySelector('.of-tools');
    if (!tools) {
      tools = el('div', 'of-tools');
      const wrap = el('div', 'of-search'), label = el('label', 'sr-only', '在这本账本中查找'), field = el('div', 'search-field'), input = el('input');
      const glass = document.querySelector('.search-global .search-field .hi'); if (glass) field.append(glass.cloneNode(true));
      Object.assign(input, { type: 'search', maxLength: 80, placeholder: '查找英文、释义、例句或派生词', autocomplete: 'off', spellcheck: false, id: 'of-entry-search', value: reading.query }); input.setAttribute('enterkeyhint', 'search'); label.htmlFor = input.id;
      field.append(input); wrap.append(label, field);
      const count = el('p', 'of-count'); count.setAttribute('aria-live', 'polite');
      const letters = el('div', 'of-letters'); letters.setAttribute('role', 'group'); letters.setAttribute('aria-label', '按首字母筛选');
      tools.append(wrap, count, letters);
      const list = el('ol', 'of-entries'), pages = el('nav', 'pagination of-pages'); pages.setAttribute('aria-label', '词条分页');
      area.replaceChildren(tools, list, pages);
      let timer = 0, composing = false;
      const apply = () => { reading.query = input.value; reading.page = 1; refreshList(l, b, true); };
      input.addEventListener('compositionstart', () => { composing = true; });
      input.addEventListener('compositionend', () => { composing = false; apply(); });
      // Thousands of entries search in a few milliseconds; a short pause only spares re-rendering on every key.
      input.addEventListener('input', () => { if (composing) return; clearTimeout(timer); timer = setTimeout(apply, b.entries.length > 3000 ? 140 : 60); });
      input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value && !e.isComposing) { e.preventDefault(); e.stopPropagation(); input.value = ''; apply(); } });
      letters.addEventListener('click', e => { const t = e.target.closest('button[data-letter]'); if (!t || t.disabled) return; reading.letter = reading.letter === t.dataset.letter || t.dataset.letter === '' ? '' : t.dataset.letter; reading.page = 1; refreshList(l, b, true); });
      pages.addEventListener('click', e => { const t = e.target.closest('button[data-page]'); if (!t || t.disabled) return; reading.page = Number(t.dataset.page); refreshList(l, b, true); tools.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });
    }
    refreshList(l, b, false);
  }
  function refreshList(l, b, user) {
    const area = $('of-entries-area'); if (!area) return;
    const list = results(b), pages = Math.max(1, Math.ceil(list.length / PAGE)); reading.page = Math.min(Math.max(1, reading.page), pages);
    const total = b.entries.length, filtered = Boolean(reading.query.trim() || reading.letter);
    const countText = (filtered ? `找到 ${num(list.length)} 条 · 共 ${num(total)} 条` : `共 ${num(total)} 条`) + (b.done ? '' : ` · 正在载入 ${b.loaded} / ${b.parts}`) + (b.skipped && b.done ? ` · ${num(b.skipped)} 条格式不完整未显示` : '');
    area.querySelector('.of-count').textContent = countText;
    renderLetters(area.querySelector('.of-letters'), b);
    const ol = area.querySelector('.of-entries'), slice = list.slice((reading.page - 1) * PAGE, reading.page * PAGE);
    if (!slice.length) {
      const n = el('li', 'cm-state cm-state-small of-none'); n.append(art('art-search'), el('p', 'cm-state-title', '没有找到' + (reading.query.trim() ? '「' + reading.query.trim() + '」' : '')), el('p', 'cm-state-text', '换个拼写，或者搜中文释义、例句里的词。'));
      ol.replaceChildren(n);
    } else {
      const frag = document.createDocumentFragment();
      slice.forEach((e, i) => frag.append(entry(e, user && i < 8 ? i : -1)));
      ol.replaceChildren(frag);
    }
    ol.start = 1;
    const nav = area.querySelector('.of-pages');
    nav.hidden = pages <= 1;
    if (pages > 1) {
      const prev = button('上一页', 'quiet'), next = button('下一页', 'quiet'), info = el('span', 'of-page-info num', `${reading.page} / ${pages} 页`);
      prev.dataset.page = reading.page - 1; next.dataset.page = reading.page + 1; prev.disabled = reading.page <= 1; next.disabled = reading.page >= pages;
      nav.replaceChildren(prev, info, next);
    }
    if (user) say(countText);
  }
  function renderLetters(box, b) {
    if (b.entries.length < LETTERS_FROM) { box.hidden = true; return; }
    if (!b.letters || b.letters.size === 0 || !b.done) { b.letters = new Map(); for (const e of b.entries) { const c = initial(e); b.letters.set(c, (b.letters.get(c) || 0) + 1); } }
    box.hidden = false;
    const keys = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...(b.letters.has('#') ? ['#'] : [])];
    const all = button('全部', 'of-letter'); all.dataset.letter = ''; all.setAttribute('aria-pressed', String(!reading.letter));
    box.replaceChildren(all, ...keys.map(k => { const t = button(k, 'of-letter'); t.dataset.letter = k; t.lang = 'en'; t.disabled = !b.letters.has(k); t.setAttribute('aria-pressed', String(reading.letter === k)); t.setAttribute('aria-label', k === '#' ? '其他开头' : k + ' 开头'); return t; }));
  }
  function entry(e, wave) {
    const li = el('li', 'of-entry'); li.dataset.id = e.id; if (wave >= 0) { li.classList.add('is-dealt'); li.style.setProperty('--i', String(wave)); }
    const head = el('div', 'of-entry-head'), folio = el('span', 'of-folio num', String(e.folio || '').padStart(4, '0')), en = el('span', 'of-en', e.english);
    folio.setAttribute('aria-hidden', 'true'); en.lang = 'en'; head.append(folio, en);
    li.append(head);
    if (e.senses.length) for (const s of e.senses) { const p = el('p', 'of-meaning'); if (s.pos) { const t = el('span', 'of-pos', s.pos); t.lang = 'en'; p.append(t, ' '); } p.append(document.createTextNode(s.meaning)); li.append(p); }
    if (e.meaning) {
      const p = el('p', 'of-meaning preserve-lines');
      if (e.pos.length && !e.senses.length) { const pos = el('span', 'of-pos', e.pos.join(' / ')); pos.lang = 'en'; p.append(pos, ' '); }
      p.append(document.createTextNode(e.meaning)); li.append(p);
    }
    for (const x of e.examples) {
      const ex = el('div', 'of-example'), s = rich(el('p', 'of-ex-en preserve-lines'), x.en); s.lang = 'en'; ex.append(s);
      if (x.zh) ex.append(rich(el('p', 'of-ex-zh preserve-lines'), x.zh));
      li.append(ex);
    }
    if (e.derivatives.length) {
      const p = el('p', 'of-derive'); p.append(el('span', 'of-label', '派生'));
      e.derivatives.forEach((d, i) => {
        if (i) p.append(el('span', 'of-sep', ' · '));
        const item = el('span', 'of-derive-item');
        if (d.text) item.textContent = d.text;
        else { const w = el('span', 'of-derive-word', d.word); w.lang = 'en'; item.append(w); if (d.pos) { const t = el('span', 'of-pos', ' ' + d.pos); t.lang = 'en'; item.append(t); } if (d.meaning) item.append(' ' + d.meaning); }
        p.append(item);
      });
      li.append(p);
    }
    if (e.note) { const n = el('p', 'of-note preserve-lines'); n.append(el('span', 'of-label', '备注'), document.createTextNode(e.note)); li.append(n); }
    if (e.source) li.append(el('p', 'of-entry-source', '来源 · ' + e.source));
    return li;
  }

  /* ---------- 复制到我的账本 ---------- */
  function wordsOf(b) { if (!b.words) b.words = O.toWords(b.entries); return b.words; }
  function renderCopy(l) {
    const area = $('of-copy'); if (!area || area.dataset.busy) return;
    const b = books.get(l.id), done = copies.get(l.id);
    if (done && !host?.exists(done.tagId)) copies.delete(l.id);
    if (!l.copyable) { area.replaceChildren(el('p', 'of-copy-note', '这本账本只供浏览，不提供复制。')); return; }
    if (l.status === 'preparing') { area.replaceChildren(el('p', 'of-copy-note', '词条接入后即可复制到我的账本。')); return; }
    if (copies.has(l.id)) { copiedState(area, l, copies.get(l.id)); return; }
    const go = button('', 'primary of-copy-button', () => copy(l)); go.id = 'of-copy-button';
    go.append(copyIcon(), el('span', '', '复制到我的账本'));
    const note = el('p', 'of-copy-note');
    if (!b?.done) { go.disabled = true; note.textContent = b?.error ? '词条没有完整载入，暂不能复制。' : '词条载入完成后即可复制。'; }
    else if (!b.entries.length) { go.disabled = true; note.textContent = '这本账本还没有词条，暂不能复制。'; }
    else {
      const w = wordsOf(b), plan = host?.plan(l.title, w.words.length);
      if (!plan) { go.disabled = true; note.textContent = '页面尚未准备好，请稍候。'; }
      else if (!plan.ready) { go.disabled = true; note.textContent = '云端账本读取完成后即可复制。'; }
      else if (plan.reason) { go.disabled = true; note.textContent = plan.reason; }
      else {
        note.append('将新建独立账本', el('strong', '', '「' + plan.name + '」'), `，收下 ${num(w.words.length)} 条词条` + (w.merged ? `（${num(w.merged)} 个同形词条并入同一条）` : '') + '。');
        note.append(el('span', 'of-copy-mode', plan.mode === 'guest' ? '游客副本只在当前页面内存中，刷新即清空，记得导出 JSON。' : '保存到你的云端账本，可以自由增删与复习；官方原本不会改变。'));
      }
    }
    area.replaceChildren(go, note);
  }
  function copiedState(area, l, done) {
    const n = el('div', 'of-copied' + (done.fresh ? ' is-fresh' : '')), text = el('p', 'of-copied-text');
    text.append('已复制为我的账本', el('strong', '', '「' + done.name + '」'), '。');
    const actions = el('div', 'of-copied-actions');
    const go = button('打开这本账本', 'quiet of-link', () => { close(); host.open(done.tagId); }); go.id = 'of-open-copy';
    actions.append(go);
    if (done.fresh) actions.append(button('撤销复制', 'quiet', () => undo(l, done)));
    else actions.append(button('再复制一份', 'quiet', () => { copies.delete(l.id); renderCopy(l); $('of-copy-button')?.focus(); }));
    n.append(art('art-seal'), text, actions); area.replaceChildren(n);
  }
  function copyIcon() { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'hi'); s.setAttribute('aria-hidden', 'true');
    for (const [c, d] of [['hi-acc', 'M9.6 8.4l9.4-.3.3 10.6-9.5.2z'], ['hi-paper hi-ink', 'M4.6 4.8l9.6-.2.2 10.8-9.6.2z'], ['hi-ink', 'M14.4 9.6l5.2-.1.2 10.6-9.6.2-.1-4.6']]) { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('class', c); p.setAttribute('d', d); s.append(p); } return s; }
  async function copy(l) {
    const area = $('of-copy'), b = books.get(l.id); if (!area || !b?.done || area.dataset.busy) return;
    const go = $('of-copy-button'), g = generation; area.dataset.busy = '1'; go.disabled = true; go.lastChild.textContent = '正在复制…';
    area.querySelector('.of-copy-error')?.remove();
    try {
      const r = await host.copy(l.title, wordsOf(b).words);
      if (g !== generation) return;
      copies.set(l.id, { tagId: r.id, name: r.name, fresh: true });
      delete area.dataset.busy; renderCopy(l); say('已复制为我的账本「' + r.name + '」。');
      $('of-open-copy')?.focus({ preventScroll: true });
      for (const n of shelf.querySelectorAll(`[data-ledger="${CSS.escape(l.id)}"]`)) n.closest('li').replaceWith(row(l));
    } catch (e) {
      if (g !== generation) return;
      delete area.dataset.busy; renderCopy(l);
      const msg = el('p', 'of-copy-error error-text', e?.message || '复制没有完成，你的账本没有改变。'); msg.setAttribute('role', 'alert'); $('of-copy')?.append(msg);
      $('of-copy-button')?.focus({ preventScroll: true });
    }
  }
  async function undo(l, done) {
    const area = $('of-copy'); if (!area || area.dataset.busy) return; area.dataset.busy = '1';
    try { await host.undo(done.tagId); copies.delete(l.id); delete area.dataset.busy; renderCopy(l); say('已撤销复制，那本账本已删除。'); $('of-copy-button')?.focus({ preventScroll: true }); }
    catch (e) { delete area.dataset.busy; const msg = el('p', 'of-copy-error error-text', e?.message || '撤销没有完成。'); msg.setAttribute('role', 'alert'); area.append(msg); }
    for (const n of shelf.querySelectorAll(`[data-ledger="${CSS.escape(l.id)}"]`)) n.closest('li').replaceWith(row(l));
  }

  /* ---------- Wiring ---------- */
  narrow.addEventListener('change', () => { if (dialog.open && !current) renderWelcome(); });
  window.LedgerOfficialUI = {
    mount(h) {
      host = h;
      $('official-open').addEventListener('click', open);
      return {
        open, close,
        // Ledger data changed (a save, a refresh): names and limits in the copy line may have moved.
        refresh() { if (dialog.open && current) { const l = ledgerOf(current); if (l) renderCopy(l); } },
        // Another account: copies made for the previous one are forgotten; the public catalog stays.
        accountChanged() { generation++; copies.clear(); for (const [id, b] of books) if (!b.done) { b.controller?.abort(); books.delete(id); } if (catalogTask) { catalogTask = null; catalog = null; } if (dialog.open) { if (current && ledgerOf(current)) showBook(current, false); else showShelf(false); if (!catalog) ensureCatalog(); } }
      };
    }
  };
})();
