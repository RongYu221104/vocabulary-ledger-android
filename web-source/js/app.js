(function () {
  'use strict';
  const M = window.LedgerModel, S = window.LedgerCloud, O = window.LedgerOrder, G = window.LedgerGroups, R = window.LedgerReview;
  const $ = id => document.getElementById(id);
  let store = new S.GuestStore(), identity = null, accountGeneration = 0, leaving = false, authExported = false, mergeImport = null;
  const sessionGate = new S.SessionGate(), PRIVACY_AFTER_MS = 5 * 60 * 1000;
  let awaySince = null, awayTimer = null, resumeTimer = null, automaticRefresh = null, privacyReturnFocus = null;
  let identityChannel = null;
  try { identityChannel = new BroadcastChannel('cet-ledger-session-v1'); } catch { /* Focus checks still work without channel support. */ }
  function notifyIdentityInvalidation() { try { identityChannel?.postMessage({ type: 'invalidate' }); } catch { /* A closed channel never blocks local cleanup. */ } }
  function setIdentityGuard(show, message = '', restore = true) {
    const guard = $('identity-guard');
    if (show) {
      document.body.classList.add('identity-check');
      if (!guard.open) { privacyReturnFocus = document.activeElement; guard.hidden = false; guard.showModal(); }
      $('identity-guard-title').textContent = message ? '暂时无法确认登录状态' : '正在确认登录状态';
      $('identity-guard-message').textContent = message || '离开较久，暂时收起私人内容。确认后会恢复原位置和输入。';
      $('identity-retry').hidden = !message; guard.classList.toggle('is-failed', Boolean(message));
      if (message) $('identity-retry').focus({ preventScroll: true });
    } else {
      document.body.classList.remove('identity-check');
      if (guard.open) guard.close(); guard.hidden = true;
      if (restore && privacyReturnFocus?.isConnected && privacyReturnFocus.getClientRects().length) privacyReturnFocus.focus({ preventScroll: true });
      privacyReturnFocus = null;
    }
  }
  function cancelIdentityWork() {
    sessionGate.invalidate(); clearTimeout(resumeTimer); clearTimeout(awayTimer);
    resumeTimer = awayTimer = null; awaySince = null; automaticRefresh = null;
  }
  if (identityChannel) identityChannel.onmessage = event => {
    // A notification only revokes cached state; it never supplies or authenticates an identity.
    if (event.data?.type !== 'invalidate') return;
    if (store.mode === 'cloud') { clearAccount(); feedback('其他标签页的登录状态已变化，旧账号数据已清理。'); }
    else { cancelIdentityWork(); accountGeneration++; }
  };
  // `view` is what the workspace shows: a 主账本 with a filter over its 分组 ({ master, filter, sub? }), or one
  // independent ledger ({ tag }); see groups.js.
  let data = M.empty(), hasData = false, view = null, page = 1, edit = null, confirmation = null;
  let groupCache = { data: null, org: null, labels: null };
  // Smart review progress (js/review.js): one store per account, beside the ledger store. A guest's lives in page
  // memory and travels in the JSON backup; a cloud account's syncs to /api/review in small idempotent batches.
  const guestReview = () => new R.GuestReviewStore({ onChange: () => { if (store.mode === 'guest') store.dirty = true; } });
  let reviewStore = guestReview(), reviewStamp = 0, reviewUI = null, reviewTick=null;
  let officialUI = null, officialAccount = -1;
  function cloudReview(owner) {
    return new R.CloudReviewStore(owner, { onAuth: error => authFailure(error), onStatus: () => { reviewStamp++; updateReviewEntry(); reviewUI?.refresh(); } });
  }
  function ledgers() {
    if (groupCache.data !== data) {
      const org = G.organize(data.tags, data.structure), labels = new Map();
      for (const m of org.masters) for (const x of m.subs) labels.set(x.tag.id, G.subLabel(m, x));
      groupCache = { data, org, labels };
    }
    return groupCache.org;
  }
  const viewTags = () => G.viewTags(ledgers(), view);
  const currentMaster = () => (view?.master ? ledgers().byKey.get(view.master) || null : null);
  // As before the 主账本 mapping, a fresh load opens where the most recently dated ledger lives.
  function defaultView() {
    const org = ledgers(), recent = M.sortedTags(data)[0];
    if (!recent) return org.masters.length ? G.all(org.masters[0]) : null;
    const own = G.viewOf(org, recent.id);
    return own.master ? G.all(org.byKey.get(own.master)) : own;
  }
  // A filter keeps only 分类项 that still exist (a 分组 may have been edited on another device).
  function ensureView() {
    const org = ledgers(); if (!G.valid(org, view)) { view = defaultView(); return; }
    if (!view.master) return;
    const master = org.byKey.get(view.master), filter = G.filterOf(view), next = {}; let changed = !view.filter;
    for (const gid of Object.keys(filter)) {
      const group = master.groups.find(g => g.id === gid), ids = group ? filter[gid].filter(id => group.items.some(i => i.id === id)) : [];
      if (ids.length !== filter[gid].length) changed = true; if (ids.length) next[gid] = ids;
    }
    if (changed) view = { master: view.master, filter: next, ...(view.sub ? { sub: view.sub } : {}) };
  }
  const PAGE_SIZE = 60;
  function originLabel(tag) {
    const p=tag.sharing?.provenance;if(!p)return '';
    return '来自 '+p.originalName+(p.sharerName!==p.originalName?' · 分享者 '+p.sharerName:'')+(p.verified?'':' · 备份来源未验证');
  }
  let feedbackTimer = null, feedbackSequence = 0, feedbackRemaining = 0, feedbackDeadline = 0;
  let editorReturnFocus = null, confirmReturnFocus = null;
  let emphasis = null, emphasisTag = null, listMotion = null, cloudLoading = false, arriving = false;
  // Display order is page-only state. Entry numbers come from creation order and never from screen position.
  let sortMode = 'asc', shuffleRanks = null, orderCache = { data: null, ranks: null, folios: null };
  function ordering() {
    if (orderCache.data !== data) { const ranks = O.creationRanks(data.words); orderCache = { data, ranks, folios: O.folios(data.words, ranks) }; }
    return orderCache;
  }
  const folioLabel = id => '词条 ' + String(ordering().folios.get(id)).padStart(2, '0');
  const SORT_NAMES = { asc: '正序', desc: '倒序', az: 'A–Z', za: 'Z–A', shuffle: '乱序' };
  // Composer disclosure is page-only UI state: first visit to a ledger opens it only when the ledger is empty,
  // then the user's own choice wins until reload. Nothing is persisted.
  const composerOpen = new Map(), reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let composerShown = null, composerTimer = null, composerMotion = null;
  const later = ms => new Promise(resolve => setTimeout(resolve, reducedMotion.matches ? 0 : ms));
  // Restart a one-shot CSS animation class on an element.
  const pulseTimers = new WeakMap();
  function pulse(el, className, ms = 400) {
    let timers = pulseTimers.get(el); if (!timers) { timers = new Map(); pulseTimers.set(el, timers); }
    clearTimeout(timers.get(className)); el.classList.remove(className); void el.offsetWidth; el.classList.add(className);
    timers.set(className, setTimeout(() => { el.classList.remove(className); timers.delete(className); }, ms));
  }
  const ENTRY_FIELDS = ['word-input','meaning-input','word-example','word-translation','word-note'];
  const entryDraft = () => ENTRY_FIELDS.some(id => $(id).value.trim());
  function updateDraftBadge() { $('composer-draft').hidden = composerShown !== false || !entryDraft(); }
  function setComposer(open, animate = false) {
    if (open === composerShown) { updateDraftBadge(); return; }
    const form = $('add-form'), motion = animate && !reducedMotion.matches && composerShown !== null;
    // Capture the displayed height before cancelling an interrupted glide, so a reversal stays continuous.
    const fromHeight = form.hidden ? 0 : form.getBoundingClientRect().height;
    composerShown = open; clearTimeout(composerTimer);
    // A closing animation must not leave hidden inputs in the keyboard tab order.
    form.inert = !open;
    $('composer-toggle').setAttribute('aria-expanded', String(open)); $('composer').classList.toggle('is-open', open);
    form.classList.remove('is-opening', 'is-closing'); composerMotion?.cancel(); composerMotion = null;
    // The band's height is animated here (auto heights cannot transition in CSS), so the list below glides.
    const glide = (from, to, ms, fill = 'none') => typeof form.animate === 'function' ? form.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: ms, easing: 'cubic-bezier(.22,.8,.25,1)', fill }) : null;
    if (open) {
      form.hidden = false; autosizeAll();
      if (motion) { void form.offsetWidth; form.classList.add('is-opening'); composerMotion = glide(fromHeight, form.offsetHeight, 260); composerTimer = setTimeout(() => { form.classList.remove('is-opening'); composerMotion = null; }, 320); }
    }
    else if (motion) { composerMotion = glide(fromHeight, 0, 170, 'forwards'); form.classList.add('is-closing'); composerTimer = setTimeout(() => { form.hidden = true; form.classList.remove('is-closing'); composerMotion?.cancel(); composerMotion = null; }, 170); }
    else form.hidden = true;
    updateDraftBadge();
  }
  reducedMotion.addEventListener('change', () => {
    if (!reducedMotion.matches) return;
    clearTimeout(composerTimer); composerMotion?.cancel(); composerMotion = null;
    const form = $('add-form'); form.classList.remove('is-opening', 'is-closing'); form.hidden = composerShown === false;
  });
  // Composer textareas start one line tall (matching the English input) and grow with their content up to the
  // CSS max-height, after which they scroll. Hidden fields measure 0 and keep their CSS height. Measure with the
  // scrollbar off: on the collapsed one-row box it narrows the text, which then wraps into an extra line that would
  // stay behind as blank space at the bottom once the grown box drops the scrollbar.
  function autosize(area) {
    area.style.overflowY = 'hidden'; area.style.height = '';
    if (area.scrollHeight > area.clientHeight) area.style.height = area.scrollHeight + area.offsetHeight - area.clientHeight + 'px';
    area.style.overflowY = area.scrollHeight > area.clientHeight ? '' : 'hidden';
  }
  const autosizeAll = () => document.querySelectorAll('textarea[data-autosize]').forEach(autosize);
  function syncComposer(key, total) {
    if (!composerOpen.has(key)) composerOpen.set(key, total === 0);
    setComposer(composerOpen.get(key));
  }
  // YY-MM-N-Type, e.g. 2023 / 12 / 1 / Cloze -> 23-12-1-Cloze. Only a naming aid; the result is a plain tag name.
  function examTitle(year, month, set, type) {
    if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month) || !type) return '';
    if (!/^[1-9]\d{0,2}$/.test(set)) return '';
    return year.slice(-2) + '-' + month + '-' + Number(set) + '-' + type;
  }
  // Example bold is stored as paired **…** markers inside the existing text fields (no schema change).
  // An unpaired trailing ** stays literal. Rendering only ever creates text nodes and <strong> elements.
  function boldRuns(raw) {
    const marks = []; for (let i = raw.indexOf('**'); i !== -1; i = raw.indexOf('**', i + 2)) marks.push(i);
    if (marks.length % 2) marks.pop();
    const plain = [], bold = [], map = []; let m = 0, on = false;
    for (let i = 0; i <= raw.length;) {
      map[i] = plain.length;
      if (i === marks[m]) { map[i + 1] = plain.length; on = !on; m++; i += 2; continue; }
      if (i === raw.length) break;
      plain.push(raw[i]); bold.push(on); i++;
    }
    return { plain, bold, map };
  }
  function serializeRuns(plain, bold) {
    let out = '', on = false; const start = [], end = [];
    for (let p = 0; p <= plain.length; p++) {
      const next = p < plain.length && bold[p]; end[p] = out.length;
      if (next !== on) { out += '**'; on = next; }
      start[p] = out.length; if (p < plain.length) out += plain[p];
    }
    return { out, start, end };
  }
  function richText(element, raw) {
    const { plain, bold } = boldRuns(raw);
    for (let i = 0; i < plain.length;) {
      let j = i; while (j < plain.length && bold[j] === bold[i]) j++;
      const chunk = plain.slice(i, j).join('');
      element.append(bold[i] ? node('strong', '', chunk) : document.createTextNode(chunk)); i = j;
    }
    return element;
  }
  function toggleBold(area) {
    const r = boldRuns(area.value), n = r.plain.length;
    let s = r.map[area.selectionStart], e = r.map[area.selectionEnd];
    while (s < e && /\s/.test(r.plain[s])) s++;
    while (e > s && /\s/.test(r.plain[e - 1])) e--;
    if (s === e) {
      // A caret inside bold text removes that bold run; otherwise there is nothing to format.
      const at = r.bold[s] ? s : s > 0 && r.bold[s - 1] ? s - 1 : -1;
      if (at < 0) { feedback('先选中要加粗的文字。'); return; }
      s = at; e = at; while (s > 0 && r.bold[s - 1]) s--; while (e < n && r.bold[e]) e++;
      r.bold.fill(false, s, e);
    } else r.bold.fill(!r.bold.slice(s, e).every(Boolean), s, e);
    const next = serializeRuns(r.plain, r.bold);
    area.value = next.out; area.setSelectionRange(next.start[s], next.end[e]);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const RICH_FIELDS = ['word-example','word-translation','edit-example','edit-translation'];
  function updatePreview(id) {
    const preview = document.querySelector(`[data-preview="${id}"]`), raw = $(id).value;
    preview.replaceChildren(); preview.hidden = !boldRuns(raw).bold.includes(true);
    if (!preview.hidden) richText(preview, raw);
  }
  const updatePreviews = () => RICH_FIELDS.forEach(updatePreview);
  function emphasizeWord(id, kind) {
    emphasis = { id, kind };
    render();
    emphasis = null;
  }
  function node(tag, className, value) {
    const el = document.createElement(tag); if (className) el.className = className;
    if (value !== undefined) el.textContent = value; return el;
  }
  function pauseFeedback() {
    if (feedbackTimer !== null) {
      clearTimeout(feedbackTimer); feedbackTimer = null;
      feedbackRemaining = Math.max(0, feedbackDeadline - Date.now());
    }
  }
  function resumeFeedback() {
    if (!$('feedback').classList.contains('is-visible') || document.hidden || !document.hasFocus() || $('feedback').matches(':hover') || feedbackTimer !== null) return;
    feedbackDeadline = Date.now() + feedbackRemaining;
    feedbackTimer = setTimeout(() => {
      feedbackTimer = null; feedbackRemaining = 0;
      $('feedback').classList.remove('is-visible');
    }, feedbackRemaining);
  }
  function feedback(message, error = false) {
    const toast = $('feedback'), sequence = ++feedbackSequence;
    clearTimeout(feedbackTimer); feedbackTimer = null;
    toast.classList.toggle('error', error); toast.textContent = '';
    toast.classList.toggle('is-visible', Boolean(message));
    if (!message) { feedbackRemaining = 0; return; }
    // Update an already-visible polite live region in a new frame, including repeated messages.
    requestAnimationFrame(() => {
      if (sequence !== feedbackSequence) return;
      toast.textContent = message; feedbackRemaining = error ? 9000 : 3600; resumeFeedback();
    });
  }
  const drafts = () => entryDraft() || $('editor-dialog').open;
  // The header status chip only reflects messages from the existing save flow; it never decides persistence.
  function syncState(message) {
    if (/失败|冲突|需要刷新/.test(message)) return 'error';
    // A guest ledger never talks to the cloud, so it never shows the connecting animation.
    if (store.mode==='guest') return 'guest';
    if (/中…|正在/.test(message)) return 'busy';
    return 'ok';
  }
  function status(message) {
    const text = message || (store.mode==='guest' ? '游客账本 · 仅当前页面内存' : '已保存到云端');
    const chip = $('sync-state'), before = chip.dataset.state, state = syncState(text);
    $('save-status').textContent = text; chip.dataset.state = state;
    if (before !== state && (state === 'ok' || state === 'error')) pulse(chip, 'is-settled', 1000);
    $('reload-button').classList.toggle('is-urgent', state === 'error');
  }
  // The full loading panel only covers the first cloud read (or a retry while nothing is loaded yet).
  function loadingPanel(state, title, hint) {
    cloudLoading = state === 'loading'; const panel = $('cloud-loading');
    panel.hidden = !state; panel.dataset.state = state || 'loading';
    if (state) { $('cloud-loading-title').textContent = title; $('cloud-loading-hint').textContent = hint; $('loading-retry').hidden = state !== 'error'; }
    document.body.classList.toggle('is-cloud-loading', cloudLoading);
  }
  function renderAccount() {
    const cloud=store.mode==='cloud', name=cloud?(identity?.displayName||'ChatGPT 用户'):'游客 · 未登录'; $('mode-label').textContent=cloud?'个人云端':'游客模式';
    $('account-name').textContent=name; $('account-name').title=cloud?name:'';
    $('sign-in').hidden=cloud; $('sign-out').hidden=!cloud;
    $('guest-notice').hidden=cloud; $('reload-button').hidden=!cloud;
    window.LedgerSharing?.accountChanged(cloud ? identity : null);
    window.LedgerCommunity?.accountChanged(cloud ? identity : null);
  }
  function clearAccount(announce = false) {
    cancelIdentityWork();
    window.LedgerSharing?.clear();
    window.LedgerCommunity?.clear();
    accountGeneration++; store.dispose(); store=new S.GuestStore(); identity=null; data=M.empty(); hasData=true;
    view=null;page=1;edit=null;confirmation=null;mergeImport=null;editorReturnFocus=null;confirmReturnFocus=null;emphasis=null;emphasisTag=null;listMotion=null;
    sortMode='asc';shuffleRanks=null;$('sort-order').value='asc';loadingPanel(null);
    groupCache = { data: null, org: null }; orderCache = { data: null, ranks: null, folios: null };
    composerOpen.clear();setComposer(false);
    reviewStore.dispose(); reviewStore = guestReview(); reviewStamp++;
    // Another account's dialog must vanish at once, never fade out.
    reviewUI.close({ instant: true });
    gm=null;setMore(false);
    for(const id of ['editor-dialog','confirm-dialog','auth-dialog','facet-sheet','groups-dialog'])if($(id).open){$(id).classList.add('is-instant');$(id).close();requestAnimationFrame(()=>requestAnimationFrame(()=>$(id).classList.remove('is-instant')));}
    $('add-form').reset(); $('editor-form').reset(); updatePreviews();
    examGenerated = ''; nameIsAuto = true;
    for(const id of ['global-search','local-search'])$(id).value='';
    $('word-list').replaceChildren();$('current-name').textContent='';$('current-date').textContent='';$('current-scope').textContent='';$('current-origin').textContent='';$('current-origin').hidden=true;
    for(const id of ['sub-picker','composer-target','facet-sheet-body','groups-body','membership-groups'])$(id).replaceChildren();$('facet-badge').hidden=true;
    $('current-stats').replaceChildren();$('current-progress').setAttribute('aria-valuenow','0');$('current-progress').setAttribute('aria-valuetext','');$('current-progress-fill').style.width='0%';
    for(const id of ['confirm-description','confirm-title','confirm-error','editor-title','editor-error','auth-description','auth-error','results-title','result-count','page-info','sub-empty-text','sub-empty-create','exam-preview'])$(id).textContent='';
    $('status-filter').value='all';feedback('');
    warning(null);status();renderAccount();render();
    setIdentityGuard(false, '', false);
    if (announce) notifyIdentityInvalidation();
  }
  function warning(message) {
    $('storage-warning').hidden = !message; $('storage-message').textContent = message || '';
    document.body.classList.toggle('has-storage-warning', Boolean(message));
    if (message) status('保存失败 · 需要重新读取或重试');
  }
  function authFailure(error) {
    if(error?.code!=='auth')return false;
    // Ignore a late failure from a disposed account; never clear a newer guest/session.
    if(store.mode==='cloud' && identity?.key===error.sourceKey){clearAccount(true);feedback('登录状态已变化，旧账号数据已清理。请重新登录读取个人账本。',true);}
    return true;
  }
  async function load() {
    hasData=true;renderAccount();render();status();
    const loadingAccount = accountGeneration;
    try { const next = await sessionGate.check(); if (loadingAccount !== accountGeneration) return; identity = next; }
    catch(error) { if (loadingAccount === accountGeneration && error.code !== 'stale') feedback(error.message,true); return; }
    if(!identity.authenticated)return;
    // Retain guest work entered while identity was resolving.
    if(store.dirty||drafts()){feedback('已检测到 ChatGPT 登录。请先导出游客账本，再点登录进入个人云端。');return;}
    store.dispose();store=new S.Store(identity);reviewStore.dispose();reviewStore=cloudReview(identity);reviewStamp++;const generation=++accountGeneration;renderAccount();status('正在读取个人云端账本…');
    hasData=false;loadingPanel('loading','正在连接你的云端账本','词条读取完成后会自动显示，请稍候。');render();
    const result = await store.load(); if(generation!==accountGeneration||authFailure(result.failure))return;hasData = result.data !== null;
    data = result.data || M.empty(); view = defaultView(); page = 1;
    loadingPanel(result.error?'error':null,'云端账本读取失败',result.error||'');
    warning(result.error); if (!result.error) status('已连接个人云端 · 记录自动保存');
    render();
    // Review progress loads after the ledger is on screen; a failure only leaves the counts empty until a retry.
    if (!result.error) { const review = reviewStore; review.load().then(() => { if (review === reviewStore) { reviewStamp++; updateReviewEntry(); reviewUI.refresh(); } }); }
    if (document.hidden || !document.hasFocus()) identityAway();
  }
  function statList(target, values) {
    const fragment = document.createDocumentFragment();
    for (const [label, value] of values) { const box = node('div', String(value).length >= 5 ? 'stat-long' : ''); box.append(node('dt', '', label), node('dd', '', String(value))); fragment.append(box); }
    target.replaceChildren(fragment);
  }
  // Exactly one tag in view: a custom ledger, or a 主账本 selection that resolves to a single 子账本.
  function currentTag() { const tags = viewTags(); return tags.length === 1 ? tags[0] : null; }
  function globalMode() { return Boolean($('global-search').value.trim()); }
  const subLabel = tag => { ledgers(); return groupCache.labels.get(tag.id) || tag.name; };
  function aggregate(counts, tags) {
    let total = 0, mastered = 0; for (const t of tags) { const s = counts.get(t.id); total += s.total; mastered += s.mastered; }
    return { total, mastered, unmastered: total - mastered, percent: total ? Math.round(mastered / total * 100) : 0 };
  }
  function ledgerCard(className, label, sub, meta, current) {
    const button = node('button', 'tag-card ' + className + (current && arriving ? ' is-arriving' : '')); button.type = 'button'; button.setAttribute('aria-current', String(current));
    const entry = node('span', 'tag-entry'), index = node('span', 'tag-index', String(++ledgerCard.n).padStart(2, '0')); index.setAttribute('aria-hidden', 'true');
    entry.append(index, node('span', 'tag-name', label)); button.append(entry);
    if (sub) button.append(node('span', 'tag-sub', sub));
    const line = node('span', 'tag-meta'); line.append(...meta.map(text => node('span', '', text))); button.append(line);
    return button;
  }
  function renderLedgers(org, counts) {
    const fragment = document.createDocumentFragment(); ledgerCard.n = 0;
    if (org.masters.length && org.customs.length) fragment.append(node('p', 'tag-section', '主账本'));
    for (const m of org.masters) {
      const s = aggregate(counts, m.subs.map(x => x.tag)), own = m.kind === 'custom', extra = own ? m.groups.length : m.groups.length - 2;
      const card = ledgerCard('master-card' + (own ? ' is-own' : ''), G.display(m), G.caption(m) + (extra > 0 ? ` · ${extra} 个${own ? '' : '自定义'}分组` : ''), [`${s.total} 条`, `已掌握 ${s.mastered} · ${s.percent}%`], view?.master === m.key);
      card.dataset.master = m.key; if (!own) card.querySelector('.tag-name').lang = 'en';
      // Screen readers (and search-by-name) still hear every 子账本 name inside its 主账本.
      if (m.subs.length) card.append(node('span', 'sr-only', '，含 ' + m.subs.map(x => x.tag.name).join('、')));
      const origins=[...new Set(m.subs.map(x=>originLabel(x.tag)).filter(Boolean))];
      if(origins.length)card.append(node('span','ledger-origin',origins.join(' · ')));
      if (emphasisTag && m.subs.some(x => x.tag.id === emphasisTag)) card.classList.add('tag-added');
      fragment.append(card);
    }
    if (org.masters.length && org.customs.length) fragment.append(node('p', 'tag-section', '独立账本'));
    for (const tag of org.customs) {
      const s = counts.get(tag.id), card = ledgerCard('custom-card', tag.name, '', [tag.date, `${s.total} 条 · 已掌握 ${s.mastered} · ${s.percent}%`], view?.tag === tag.id);
      card.dataset.tagId = tag.id; if(originLabel(tag))card.append(node('span','ledger-origin',originLabel(tag))); if (emphasisTag === tag.id) card.classList.add('tag-added'); fragment.append(card);
    }
    if (!data.tags.length) fragment.append(node('p', 'empty', cloudLoading ? '正在读取云端账本…' : !$('cloud-loading').hidden ? '暂时无法读取账本。' : '还没有账本，点击“新增账本”开始。'));
    $('tag-list').replaceChildren(fragment);
  }
  function chip(label, pressed, value, count, empty, lang) {
    const button = node('button', 'chip' + (empty ? ' is-empty' : '')); button.type = 'button'; button.dataset.value = String(value);
    button.setAttribute('aria-pressed', String(pressed)); const text = node('span', 'chip-label', label); if (lang) text.lang = lang;
    button.append(text, node('span', 'chip-count', String(count))); return button;
  }
  // 分组 filter over the current 主账本. Up to two groups (three on wide screens) show as rows of index tabs: a tap
  // shows one 分类项, Ctrl / ⌘ / Shift-click adds more of the same group, 全部 clears it. More groups fold into one
  // strip of summary pills. Every pill and 「筛选」 opens the multi-select sheet. Each tab counts the words it would
  // show given the other groups' choices.
  const facetWide = matchMedia('(min-width: 861px)');
  const facetMode = master => (master.groups.length <= (facetWide.matches ? 3 : 2) ? 'rows' : 'pills');
  const subsFor = (master, filter) => master.subs.filter(x => G.matches(x, filter));
  const wordsFor = (master, filter, counts) => subsFor(master, filter).reduce((n, x) => n + counts.get(x.tag.id).total, 0);
  // 套题 / 题型 tabs keep their old values (1, Cloze …); stored 分类项 use their ids.
  const chipValue = (group, item) => (group.id === 'set' ? String(item.value) : group.id === 'type' ? item.value : item.id);
  function facetChips(master, group, filter, counts, toggle) {
    const others = { ...filter }; delete others[group.id];
    const chosen = filter[group.id] || [], out = [chip(group.derived && !toggle ? '全部' + group.name : '全部', !chosen.length, 'all', wordsFor(master, others, counts), false)];
    for (const item of group.items) {
      const only = { ...others, [group.id]: [item.id] };
      const c = chip(item.name, chosen.includes(item.id), chipValue(group, item), wordsFor(master, only, counts), !subsFor(master, only).length, item.lang);
      c.dataset.item = item.id; if (toggle) c.classList.add('is-toggle'); out.push(c);
    }
    return out;
  }
  function renderFacets(master, counts) {
    const picker = $('sub-picker'), filter = G.filterOf(view), mode = facetMode(master), active = Object.values(filter).reduce((n, ids) => n + ids.length, 0);
    const frag = document.createDocumentFragment(); picker.dataset.mode = master.groups.length ? mode : 'none';
    if (!master.groups.length) frag.append(node('p', 'facet-empty', master.subs.length ? '还没有分组 · 用标题旁的「分组」建立难度、课程等分类后即可交叉筛选' : '还没有子账本 · 用标题旁的「子账本」新建第一本'));
    else if (mode === 'rows') for (const g of master.groups) {
      const row = node('div', 'picker-row'), label = node('span', 'picker-label', g.name); label.setAttribute('aria-hidden', 'true');
      const rail = node('div', 'chip-rail'); rail.id = g.id === 'set' ? 'set-chips' : g.id === 'type' ? 'type-chips' : 'facet-' + g.id;
      rail.setAttribute('role', 'group'); rail.setAttribute('aria-label', g.name); rail.dataset.group = g.id;
      rail.append(...facetChips(master, g, filter, counts, false)); row.append(label, rail); frag.append(row);
    }
    else {
      const strip = node('div', 'facet-pills');
      for (const g of master.groups) {
        const names = (filter[g.id] || []).map(id => g.items.find(i => i.id === id)?.name).filter(Boolean);
        const pill = node('button', 'facet-pill' + (names.length ? ' is-active' : '')); pill.type = 'button'; pill.dataset.group = g.id; pill.setAttribute('aria-haspopup', 'dialog');
        pill.setAttribute('aria-label', `${g.name}：${names.length ? names.join('、') : '全部'}。打开筛选`);
        pill.append(node('span', 'facet-pill-name', g.name), node('span', 'facet-pill-value', names.length ? names[0] + (names.length > 1 ? ' +' + (names.length - 1) : '') : '全部'));
        strip.append(pill);
      }
      frag.append(strip);
    }
    picker.replaceChildren(frag);
    $('facet-open').hidden = !master.groups.length;
    $('facet-badge').hidden = !active; $('facet-badge').textContent = String(active);
    $('facet-open').setAttribute('aria-label', active ? `筛选子账本，已选 ${active} 项` : '筛选子账本');
    if ($('facet-sheet').open) renderFacetSheet();
  }
  // 录入到: a multi-子账本 view asks which 子账本 a new entry belongs to; a single one needs no choice.
  function renderTarget(tags) {
    const select = $('composer-target'), keep = select.value;
    $('composer-target-wrap').hidden = tags.length < 2;
    if (tags.length < 2) { select.replaceChildren(); return; }
    select.replaceChildren(...tags.map(t => { const option = node('option', '', subLabel(t)); option.value = t.id; return option; }));
    select.value = tags.some(t => t.id === keep) ? keep : tags[0].id;
  }
  const targetTag = () => { const tags = viewTags(); return tags.length === 1 ? tags[0].id : $('composer-target').value; };
  function render() {
    window.LedgerSharing?.update(data,store.mode==='cloud' ? identity : null);
    ensureView();
    const org = ledgers(), all = M.stats(data.words), counts = M.tagStats(data);
    statList($('global-stats'), [['账本总数', data.tags.length], ['词条总数', all.total], ['已掌握', all.mastered], ['整体掌握率', all.percent + '%']]);
    renderLedgers(org, counts);
    const tags = viewTags(), single = currentTag(), global = globalMode(), master = view?.master ? org.byKey.get(view.master) : null;
    $('workspace').classList.toggle('is-global', global); $('ledger-bar').classList.toggle('is-global', global);
    $('ledger-bar').hidden = !view && !global;
    $('tag-content').hidden = !view || global; $('welcome').hidden = Boolean(view) || global || !$('cloud-loading').hidden;
    $('results-area').hidden = !view && !global; $('local-search-wrap').hidden = global; $('clear-global').hidden = !global;
    $('sub-picker').hidden = global || !master; $('ledger-bar').classList.toggle('has-picker', !global && Boolean(master));
    $('master-tools').hidden = global || !master;
    if (global) { $('current-date').textContent = '跨全部账本'; $('current-name').textContent = '全局搜索结果'; $('current-scope').hidden = true; document.querySelector('.title-tools').hidden = true; $('facet-open').hidden = true; }
    else if (view) {
      const s = aggregate(counts, tags), filter = G.filterOf(view), narrowed = Boolean(view.sub) || Object.values(filter).some(ids => ids.length), exact = Boolean(master) && narrowed && Boolean(single);
      $('current-name').textContent = single ? single.name : G.display(master);
      const masterLine = master ? ['主账本 ' + G.display(master), master.kind === 'exam' ? G.masterTitle(master.year + '-' + master.month) : '自定义'].filter(Boolean).join(' · ') : '';
      $('current-date').textContent = master ? masterLine + (single ? ' · 录入日期 ' + single.date : ` · ${master.subs.length} 个子账本`) : '录入日期 ' + single.date;
      $('current-origin').textContent = [...new Set(tags.map(originLabel).filter(Boolean))].join(' · ');
      $('current-origin').hidden = !$('current-origin').textContent;
      $('current-scope').hidden = !master || exact; $('current-scope').textContent = master ? G.label(view, master) + (tags.length ? ` · ${tags.length} 个子账本` : ' · 尚未建立') : '';
      $('local-search').placeholder = master ? `在「${G.display(master)}」中搜索` : '在本账本中搜索';
      statList($('current-stats'), [['词条', s.total], ['已掌握', s.mastered], ['未掌握', s.unmastered], ['掌握率', s.percent + '%']]);
      syncComposer(G.key(view), s.total);
      $('current-progress').setAttribute('aria-valuenow', String(s.percent));
      $('current-progress').setAttribute('aria-valuetext', `已掌握 ${s.mastered} / ${s.total} 条，${s.percent}%`);
      $('current-progress-fill').style.width = s.percent + '%';
      // Rename/delete act on one stored ledger only, so they sit beside the title when the view is exactly one.
      $('edit-tag').hidden = !single; $('delete-tag').hidden = !single; document.querySelector('.title-tools').hidden = !single;
      if (master) renderFacets(master, counts); else $('facet-open').hidden = true;
      renderTarget(tags);
      $('composer').hidden = !tags.length; $('sub-empty').hidden = tags.length > 0;
      if (!tags.length) {
        const plan = master && emptyPlan(master);
        $('sub-empty-text').textContent = narrowed ? `「${G.label(view, master)}」还没有子账本。` : `「${G.display(master)}」还没有子账本。`;
        $('sub-empty-create').textContent = plan ? '新增子账本 ' + plan.name : '新增子账本…';
      }
    }
    document.querySelector('.progress-block').hidden = global || !view;
    $('export-button').disabled = !hasData;
    // Nothing can be written before the first cloud read finishes.
    $('new-tag').disabled = cloudLoading; $('add-sub').disabled = cloudLoading; $('groups-manage').disabled = cloudLoading;
    // The phone's folded sort/status menu still shows that a filter or non-default order is in effect.
    $('bar-tools-toggle').classList.toggle('is-active', $('status-filter').value !== 'all' || sortMode !== 'asc');
    if (view || global) renderWords(global, tags);
    updateReviewEntry(); reviewUI?.refresh();
    if (officialUI) { if (officialAccount !== accountGeneration) { officialAccount = accountGeneration; officialUI.accountChanged(); } else officialUI.refresh(); }
    layoutBar();
  }
  const ICONS = {
    edit: [['hi-acc', 'M5.3 18.7l.8-3.5 2.7 2.7z'], ['hi-ink', 'M5.3 18.7l.8-3.5 9.6-9.6c.8-.8 2-.8 2.8 0l.1.1c.8.8.8 2 0 2.8l-9.6 9.5z'], ['hi-ink hi-thin', 'M13.9 7.4l2.9 2.9']],
    delete: [['hi-ink', 'M6.6 6.9c3.6 3.3 7 6.8 10.6 10.5M17.2 6.6c-3.3 3.7-6.8 7.2-10.4 10.6']]
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); svg.classList.add('hi');
    for (const [className, d] of ICONS[name]) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('class', className); path.setAttribute('d', d); svg.append(path); }
    return svg;
  }
  function iconButton(className, action, label, tip, name) {
    const button = node('button', 'icon-action ' + className); button.type = 'button'; button.dataset.action = action; button.setAttribute('aria-label', label);
    const bubble = node('span', 'act-tip', tip); bubble.setAttribute('aria-hidden', 'true');
    button.append(icon(name), bubble); return button;
  }
  function visibleWords(global, tags) {
    const ids = global ? null : new Set(tags.map(t => t.id));
    const words = M.findWords(data, { query: global ? $('global-search').value : $('local-search').value, filter: $('status-filter').value, includeExamples: !global }).filter(w => !ids || ids.has(w.tagId));
    return O.sortWords(words, sortMode, ordering().ranks, shuffleRanks);
  }
  // Keep a freshly added entry on screen whichever order is active.
  function pageOf(id) {
    if (!view || globalMode()) return 1;
    const index = visibleWords(false, viewTags()).findIndex(w => w.id === id);
    return index < 0 ? page : Math.floor(index / PAGE_SIZE) + 1;
  }
  function renderWords(global, viewList) {
    const words = visibleWords(global, viewList);
    const pages = Math.max(1, Math.ceil(words.length / PAGE_SIZE)); page = Math.min(page, pages);
    $('results-title').textContent = global ? '全局搜索结果' : '词条记录';
    const count = `找到 ${words.length} 条 · ${SORT_NAMES[sortMode]}`;
    if ($('result-count').textContent !== count) { $('result-count').textContent = count; pulse($('result-count'), 'is-updated', 320); }
    $('reshuffle').hidden = sortMode !== 'shuffle';
    // Global results and multi-子账本 views label each card with where it lives; a single ledger needs no label.
    const fragment = document.createDocumentFragment(), tags = new Map(data.tags.map(t => [t.id, t])), mixed = !global && viewList.length > 1;
    let wave = 0;
    for (const w of words.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)) {
      const row = node('article', 'word-row' + (w.mastered ? ' is-mastered' : '')); row.dataset.wordId = w.id;
      if (emphasis?.id === w.id) row.classList.add('word-' + emphasis.kind);
      if (listMotion) { row.classList.add('word-' + listMotion); if (wave < 10) row.dataset.wave = String(wave++); }
      const rail = node('div', 'word-rail');
      const checkLabel = node('label', 'word-check'), checkbox = node('input');
      checkbox.type = 'checkbox'; checkbox.checked = w.mastered; checkbox.dataset.action = 'toggle'; checkbox.setAttribute('aria-label', '已掌握：' + w.english);
      const checkTip = node('span', 'act-tip', w.mastered ? '已掌握 · 点击取消' : '标记为已掌握'); checkTip.setAttribute('aria-hidden', 'true');
      checkLabel.append(checkbox, checkTip);
      rail.append(checkLabel);
      const content = node('div', 'word-content');
      const head = node('div', 'word-head'), title = node('div', 'word-title');
      const english = node('h3', 'word-english', w.english); english.lang = 'en';
      title.append(node('span', 'word-folio', folioLabel(w.id)), english);
      if (mixed) title.append(node('span', 'word-sub', subLabel(tags.get(w.tagId))));
      head.append(title, node('p', 'word-meaning', w.meaning)); content.append(head);
      if (w.exampleSentence.trim()) { const example=node('div','word-example'); example.append(node('p','narration-label','例句')); const en=richText(node('p','example-sentence'),w.exampleSentence); en.lang='en'; example.append(en); if(w.exampleTranslation.trim()) example.append(richText(node('p','example-translation'),w.exampleTranslation)); content.append(example); }
      // 备注 is a quiet margin line; a blank note leaves no trace (as on the flashcard back).
      if ((w.note || '').trim()) { const note = node('div', 'word-note'); note.append(node('p', 'note-label', '备注'), node('p', 'note-text', w.note)); content.append(note); }
      if (global) { const tag = tags.get(w.tagId), link = node('button', 'word-tag', tag.name + ' · ' + tag.date); link.type = 'button'; link.dataset.action = 'openTag'; link.dataset.tagId = w.tagId; content.append(link); }
      // The line closes with its tools; keyboard order stays tick → edit → delete.
      const tools = node('div', 'word-tools');
      tools.append(iconButton('word-edit', 'edit', '编辑 ' + w.english, '编辑词条', 'edit'), iconButton('word-delete', 'delete', '删除 ' + w.english, '删除词条', 'delete'));
      row.append(rail, content, tools); fragment.append(row);
    }
    listMotion = null;
    const filtered = global || $('local-search').value.trim() || $('status-filter').value !== 'all';
    const list = $('word-list');
    if (!words.length) {
      const kind = filtered ? 'search' : 'blank', text = filtered ? '没有符合搜索或筛选条件的词条。请调整条件。' : !viewList.length ? '先建立子账本，再录入词条。' : '这本账本还没有词条。在上方「录入词条」中添加第一条。';
      // While the list stays empty (e.g. typing a search with no hits) the drawing is kept, so it is drawn only once.
      const shown = list.children.length === 1 && list.firstElementChild.dataset.art === kind ? list.firstElementChild : null;
      if (shown) shown.lastElementChild.textContent = text;
      else { const empty = node('p', 'empty'); empty.dataset.art = kind; empty.append($('art-' + kind).content.cloneNode(true), node('span', 'empty-text', text)); list.replaceChildren(empty); }
    } else list.replaceChildren(fragment);
    $('page-info').textContent = `${page} / ${pages} 页 · 每页 ${PAGE_SIZE} 条`;
    $('page-prev').disabled = page <= 1; $('page-next').disabled = page >= pages;
  }
  let busy=false, mutationGeneration=0;
  async function saving(fn) {
    if(busy) throw new S.StorageError('正在保存，请稍候。');
    busy=true; mutationGeneration++; document.body.classList.add('is-saving'); status(store.mode==='guest'?'正在更新游客账本…':'保存中…');
    const controls=[...document.querySelectorAll('button,input,textarea,select')].map(el=>({el,disabled:el.disabled}));
    for(const {el} of controls)el.disabled=true;
    try { const result=await fn(); warning(null); status(); return result; }
    catch(error) { if(!authFailure(error)){warning(error.message);status(error.code==='conflict'?'需要刷新 · 版本冲突':'保存失败 · 输入已保留');}throw error; }
    finally { busy=false; document.body.classList.remove('is-saving'); for(const {el,disabled} of controls)if(el.isConnected)el.disabled=disabled; }
  }
  async function commit(action,payload) {
    const mastery=action==='toggleWord',before=mastery&&data.words.find(w=>w.id===payload.id)?.mastered;
    if(action==='addTag'){
      const master=view?.master&&ledgers().byKey.get(view.master),exam=G.parse(payload.name);
      if(master?.imported&&exam&&exam.year===master.year&&exam.month===master.month)payload={...payload,container:{key:master.key,label:master.label,year:master.year,month:master.month,set:exam.set,type:exam.type}};
    }
    const next=M.mutate(data,action,payload);
    data=await saving(()=>store.save(next,{action,payload:mastery&&store.mode==='cloud'?{...payload,reviewDay:R.statisticsDay(Date.now(),reviewStore.settings)}:payload})); hasData=true;
    if(mastery){
      if(store.mode==='cloud'){if(!reviewStore.pending)await reviewStore.load();}
      else if(before!==payload.mastered){const key=R.statisticsDay(Date.now(),reviewStore.settings),id=key+':'+payload.id;reviewStore.masteries??=new Set();const active=reviewStore.masteries.has(id);if(payload.mastered&&!active){reviewStore.masteries.add(id);reviewStore.record({days:[{...R.zero(key),mastered:1}]});}else if(!payload.mastered&&active){reviewStore.masteries.delete(id);const d=reviewStore.days.get(key);if(d)d.mastered=Math.max(0,d.mastered-1);store.dirty=true;}}
      reviewStamp++;updateReviewEntry();
    }
  }
  function report(error) {
    if(authFailure(error))return;
    feedback(error.message, true);
    if (error instanceof S.StorageError) warning(error.message);
    if(error.code==='conflict')status('需要刷新 · 版本冲突，输入已保留');
  }
  // Moving to another 主账本 or custom ledger is a ledger switch (drafts are confirmed, local search resets);
  // narrowing 套题/题型 inside one 主账本 is only a filter, so drafts and the search stay.
  const ledgerOf = v => (v ? v.master || 't:' + v.tag : '');
  function selectView(next, focusLedger = false, resetSearch = false) {
    if (!next) return;
    if (ledgerOf(next) !== ledgerOf(view) && entryDraft()) {
      confirmAction('切换账本', '「录入词条」中有尚未添加的内容。切换后将清空这些输入。是否继续？', '清空输入并切换', () => { $('add-form').reset(); applyView(next, focusLedger, resetSearch); });
      return;
    }
    applyView(next, focusLedger, resetSearch);
  }
  function applyView(next, focusLedger, resetSearch) {
    const switched = Boolean(view) && ledgerOf(next) !== ledgerOf(view);
    if (resetSearch || ledgerOf(next) !== ledgerOf(view)) $('local-search').value = '';
    // Opening another ledger is a page turn: its mark slides in, the heading re-inks, entries are dealt in
    // and the directory's ribbon swings. Narrowing 套题/题型 stays a quiet filter.
    if (switched && !reducedMotion.matches) { arriving = true; listMotion = 'dealt'; }
    const pinned = $('ledger-bar').classList.contains('is-stuck');
    view = next; $('global-search').value = ''; page = 1; feedback(''); render(); arriving = false;
    // Narrowing the view from the pinned dock shortens the list: bring its heading back just under the dock instead
    // of leaving the reader scrolled into empty space below a shorter page.
    if (pinned) { const gap = $('results-title').getBoundingClientRect().top - $('bar-dock').getBoundingClientRect().bottom - 8; if (gap < 0) window.scrollBy(0, gap); }
    if (switched && !reducedMotion.matches) { pulse(document.querySelector('.current-title'), 'is-switching', 460); pulse($('ledger-ribbon'), 'is-swaying', 1100); }
    if (focusLedger) ledgerButton(next)?.focus({ preventScroll: true });
  }
  const ledgerButton = v => v && [...$('tag-list').children].find(el => (v.master ? el.dataset.master === v.master : el.dataset.tagId === v.tag));
  function rememberFocus() {
    const element = document.activeElement;
    return { element, wordId: element.closest('[data-word-id]')?.dataset.wordId, action: element.dataset.action, tagId: element.closest('[data-tag-id]')?.dataset.tagId, master: element.closest('[data-master]')?.dataset.master };
  }
  function returnFocus(saved) {
    if (!saved || $('editor-dialog').open || $('confirm-dialog').open) return;
    let target = saved.element;
    if (!target.isConnected || !target.getClientRects().length) {
      const row = [...$('word-list').children].find(el => el.dataset.wordId === saved.wordId);
      target = row && [...row.querySelectorAll('button')].find(el => el.dataset.action === saved.action);
      if (!target && (saved.tagId || saved.master)) target = ledgerButton(saved.master ? { master: saved.master } : { tag: saved.tagId });
    }
    (target && target.getClientRects().length ? target : view ? $('workspace') : $('new-tag')).focus({ preventScroll: true });
  }
  // 新增账本 chooses a kind (exam 子账本 / new 主账本 / independent ledger); 「+ 子账本」 ({ sub: true }) works inside the
  // current 主账本 (the exam picker is pre-filled for exam ones); editing a 子账本 also edits where it belongs.
  function openEditor(kind, item = null, preset = null) {
    editorReturnFocus = rememberFocus();
    edit = { kind, item: item ? M.clone(item) : null, revision:data.revision, mode: 'tag', sub: Boolean(preset?.sub), memberItems: new Set(), suggested: '' }; $('editor-error').textContent = '';
    $('tag-fields').hidden = kind === 'word'; $('word-fields').hidden = kind !== 'word';
    $('editor-title').textContent = kind === 'word' ? '编辑词条' : item ? '编辑账本' : edit.sub ? '新增子账本' : '新增账本';
    if (kind === 'word') { $('edit-english').value = item.english; $('edit-meaning').value = item.meaning; $('edit-example').value=item.exampleSentence; $('edit-translation').value=item.exampleTranslation; $('edit-note').value=item.note||''; }
    else {
      const master = edit.sub ? currentMaster() : null, choosing = !item && !edit.sub;
      $('tag-name').value = item?.name || ''; $('tag-date').value = item?.date || M.today();
      $('tag-kind').hidden = !choosing; showBasics(true); $('master-fields').hidden = true;
      if (choosing) { $('master-name').value = ''; $('master-groups').value = ''; $('preset-set').checked = $('preset-type').checked = true; $('preset-generate').checked = false; updateGenerate(); }
      resetExam(choosing || (edit.sub && master?.kind === 'exam'), edit.sub ? subPreset() : null);
      if (choosing) setKind('exam');
      renderMembership(item, master); suggestName();
    }
    $('editor-tip').hidden = kind !== 'word'; updatePreviews();
    $('editor-dialog').showModal(); (kind === 'word' ? $('edit-english') : $('tag-name')).focus();
  }
  // ── 子账本 placement ─────────────────────────────────────────────────────────────────────────────────────
  // Membership lives in data.structure; a 子账本 is always the same stored tag wherever it is classified.
  const newId = () => crypto.randomUUID();
  function membershipOf(tagId) {
    for (const m of data.structure?.masters || []) { const r = m.members.find(x => x.tag === tagId); if (r) return new Set(r.items); }
    return new Set();
  }
  function showBasics(on) { for (const id of ['tag-name', 'tag-date']) { $(id).hidden = !on; document.querySelector(`label[for="${id}"]`).hidden = !on; } }
  function setKind(kind) {
    edit.mode = kind === 'master' ? 'master' : 'tag';
    for (const b of $('tag-kind').querySelectorAll('[data-kind]')) { const on = b.dataset.kind === kind; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
    $('master-fields').hidden = kind !== 'master'; $('exam-fields').hidden = kind !== 'exam'; showBasics(kind !== 'master');
  }
  function updateGenerate() {
    const set = $('preset-set').checked, type = $('preset-type').checked, any = set || type, n = (set ? 3 : 1) * (type ? 6 : 1);
    $('preset-generate').disabled = !any; if (!any) $('preset-generate').checked = false;
    $('preset-generate-text').textContent = any ? `同时建立 ${[set && '套题', type && '题型'].filter(Boolean).join(' × ')} 的全部 ${n} 本子账本` : '同时建立子账本（需先勾选套题或题型）';
  }
  function renderMembership(item, master) {
    const box = $('tag-membership'), show = Boolean(item || edit.sub); box.hidden = !show; if (!show) return;
    const org = ledgers(), options = [['', '不归入主账本（真题名称仍按年月归类）']];
    for (const m of org.masters) options.push([m.key, (m.kind === 'custom' ? '' : '真题 · ') + G.display(m)]);
    $('tag-master').replaceChildren(...options.map(([value, text]) => { const o = node('option', '', text); o.value = value; return o; }));
    let value = '', items = [];
    if (item) { value = G.viewOf(org, item.id)?.master || ''; items = [...membershipOf(item.id)]; }
    else if (master) { value = master.key; const f = G.filterOf(view); items = master.groups.filter(g => !g.derived).flatMap(g => f[g.id] || []); }
    $('tag-master').value = value; edit.memberItems = new Set(items); renderMemberChips();
  }
  function renderMemberChips() {
    const master = ledgers().byKey.get($('tag-master').value), groups = master ? master.groups.filter(g => !g.derived) : [], frag = document.createDocumentFragment();
    for (const g of groups) {
      const line = node('div', 'member-line'), name = node('span', 'member-name', g.name); name.id = 'member-g-' + g.id;
      const rail = node('div', 'chip-rail member-chips'); rail.setAttribute('role', 'group'); rail.setAttribute('aria-labelledby', name.id);
      for (const it of g.items) { const c = node('button', 'chip is-toggle'); c.type = 'button'; c.dataset.item = it.id; c.setAttribute('aria-pressed', String(edit.memberItems.has(it.id))); c.append(node('span', 'chip-label', it.name)); rail.append(c); }
      if (!g.items.length) rail.append(node('span', 'hint', '还没有分类项'));
      line.append(name, rail); frag.append(line);
    }
    if (master && !groups.length) frag.append(node('p', 'hint', master.kind === 'exam' ? '套题和题型按名称自动归类；用「分组」可再添加难度、课程等。' : '这个主账本还没有分组，可稍后在「分组」里建立。'));
    $('membership-groups').replaceChildren(frag);
  }
  // A new 子账本 in a custom 主账本 is named after its 分类项 until the name is typed by hand.
  function suggestName() {
    if (edit?.item || !edit?.sub) return;
    const master = ledgers().byKey.get($('tag-master').value); if (!master || master.kind !== 'custom') return;
    const now = $('tag-name').value; if (now && now !== edit.suggested) return;
    const names = master.groups.flatMap(g => g.items.filter(i => edit.memberItems.has(i.id)).map(i => i.name));
    edit.suggested = names.length ? [G.display(master), ...names].join(' · ').slice(0, 120) : ''; $('tag-name').value = edit.suggested;
  }
  // The whole classification after placing one 子账本 in `masterKey` (or nowhere) with these 分类项.
  function placeTag(tagId, name, masterKey, items) {
    const org = ledgers(), base = M.clone(data.structure || { version: 1, masters: [] });
    for (const m of base.masters) m.members = m.members.filter(r => r.tag !== tagId);
    const target = masterKey ? org.byKey.get(masterKey) : null;
    if (target) {
      const tag = data.tags.find(t => t.id === tagId), exam = tag?.sharing?.container || G.parse(name), derived = target.kind === 'exam' && exam?.key === target.key;
      let entry = target.kind === 'custom' ? base.masters.find(m => m.id === target.id) : base.masters.find(m => m.key === target.key);
      const known = new Set((entry?.groups || []).flatMap(g => g.items.map(i => i.id))), own = items.filter(x => known.has(x));
      if (!entry && !derived && target.kind === 'exam') { entry = { id: newId(), name: G.display(target).slice(0, 40), key: target.key, createdAt: new Date().toISOString(), groups: [], members: [] }; base.masters.push(entry); }
      if (entry && (target.kind === 'custom' || own.length || !derived)) entry.members.push({ tag: tagId, items: own });
    }
    base.masters = base.masters.filter(m => !m.key || m.groups.length || m.members.length);
    return base.masters.length ? base : null;
  }
  const sameStructure = next => JSON.stringify(next || null) === JSON.stringify(data.structure || null);
  const splitNames = raw => [...new Set(String(raw).split(/[、,，;；\n]/).map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean))];
  // 新建主账本: the classification first (one write), then, if asked, every 套题 × 题型 子账本 in sequence and their
  // placement in one more write.
  async function createMaster() {
    const name = $('master-name').value.trim().replace(/\s+/g, ' ');
    if (!name) throw new M.LedgerError('请填写主账本名称。');
    if (ledgers().masters.some(m => m.kind === 'custom' && M.normalize(m.label) === M.normalize(name))) throw new M.LedgerError('已有同名主账本，请换一个名称。');
    const groups = [];
    if ($('preset-set').checked) groups.push({ id: newId(), name: '套题', preset: 'set', items: G.SETS.map(n => ({ id: newId(), name: `第 ${n} 套` })) });
    if ($('preset-type').checked) groups.push({ id: newId(), name: '题型', preset: 'type', items: G.TYPES.map(t => ({ id: newId(), name: t })) });
    for (const g of splitNames($('master-groups').value)) if (!groups.some(x => M.normalize(x.name) === M.normalize(g))) groups.push({ id: newId(), name: g.slice(0, 40), items: [] });
    if (groups.length > 12) throw new M.LedgerError('一个主账本最多 12 个分组。');
    const entry = { id: newId(), name, createdAt: new Date().toISOString(), groups, members: [] };
    const base = M.clone(data.structure || { version: 1, masters: [] }); base.masters.push(entry);
    await commit('setStructure', { structure: base });
    view = { master: 'm:' + entry.id, filter: {} }; $('global-search').value = ''; $('local-search').value = ''; page = 1;
    if ($('preset-generate').checked) return generateSubs(entry.id, name);
    return 0;
  }
  async function generateSubs(entryId, name) {
    const entry = data.structure.masters.find(m => m.id === entryId), axes = entry.groups.filter(g => g.preset);
    let combos = [[]]; for (const g of axes) combos = combos.flatMap(c => g.items.map(i => [...c, i]));
    const taken = new Set(data.tags.map(t => M.normalize(t.name))), created = []; let failure = null;
    for (const [i, combo] of combos.entries()) {
      const tagName = [name, ...combo.map(x => x.name)].join(' · ').slice(0, 120); if (taken.has(M.normalize(tagName))) continue;
      try { await commit('addTag', { name: tagName, date: M.today() }); created.push({ tag: data.tags[data.tags.length - 1].id, items: combo.map(x => x.id) }); status(`已建立子账本 ${i + 1} / ${combos.length}`); }
      catch (error) { failure = error; break; }
    }
    if (created.length) { const base = M.clone(data.structure); base.masters.find(m => m.id === entryId).members.push(...created); await commit('setStructure', { structure: base }); }
    if (failure) throw new S.StorageError(`已建立 ${created.length} 本子账本，其余未完成：${failure.message}`, failure.code);
    return created.length;
  }
  function confirmAction(title, description, label, action) {
    $('merge-confirm').hidden=true;mergeImport=null;
    confirmReturnFocus = rememberFocus();
    confirmation = action; $('confirm-title').textContent = title; $('confirm-description').textContent = description;
    $('accept-confirm').textContent = label; $('confirm-error').textContent = '';
    $('confirm-dialog').showModal(); $('cancel-confirm').focus();
  }
  function download(raw, filename) {
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json;charset=utf-8' }));
    const a = node('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const REVIEW_BYTES = R.LIMITS.bytes;
  // Review progress for a backup of `ledger`: the cloud copy is read in full (it may hold older days than this page).
  async function reviewSection(ledger) {
    if (reviewStore.mode !== 'cloud') return R.toSection(reviewStore, ledger.words);
    return reviewStore.exportSection(ledger.words);
  }
  // A cloud restore confirms both sections in one transaction; then adopt that response in page memory.
  async function restoreReview(section) {
    if (!section) return;
    if(store.mode==='cloud') { const saved=store.reviewSaved;if(!saved)throw new S.StorageError('复习恢复尚未确认。');reviewStore.reset(saved);reviewStore.revision=saved.revision; }
    else await reviewStore.replace(section);
    reviewStamp++; updateReviewEntry();
  }
  function filename(prefix) { return prefix + '-' + M.today() + '-' + Date.now() + '.json'; }
  // A backup is the ledger plus an optional `review` section (smart review progress). Older files have none and
  // still import; the ledger validator never sees the extra key (see LedgerReview.splitBackup).
  function exportData(value, prefix = 'vocabulary-ledger', review = null) {
    const backup={...M.validate(value),exportedAt:new Date().toISOString(),...(review?{review}:{})};let raw=JSON.stringify(backup,null,2);
    if(new TextEncoder().encode(raw).length>M.LIMITS.bytes+REVIEW_BYTES)raw=JSON.stringify(backup);
    download(raw,filename(prefix));if(store.mode==='guest')store.dirty=false;
  }
  // Exam picker: fills the name only while it is empty or still the last generated value.
  let examGenerated = '', nameIsAuto = true;
  function updateExam() {
    const name = examTitle($('exam-year').value, $('exam-month').value, $('exam-set').value.trim(), $('exam-type').value);
    const set = $('exam-set').value.trim(), badSet = set !== '' && !/^[1-9]\d{0,2}$/.test(set);
    $('exam-preview').textContent = name || (badSet ? '套题须为正整数' : '—');
    $('exam-preview').classList.toggle('is-invalid', badSet); $('exam-set').setAttribute('aria-invalid', String(badSet));
    if (name && nameIsAuto) $('tag-name').value = name;
    examGenerated = name; $('exam-apply').disabled = !name || $('tag-name').value === name;
  }
  function resetExam(show, preset = null) {
    $('exam-fields').hidden = !show;
    for (const id of ['exam-year','exam-month','exam-type']) $(id).value = '';
    $('exam-set').value = ''; examGenerated = ''; nameIsAuto = !$('tag-name').value;
    if (preset) { $('exam-year').value = preset.year; $('exam-month').value = preset.month; $('exam-set').value = preset.set; $('exam-type').value = preset.type; }
    updateExam();
  }
  // 「+ 子账本」 inside an exam 主账本: same year/month, plus whatever 套题/题型 is currently picked.
  function subPreset() {
    const master = currentMaster(); if (!master || master.kind !== 'exam' || !master.year) return null;
    const f = G.filterOf(view), one = gid => ((f[gid] || []).length === 1 ? f[gid][0] : '');
    return { year: (Number(master.year) >= 80 ? '19' : '20') + master.year, month: master.month, set: one('set').slice(4), type: one('type').slice(5) };
  }
  // A filter that names exactly one 分类项 per chosen group can create its 子账本 in one click: the exam name for
  // 套题 × 题型, or 主账本 · 分类 · 分类 in a custom 主账本, placed in those 分类项.
  function emptyPlan(master) {
    const f = G.filterOf(view); if (Object.values(f).some(ids => ids.length > 1)) return null;
    const pick = gid => (f[gid] || [])[0], items = master.groups.filter(g => !g.derived && pick(g.id)).map(g => pick(g.id));
    if (master.kind === 'exam') {
      const set = pick('set'), type = pick('type'); if (!set || !type || !master.year) return null;
      return { name: G.subName(master.year + '-' + master.month, Number(set.slice(4)), type.slice(5)), items };
    }
    const names = master.groups.filter(g => pick(g.id)).map(g => g.items.find(i => i.id === pick(g.id))?.name).filter(Boolean);
    return names.length ? { name: [G.display(master), ...names].join(' · ').slice(0, 120), items } : null;
  }
  {
    const year = Number(M.today().slice(0, 4)), options = document.createDocumentFragment();
    for (let y = year; y >= 2005; y--) { const option = node('option', '', y + ' 年'); option.value = String(y); options.append(option); }
    $('exam-year').append(options);
  }
  for (const id of ['exam-year','exam-month','exam-type']) $(id).addEventListener('change', updateExam);
  $('exam-set').addEventListener('input', updateExam);
  $('tag-name').addEventListener('input', () => {
    const value = $('tag-name').value; nameIsAuto = value === '' || value === examGenerated;
    $('exam-apply').disabled = !examGenerated || value === examGenerated;
  });
  $('exam-apply').addEventListener('click', () => { nameIsAuto = true; updateExam(); $('tag-name').focus(); });
  for (const button of document.querySelectorAll('[data-set-pick]')) button.addEventListener('click', () => { $('exam-set').value = button.dataset.setPick; updateExam(); });
  $('composer-toggle').addEventListener('click', () => {
    if (!view) return;
    const open = !composerShown; composerOpen.set(G.key(view), open); setComposer(open, true);
    if (open) $('word-input').focus();
  });
  $('add-form').addEventListener('input', updateDraftBadge);
  for (const form of ['add-form','editor-form']) $(form).addEventListener('reset', () => setTimeout(() => { updateDraftBadge(); updatePreviews(); autosizeAll(); }));
  for (const area of document.querySelectorAll('textarea[data-autosize]')) area.addEventListener('input', () => autosize(area));
  let autosizeFrame = false;
  window.addEventListener('resize', () => { if (autosizeFrame) return; autosizeFrame = true; requestAnimationFrame(() => { autosizeFrame = false; autosizeAll(); }); });
  for (const id of RICH_FIELDS) {
    $(id).addEventListener('input', () => updatePreview(id));
    $(id).addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b' && !e.isComposing) { e.preventDefault(); toggleBold($(id)); } });
  }
  for (const button of document.querySelectorAll('[data-bold]')) {
    // Keep the textarea selection when the button is pressed with a pointer.
    button.addEventListener('pointerdown', e => e.preventDefault());
    button.addEventListener('click', () => { const area = $(button.dataset.bold); area.focus(); toggleBold(area); });
  }
  // Shortcut tips: hover or keyboard focus shows them; a tap toggles them for touch screens.
  function closeTips(except) { for (const tip of document.querySelectorAll('.tip-wrap.is-open')) if (tip !== except) { tip.classList.remove('is-open'); tip.querySelector('.help-tip').setAttribute('aria-expanded', 'false'); } }
  for (const button of document.querySelectorAll('.help-tip')) {
    const wrap = button.closest('.tip-wrap');
    button.addEventListener('focus', () => wrap.classList.remove('is-dismissed'));
    wrap.addEventListener('pointerenter', () => wrap.classList.remove('is-dismissed'));
    button.addEventListener('click', () => { const open = !wrap.classList.contains('is-open'); closeTips(wrap); wrap.classList.remove('is-dismissed'); wrap.classList.toggle('is-open', open); button.setAttribute('aria-expanded', String(open)); });
    button.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTips(); wrap.classList.add('is-dismissed'); } });
    button.addEventListener('blur', () => closeTips());
  }
  $('new-tag').addEventListener('click', () => {
    if (entryDraft()) {
      confirmAction('新增账本', '「录入词条」中有尚未添加的内容。新增账本前将清空这些输入。是否继续？', '清空输入并新增', () => {
        $('add-form').reset(); $('confirm-dialog').close(); openEditor('tag');
      });
    } else openEditor('tag');
  });
  $('edit-tag').addEventListener('click', () => openEditor('tag', currentTag()));
  // 智能复习: the header entry shows today's queue across every ledger; the dialog (js/review-ui.js) does the rest.
  let entryCache = { key: '', data: null };
  function updateReviewEntry() {
    const now = Date.now(), key = [accountGeneration, reviewStamp, cloudLoading, R.statisticsDay(now,reviewStore.settings), Math.floor(now / 15000)].join(':');
    if (entryCache.key === key && entryCache.data === data) return;
    clearTimeout(reviewTick);
    // Dates on the curve are whole days, so the queue only changes at local midnight.
    const next=Math.min(R.endOfToday(now),R.statisticsEnd(now,reviewStore.settings));
    reviewTick=setTimeout(()=>{reviewStamp++;updateReviewEntry();if(!document.hidden&&!document.body.classList.contains('identity-check'))reviewUI.refresh();},Math.max(1,next-now+1));
    entryCache = { key, data };
    const today = reviewStore.days.get(R.statisticsDay(now,reviewStore.settings)) || R.zero(R.statisticsDay(now,reviewStore.settings));
    const plan = R.plan({ words: data.words, cards: reviewStore.cards, now, settings: reviewStore.settings, learnedToday: today.learned });
    const queue = plan.due.length + plan.fresh.length, badge = $('review-badge'), meta = $('review-meta');
    const loading = cloudLoading || (store.mode === 'cloud' && !reviewStore.loaded && !reviewStore.error);
    badge.hidden = !queue || loading; badge.textContent = queue > 999 ? '999+' : String(queue);
    $('review-open').classList.toggle('has-queue', queue > 0 && !loading);
    if (loading) meta.textContent = '正在读取复习进度…';
    else if (store.mode === 'cloud' && !reviewStore.loaded) meta.textContent = '复习进度暂未读取 · 打开后重试';
    else if (!data.words.length) meta.textContent = '录入词条后，按遗忘曲线安排每天该背的词';
    else if (queue) meta.textContent = `今日待复习 ${plan.due.length}` + (plan.fresh.length ? ` · 新词 ${plan.fresh.length}` : '') + (today.flips ? ` · 已背诵 ${today.flips} 次` : '');
    else { const streak = R.streak(reviewStore.days, now, reviewStore.settings); meta.textContent = '今日复习已完成' + (today.flips ? ` · 背诵 ${today.flips} 次` : '') + (streak > 1 ? ` · 连续 ${streak} 天` : ''); }
    $('review-open').setAttribute('aria-label', '智能复习' + (queue && !loading ? `，今日 ${queue} 张` : ''));
  }
  // Marking a word mastered from a review card is the ledger's own toggle, so list, statistics and sync agree.
  async function setMastered(id, mastered) {
    const word = data.words.find(w => w.id === id);
    if (!word) throw new S.StorageError('这个词条已不在账本中，可能已在其他设备删除。');
    if (word.mastered === mastered) return;
    try { await commit('toggleWord', { id, mastered }); } catch (error) { report(error); throw error; }
    render();
  }
  const viewLabel = () => { if (!view) return ''; const single = currentTag(); if (single) return single.name; const m = currentMaster(); if (!m) return ''; const scope = G.label(view, m); return G.display(m) + (scope === '全部子账本' ? '' : ' · ' + scope); };
  reviewUI = window.LedgerReviewUI.mount({ node, richText, reducedMotion, store: () => reviewStore, setMastered, feedback,
    ledger: () => { const own = ordering(); return { data, org: ledgers(), ranks: own.ranks, folios: own.folios, viewTags: view && !globalMode() ? viewTags() : [], viewLabel: viewLabel() }; },
    reload: async () => { const review = reviewStore; const error = await review.load(); if (review === reviewStore) { reviewStamp++; updateReviewEntry(); } return error; },
    onChange: () => { reviewStamp++; updateReviewEntry(); },
    onClose: () => { const opener = $('review-open'); (opener.getClientRects().length ? opener : view ? $('workspace') : $('new-tag')).focus({ preventScroll: true }); }
  });
  $('review-open').addEventListener('click', () => { if (cloudLoading) { feedback('云端账本读取完成后即可开始复习。'); return; } reviewUI.open(); });
  // 官方词汇账本 (js/official-ui.js): browsing is public and read-only. The one write is the copy: a new independent
  // ledger with all its words in a single importTag — page memory for a guest, one append-only cloud batch otherwise
  // (unlike a restore it never rewrites existing ledgers, publications or 分组). The official data itself is never written.
  const officialHost = {
    exists: id => data.tags.some(t => t.id === id),
    plan(title, count) {
      const ready = !cloudLoading && hasData && !(store.mode === 'cloud' && store.blocked);
      let name = title, reason = '';
      try { name = window.LedgerOfficial.freeName(title, data.tags.map(t => t.name)); } catch (error) { reason = error.message; }
      if (data.tags.length >= M.LIMITS.tags) reason = `账本已达 ${M.LIMITS.tags} 本上限，整理后再复制。`;
      else if (data.words.length + count > M.LIMITS.words) reason = `复制后共 ${data.words.length + count} 条，超过 ${M.LIMITS.words} 条上限。可以先导出备份、整理旧账本。`;
      return { name, ready, reason, mode: store.mode };
    },
    async copy(title, words) {
      const plan = officialHost.plan(title, words.length);
      if (!plan.ready) throw new S.StorageError('云端账本读取完成后即可复制。');
      if (plan.reason) throw new M.LedgerError(plan.reason);
      await commit('importTag', { name: plan.name, date: M.today(), words });
      const tag = data.tags[data.tags.length - 1];
      emphasisTag = tag.id; render(); emphasisTag = null;
      feedback(store.mode === 'guest' ? `已复制「${tag.name}」· 游客账本仅在本页，记得导出 JSON。` : `已复制「${tag.name}」并保存到云端。`);
      return { id: tag.id, name: tag.name };
    },
    async undo(id) {
      if (!data.tags.some(t => t.id === id)) return;
      await commit('deleteTag', { id }); if (view?.tag === id) view = defaultView();
      page = 1; render(); feedback('已撤销复制。');
    },
    open(id) { const next = G.viewOf(ledgers(), id); if (!next) return; emphasisTag = id; selectView(next, true, true); emphasisTag = null; }
  };
  officialUI = window.LedgerOfficialUI.mount(officialHost);
  $('welcome-new-tag').addEventListener('click', () => $('new-tag').click());
  $('editor-dialog').addEventListener('close', () => returnFocus(editorReturnFocus));
  $('tag-list').addEventListener('click', e => {
    const button = e.target.closest('[data-master],[data-tag-id]'); if (!button) return;
    selectView(button.dataset.master ? { master: button.dataset.master, filter: {} } : { tag: button.dataset.tagId }, true);
  });
  // 分组 tabs narrow the current 主账本 (a filter, not a ledger switch); focus stays on the tab that was pressed.
  $('sub-picker').addEventListener('click', e => {
    const pill = e.target.closest('.facet-pill'); if (pill) { openFacets(pill.dataset.group); return; }
    const button = e.target.closest('.chip'); if (!button || !view?.master) return;
    const gid = button.closest('[data-group]').dataset.group, raw = button.dataset.value, item = button.dataset.item;
    const filter = { ...G.filterOf(view) }, chosen = filter[gid] || [];
    const next = raw === 'all' ? [] : e.ctrlKey || e.metaKey || e.shiftKey ? (chosen.includes(item) ? chosen.filter(x => x !== item) : [...chosen, item]) : [item];
    if (next.length) filter[gid] = next; else delete filter[gid];
    const nextView = { master: view.master, filter }, changed = G.key(nextView) !== G.key(view);
    if (changed) selectView(nextView);
    const picked = [...$('sub-picker').querySelectorAll('.chip')].find(el => el.closest('[data-group]').dataset.group === gid && el.dataset.value === raw); picked?.focus({ preventScroll: true });
    if (changed && picked && !reducedMotion.matches) pulse(picked, 'is-picked', 300);
  });
  // The multi-select sheet: every 分组 of the 主账本 with toggle tabs. It filters live; 完成 only closes it.
  let facetReturn = null;
  function openFacets(groupId = null) {
    const master = currentMaster(); if (!master || !master.groups.length) return;
    facetReturn = document.activeElement; renderFacetSheet(); $('facet-sheet').showModal();
    const target = groupId && [...$('facet-sheet-body').querySelectorAll('.sheet-group')].find(el => el.dataset.group === groupId);
    target?.scrollIntoView({ block: 'nearest' }); (target?.querySelector('.chip') || $('facet-done')).focus({ preventScroll: true });
  }
  function renderFacetSheet() {
    const master = currentMaster(); if (!master || globalMode()) { if ($('facet-sheet').open) $('facet-sheet').close(); return; }
    const counts = M.tagStats(data), filter = G.filterOf(view), frag = document.createDocumentFragment();
    $('facet-sheet-title').textContent = G.display(master);
    for (const g of master.groups) {
      const section = node('section', 'sheet-group'), h = node('h3', 'sheet-group-name', g.name); section.dataset.group = g.id; h.id = 'facet-g-' + g.id;
      const rail = node('div', 'chip-rail sheet-chips'); rail.setAttribute('role', 'group'); rail.setAttribute('aria-labelledby', h.id); rail.dataset.group = g.id;
      rail.append(...facetChips(master, g, filter, counts, true)); section.append(h, rail); frag.append(section);
    }
    $('facet-sheet-body').replaceChildren(frag);
    const subs = subsFor(master, filter), words = subs.reduce((n, x) => n + counts.get(x.tag.id).total, 0);
    $('facet-result').textContent = `· ${subs.length} 本子账本 · ${words} 条`;
  }
  $('facet-sheet-body').addEventListener('click', e => {
    const button = e.target.closest('.chip'); if (!button || !view?.master) return;
    const gid = button.closest('[data-group]').dataset.group, item = button.dataset.item, raw = button.dataset.value, filter = { ...G.filterOf(view) }, chosen = filter[gid] || [];
    const next = raw === 'all' ? [] : chosen.includes(item) ? chosen.filter(x => x !== item) : [...chosen, item];
    if (next.length) filter[gid] = next; else delete filter[gid];
    selectView({ master: view.master, filter });
    [...$('facet-sheet-body').querySelectorAll('.chip')].find(el => el.closest('[data-group]').dataset.group === gid && el.dataset.value === raw)?.focus({ preventScroll: true });
  });
  $('facet-clear').addEventListener('click', () => { if (view?.master) selectView({ master: view.master, filter: {} }); $('facet-done').focus({ preventScroll: true }); });
  for (const id of ['facet-done', 'facet-close']) $(id).addEventListener('click', () => $('facet-sheet').close());
  $('facet-sheet').addEventListener('close', () => { const back = facetReturn?.isConnected && facetReturn.getClientRects().length ? facetReturn : $('facet-open'); facetReturn = null; if (back.getClientRects().length) back.focus({ preventScroll: true }); });
  $('facet-open').addEventListener('click', () => openFacets());
  facetWide.addEventListener('change', () => { if (view?.master && !globalMode()) render(); });
  // ── 分组与归属 ───────────────────────────────────────────────────────────────────────────────────────────
  // Edits a working copy of one 主账本's classification and saves it as one write (nothing is saved on cancel).
  // Removing a 分组 or 分类项 only removes that classification: 子账本 and their words are never touched.
  let gm = null, gmReturn = null;
  const QUICK = [
    { key: 'set', name: '套题', preset: 'set', items: () => G.SETS.map(n => `第 ${n} 套`) }, { key: 'type', name: '题型', preset: 'type', items: () => [...G.TYPES] },
    { key: 'level', name: '难度', items: () => ['易', '中', '难'] }, { key: 'course', name: '课程', items: () => [] }, { key: 'unit', name: '章节', items: () => [] }];
  function openGroups() {
    const master = currentMaster(); if (!master) return;
    const entry = master.entry ? M.clone(master.entry) : { id: newId(), name: G.display(master).slice(0, 40), key: master.key, createdAt: new Date().toISOString(), groups: [], members: [] };
    gm = { kind: master.kind, key: master.key, entry, derived: master.groups.filter(g => g.derived), subs: master.subs.map(x => ({ id: x.tag.id, label: G.subLabel(master, x), derived: x.set !== null })) };
    gmReturn = document.activeElement; $('groups-error').textContent = '';
    renderGroups(); $('groups-dialog').showModal(); ($('groups-body').querySelector('input') || $('groups-save')).focus({ preventScroll: true });
  }
  function gmInput(className, value, label, action, extra = {}) { const input = node('input', className); input.defaultValue = value; input.maxLength = 40; input.autocomplete = 'off'; input.setAttribute('aria-label', label); input.dataset.gm = action; Object.assign(input.dataset, extra); return input; }
  function gmButton(className, text, label, action, extra = {}) { const b = node('button', className, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); b.dataset.gm = action; Object.assign(b.dataset, extra); return b; }
  function renderGroups() {
    const e = gm.entry, frag = document.createDocumentFragment();
    $('groups-title').textContent = gm.kind === 'custom' ? '自定义主账本' : G.display(currentMaster() || { key: gm.key });
    $('groups-delete-master').hidden = gm.kind !== 'custom';
    if (gm.kind === 'custom') { const wrap = node('div', 'gm-name'), label = node('label', '', '主账本名称'); label.htmlFor = 'gm-master-name'; const input = gmInput('', e.name, '主账本名称', 'master-name'); input.id = 'gm-master-name'; wrap.append(label, input); frag.append(wrap); }
    const groups = node('section', 'gm-section'); groups.append(node('h3', 'gm-h', '分组'), node('p', 'hint', '一本子账本可以同时属于多个分组；删除分组或分类项不会删除子账本和词条。'));
    for (const g of gm.derived) { const row = node('div', 'gm-group is-derived'); row.append(node('p', 'gm-group-name', g.name), node('p', 'hint', g.id === 'set' ? '按子账本名称里的套题号自动归类' : '按子账本名称里的题型自动归类')); groups.append(row); }
    for (const g of e.groups) {
      const row = node('div', 'gm-group'), head = node('div', 'gm-group-head'); row.dataset.group = g.id;
      head.append(gmInput('gm-group-input', g.name, '分组名称', 'group-name', { group: g.id }), gmButton('quiet danger gm-del', '删除分组', `删除分组「${g.name}」`, 'delete-group', { group: g.id }));
      const items = node('div', 'gm-items');
      for (const it of g.items) { const chipEl = node('span', 'gm-item'); chipEl.append(gmInput('gm-item-input', it.name, `「${g.name}」的分类项名称`, 'item-name', { group: g.id, item: it.id }), gmButton('quiet gm-item-del', '×', `删除分类项「${it.name}」`, 'delete-item', { group: g.id, item: it.id })); items.append(chipEl); }
      const add = gmInput('gm-item-add', '', `为「${g.name}」添加分类项`, 'add-item', { group: g.id }); add.placeholder = '+ 分类项，回车添加'; items.append(add);
      row.append(head, items); groups.append(row);
    }
    const adder = node('div', 'gm-add'), input = gmInput('gm-group-add', '', '新分组名称', 'add-group'); input.id = 'gm-new-group'; input.placeholder = '新分组，如 难度';
    adder.append(input, gmButton('quiet gm-add-button', '添加分组', '', 'add-group-button')); groups.append(adder);
    const taken = new Set([...gm.derived, ...e.groups].map(g => M.normalize(g.name))), quick = node('div', 'gm-quick');
    for (const q of QUICK) if (!taken.has(M.normalize(q.name)) && (gm.kind === 'custom' || !q.preset)) quick.append(gmButton('quiet gm-quick-button', '+ ' + q.name, `添加常用分组「${q.name}」`, 'quick', { quick: q.key }));
    if (quick.childElementCount) groups.append(quick);
    frag.append(groups);
    const members = node('section', 'gm-section gm-members'); members.append(node('h3', 'gm-h', '子账本归属'));
    if (!e.groups.length) members.append(node('p', 'hint', '建立分组后，在这里为每本子账本选择分类项（可多选）。'));
    else if (!gm.subs.length) members.append(node('p', 'hint', '这个主账本还没有子账本。'));
    else for (const x of gm.subs) {
      const card = node('div', 'gm-sub'), own = new Set(e.members.find(r => r.tag === x.id)?.items || []); card.append(node('p', 'gm-sub-name', x.label));
      for (const g of e.groups) {
        const line = node('div', 'gm-line'), rail = node('div', 'chip-rail gm-chips'); rail.setAttribute('role', 'group'); rail.setAttribute('aria-label', `${x.label} · ${g.name}`);
        for (const it of g.items) { const c = gmButton('chip is-toggle', '', '', 'member', { tag: x.id, item: it.id }); c.setAttribute('aria-pressed', String(own.has(it.id))); c.append(node('span', 'chip-label', it.name)); rail.append(c); }
        if (!g.items.length) rail.append(node('span', 'hint', '先为这个分组添加分类项'));
        line.append(node('span', 'gm-line-name', g.name), rail); card.append(line);
      }
      members.append(card);
    }
    frag.append(members);
    $('groups-body').replaceChildren(frag);
  }
  function gmFocus(selector) { $('groups-body').querySelector(selector)?.focus({ preventScroll: true }); }
  function gmAddGroup(name, quick = null) {
    const e = gm.entry, clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) { $('groups-error').textContent = '请填写分组名称。'; return false; }
    if ([...gm.derived, ...e.groups].some(g => M.normalize(g.name) === M.normalize(clean))) { $('groups-error').textContent = `已有「${clean}」分组。`; return false; }
    if (e.groups.length >= 12) { $('groups-error').textContent = '一个主账本最多 12 个分组。'; return false; }
    const g = { id: newId(), name: clean.slice(0, 40), items: (quick ? quick.items() : []).map(n => ({ id: newId(), name: n })) }; if (quick?.preset) g.preset = quick.preset;
    e.groups.push(g); $('groups-error').textContent = ''; renderGroups(); gmFocus(`.gm-group[data-group="${CSS.escape(g.id)}"] .gm-item-add`); return true;
  }
  $('groups-body').addEventListener('input', e => {
    const t = e.target, ds = t.dataset, entry = gm?.entry; if (!entry) return;
    if (ds.gm === 'master-name') entry.name = t.value;
    else if (ds.gm === 'group-name') entry.groups.find(g => g.id === ds.group).name = t.value;
    else if (ds.gm === 'item-name') entry.groups.find(g => g.id === ds.group).items.find(i => i.id === ds.item).name = t.value;
  });
  $('groups-body').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const t = e.target, ds = t.dataset; if (!['add-item', 'add-group'].includes(ds.gm)) return;
    e.preventDefault();
    if (ds.gm === 'add-group') { if (gmAddGroup(t.value)) t.value = ''; return; }
    const g = gm.entry.groups.find(x => x.id === ds.group), name = t.value.trim().replace(/\s+/g, ' ');
    if (!name) return;
    if (g.items.some(i => M.normalize(i.name) === M.normalize(name))) { $('groups-error').textContent = `「${g.name}」里已有「${name}」。`; return; }
    if (g.items.length >= 100) { $('groups-error').textContent = '一个分组最多 100 个分类项。'; return; }
    g.items.push({ id: newId(), name: name.slice(0, 40) }); $('groups-error').textContent = ''; renderGroups(); gmFocus(`.gm-group[data-group="${CSS.escape(g.id)}"] .gm-item-add`);
  });
  $('groups-body').addEventListener('click', e => {
    const b = e.target.closest('button[data-gm]'); if (!b || !gm) return;
    const ds = b.dataset, entry = gm.entry;
    if (ds.gm === 'add-group-button') { const input = $('gm-new-group'); if (gmAddGroup(input.value)) input.value = ''; else input.focus(); }
    else if (ds.gm === 'quick') { const q = QUICK.find(x => x.key === ds.quick); gmAddGroup(q.name, q); }
    else if (ds.gm === 'delete-group') { entry.groups = entry.groups.filter(g => g.id !== ds.group); renderGroups(); gmFocus('#gm-new-group'); }
    else if (ds.gm === 'delete-item') { const g = entry.groups.find(x => x.id === ds.group); g.items = g.items.filter(i => i.id !== ds.item); for (const r of entry.members) r.items = r.items.filter(x => x !== ds.item); renderGroups(); gmFocus(`.gm-group[data-group="${CSS.escape(g.id)}"] .gm-item-add`); }
    else if (ds.gm === 'member') {
      let r = entry.members.find(x => x.tag === ds.tag); if (!r) { r = { tag: ds.tag, items: [] }; entry.members.push(r); }
      const on = !r.items.includes(ds.item); r.items = on ? [...r.items, ds.item] : r.items.filter(x => x !== ds.item); b.setAttribute('aria-pressed', String(on));
    }
  });
  $('groups-save').addEventListener('click', async () => {
    if (!gm) return;
    try {
      const e = gm.entry, trim = v => String(v).trim().replace(/\s+/g, ' ');
      const clean = { ...e, name: trim(e.name), groups: e.groups.map(g => ({ ...g, name: trim(g.name), items: g.items.map(i => ({ ...i, name: trim(i.name) })) })) };
      if (gm.kind === 'custom' && ledgers().masters.some(m => m.kind === 'custom' && m.id !== e.id && M.normalize(m.label) === M.normalize(clean.name))) throw new M.LedgerError('已有同名主账本，请换一个名称。');
      // A custom 主账本 keeps every 子账本 it holds (even without 分类项); an exam one only needs rows that add 分类项
      // or attach a tag whose name is not an exam name.
      const subs = new Map(gm.subs.map(x => [x.id, x]));
      if (gm.kind === 'custom') { for (const x of gm.subs) if (!clean.members.some(r => r.tag === x.id)) clean.members.push({ tag: x.id, items: [] }); }
      else clean.members = clean.members.filter(r => r.items.length || (subs.has(r.tag) && !subs.get(r.tag).derived));
      const base = M.clone(data.structure || { version: 1, masters: [] }), at = base.masters.findIndex(m => m.id === clean.id);
      if (at >= 0) base.masters[at] = clean; else base.masters.push(clean);
      base.masters = base.masters.filter(m => !m.key || m.groups.length || m.members.length);
      const next = base.masters.length ? base : null;
      if (!sameStructure(next)) await commit('setStructure', { structure: next });
      gm = null; $('groups-dialog').close(); render(); feedback('分组与归属已保存。');
    } catch (error) { if (authFailure(error)) return; $('groups-error').textContent = error.message; }
  });
  $('groups-delete-master').addEventListener('click', () => {
    if (!gm || gm.kind !== 'custom') return;
    const e = gm.entry, n = gm.subs.length;
    confirmAction('删除主账本', `删除主账本「${e.name}」？\n其中 ${n} 本子账本和全部词条都会保留，变为独立账本；只移除这个主账本和它的分组。`, '删除主账本，保留子账本', async () => {
      const base = M.clone(data.structure || { version: 1, masters: [] }); base.masters = base.masters.filter(m => m.id !== e.id);
      await commit('setStructure', { structure: base.masters.length ? base : null });
      gm = null; $('groups-dialog').close(); view = defaultView(); page = 1; render(); feedback('主账本已删除，子账本和词条都已保留。');
    });
  });
  for (const id of ['groups-cancel', 'groups-close']) $(id).addEventListener('click', () => $('groups-dialog').close());
  $('groups-dialog').addEventListener('close', () => { gm = null; const back = gmReturn?.isConnected && gmReturn.getClientRects().length ? gmReturn : $('groups-manage'); gmReturn = null; if (back.getClientRects().length) back.focus({ preventScroll: true }); });
  $('groups-manage').addEventListener('click', openGroups);
  // Editor: kind switch, presets and membership tabs.
  $('tag-kind').addEventListener('click', e => { const b = e.target.closest('[data-kind]'); if (!b) return; setKind(b.dataset.kind); (b.dataset.kind === 'master' ? $('master-name') : $('tag-name')).focus(); });
  $('tag-kind').addEventListener('keydown', e => {
    const list = [...$('tag-kind').querySelectorAll('[data-kind]')], at = list.indexOf(document.activeElement); if (at < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!step) return;
    e.preventDefault(); const next = list[(at + step + list.length) % list.length]; setKind(next.dataset.kind); next.focus();
  });
  for (const id of ['preset-set', 'preset-type']) $(id).addEventListener('change', updateGenerate);
  $('tag-master').addEventListener('change', () => { edit.memberItems = new Set(); renderMemberChips(); suggestName(); });
  $('membership-groups').addEventListener('click', e => {
    const c = e.target.closest('.chip[data-item]'); if (!c) return;
    const id = c.dataset.item, on = !edit.memberItems.has(id); if (on) edit.memberItems.add(id); else edit.memberItems.delete(id);
    c.setAttribute('aria-pressed', String(on)); suggestName();
  });
  // Sticky ledger bar: the head (title, figures, ledger tools) scrolls away and the dock (分组 filter, search, sort)
  // stays under the viewport top. The bar's sticky `top` is minus the head's height, so sticking changes no size and
  // no layout — nothing folds, no spacer, no jump at the threshold, whatever the scroll speed. Sizes are measured
  // only when they change (ResizeObserver), never on scroll.
  function layoutBar() {
    const bar = $('ledger-bar'), root = document.documentElement.style;
    if (bar.hidden) { root.setProperty('--bar-h', '0px'); bar.classList.remove('is-stuck'); return; }
    const fold = $('bar-head').getBoundingClientRect().height;
    bar.style.top = -fold + 'px';
    root.setProperty('--bar-h', Math.max(0, bar.getBoundingClientRect().height - fold) + 'px');
    markStuck();
  }
  // Pinned or not only changes the clay underline (paint, not layout).
  function markStuck() { const bar = $('ledger-bar'); bar.classList.toggle('is-stuck', !bar.hidden && scrollY > 0 && bar.getBoundingClientRect().top <= parseFloat(bar.style.top || '0') + 0.5); }
  if (typeof ResizeObserver === 'function') { const watch = new ResizeObserver(() => layoutBar()); watch.observe($('ledger-bar')); watch.observe($('bar-head')); }
  let barFrame = false;
  window.addEventListener('scroll', () => { if (barFrame) return; barFrame = true; requestAnimationFrame(() => { barFrame = false; markStuck(); }); }, { passive: true });
  window.addEventListener('resize', () => layoutBar());
  // Phones fold sort and status into a small menu beside the search line; it floats over the list (no reflow).
  function setMore(open) { $('ledger-bar').classList.toggle('tools-open', open); $('bar-tools-toggle').setAttribute('aria-expanded', String(open)); }
  $('bar-tools-toggle').addEventListener('click', () => { const open = !$('ledger-bar').classList.contains('tools-open'); setMore(open); if (open) $('sort-order').focus({ preventScroll: true }); });
  document.addEventListener('pointerdown', e => { if ($('ledger-bar').classList.contains('tools-open') && !e.target.closest('#bar-more, #bar-tools-toggle')) setMore(false); });
  $('bar-more').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMore(false); $('bar-tools-toggle').focus({ preventScroll: true }); } });
  $('add-sub').addEventListener('click', () => {
    if (entryDraft()) {
      confirmAction('新增子账本', '「录入词条」中有尚未添加的内容。新增子账本前将清空这些输入。是否继续？', '清空输入并新增', () => {
        $('add-form').reset(); $('confirm-dialog').close(); openEditor('tag', null, { sub: true });
      });
    } else openEditor('tag', null, { sub: true });
  });
  async function createEmptySub() {
    const master = currentMaster(); if (!master) return;
    const plan = emptyPlan(master);
    if (!plan) { openEditor('tag', null, { sub: true }); return; }
    try {
      await commit('addTag', { name: plan.name, date: M.today() });
      const id = data.tags[data.tags.length - 1].id;
      if (master.kind === 'custom' || plan.items.length) { const next = placeTag(id, plan.name, master.key, plan.items); if (!sameStructure(next)) await commit('setStructure', { structure: next }); }
      emphasisTag = id; render(); emphasisTag = null; feedback('子账本已新增。');
    } catch (error) { report(error); }
  }
  $('sub-empty-create').addEventListener('click', () => {
    if (entryDraft()) {
      confirmAction('新增子账本', '「录入词条」中有尚未添加的内容。新增子账本前将清空这些输入。是否继续？', '清空输入并新增', async () => {
        $('add-form').reset(); $('confirm-dialog').close(); await createEmptySub();
      });
    } else createEmptySub();
  });
  $('cancel-editor').addEventListener('click', () => $('editor-dialog').close());
  $('editor-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      if(edit.item && (data.revision!==edit.revision || (edit.kind==='word'?data.words:data.tags).find(x=>x.id===edit.item.id)?.recordVersion!==edit.item.recordVersion)) { throw new S.StorageError('账本已在另一设备修改。输入已保留；请取消编辑并核对最新记录。','conflict'); }
      if (edit.kind === 'word') await commit('editWord', { id: edit.item.id, english: $('edit-english').value, meaning: $('edit-meaning').value, exampleSentence:$('edit-example').value, exampleTranslation:$('edit-translation').value, note:$('edit-note').value });
      else if (edit.mode === 'master') {
        const made = await createMaster();
        $('editor-dialog').close(); render(); feedback(made ? `主账本已建立，并新增 ${made} 本子账本。` : '主账本已建立。'); return;
      }
      else {
        const payload = { name: $('tag-name').value, date: $('tag-date').value };
        // A renamed or new ledger is shown on its own; a rename may move it into or out of a 主账本. Its placement
        // (主账本 and 分类项) is saved right after as one classification write.
        const before = ledgerOf(view), place = $('tag-membership').hidden ? null : { master: $('tag-master').value, items: [...edit.memberItems] };
        let id;
        if (edit.item) { payload.id = id = edit.item.id; await commit('editTag', payload); }
        else { await commit('addTag', payload); id = emphasisTag = data.tags[data.tags.length - 1].id; $('global-search').value = ''; page = 1; }
        if (place) {
          const next = placeTag(id, payload.name.trim(), place.master, place.items);
          if (!sameStructure(next)) {
            try { await commit('setStructure', { structure: next }); }
            catch (error) { if (authFailure(error)) return; $('editor-dialog').close(); view = G.viewOf(ledgers(), id) || defaultView(); render(); emphasisTag = null; feedback('子账本已保存，但分组归属暂未保存：' + error.message, true); return; }
          }
        }
        view = G.viewOf(ledgers(), id) || defaultView();
        if (ledgerOf(view) !== before) $('local-search').value = '';
      }
      $('editor-dialog').close(); render(); emphasisTag = null; feedback('已保存。');
    } catch (error) { if(authFailure(error))return;$('editor-error').textContent = error.message; if (error instanceof S.StorageError) warning(error.message); }
  });
  $('add-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const destination = targetTag();
      await commit('addWord', { tagId: destination, english: $('word-input').value, meaning: $('meaning-input').value, exampleSentence:$('word-example').value, exampleTranslation:$('word-translation').value, note:$('word-note').value });
      const added = data.words[data.words.length - 1].id;
      if (shuffleRanks) shuffleRanks.set(added, shuffleRanks.size);
      $('add-form').reset();
      // Reset entered text, but keep the user's explicit destination for the next word.
      $('composer-target').value = destination;
      page = pageOf(added); emphasizeWord(added, 'added'); pulse($('add-word'), 'is-done', 420); feedback(folioLabel(added) + ' 已添加并保存。'); $('word-input').focus();
    } catch (error) {
      // The add button lives in the composer bar, so a rejected entry sends focus back to the field at fault.
      // The panel never folds and nothing typed is cleared.
      report(error);
      if (error.code === 'validation' && composerShown) entryFieldFor(error.message)?.focus();
    }
  });
  const ENTRY_HINTS = [['备注', 'word-note'], ['例句中文翻译', 'word-translation'], ['英文例句', 'word-example'], ['中文释义', 'meaning-input'], ['英文', 'word-input']];
  function entryFieldFor(message) {
    if (!$('word-input').value.trim()) return $('word-input');
    if (!$('meaning-input').value.trim()) return $('meaning-input');
    const hit = ENTRY_HINTS.find(([text]) => message.includes(text)); return hit ? $(hit[1]) : null;
  }
  $('word-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('meaning-input').focus(); } });
  // Ctrl/⌘+Enter submits from any entry or word-editor field.
  for (const [form, ids] of [['add-form', ENTRY_FIELDS], ['editor-form', ['edit-english','edit-meaning','edit-example','edit-translation','edit-note']]]) for (const id of ids) {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); if (!busy) $(form).requestSubmit(); } });
  }
  let confirming = false;
  $('confirm-dialog').addEventListener('cancel', e => { if (confirming) e.preventDefault(); });
  $('cancel-confirm').addEventListener('click', () => { if (!confirming) $('confirm-dialog').close(); });
  $('accept-confirm').addEventListener('click', async () => {
    if (confirming || !confirmation) return;
    confirming = true; $('accept-confirm').disabled = true; $('cancel-confirm').disabled = true;
    const action = confirmation, account = accountGeneration;
    try { await action(); if (account === accountGeneration && confirmation === action) { $('confirm-dialog').close(); confirmation = null; } }
    catch (error) { if(account !== accountGeneration || authFailure(error))return;$('confirm-error').textContent = error.message; if (error instanceof S.StorageError) warning(error.message); }
    finally { confirming = false; $('accept-confirm').disabled = false; $('cancel-confirm').disabled = false; }
  });
  $('confirm-dialog').addEventListener('close', () => { confirmation = null; returnFocus(confirmReturnFocus); });
  $('delete-tag').addEventListener('click', () => {
    const tag = currentTag(), count = data.words.filter(w => w.tagId === tag.id).length;
    confirmAction('删除账本', `确认删除账本“${tag.name}”？\n其中的 ${count} 条词条也会一并删除。建议先导出 JSON 备份。`, '删除账本及词条', async () => {
      // A deleted 子账本 hands over to its 主账本 while other 子账本 remain there.
      const master = view?.master;
      await commit('deleteTag', { id: tag.id }); view = master && ledgers().byKey.has(master) ? { master, filter: {} } : defaultView();
      $('add-form').reset(); page = 1; render(); feedback('账本及其中词条已删除。');
    });
  });
  $('word-list').addEventListener('change', async e => {
    if (e.target.dataset.action !== 'toggle') return;
    const checkbox = e.target, row = checkbox.closest('[data-word-id]'), oldIndex = [...$('word-list').children].indexOf(row);
    try {
      await commit('toggleWord', { id: row.dataset.wordId, mastered: checkbox.checked }); emphasizeWord(row.dataset.wordId, 'confirmed'); feedback('掌握状态已保存。');
      const same = [...$('word-list').children].find(el => el.dataset.wordId === row.dataset.wordId);
      const target = same || $('word-list').children[Math.min(oldIndex, $('word-list').children.length - 1)];
      (target?.querySelector('input[type="checkbox"]') || $('status-filter')).focus();
    } catch (error) { checkbox.checked = !checkbox.checked; report(error); }
  });
  $('word-list').addEventListener('click', e => {
    const button = e.target.closest('button[data-action]'); if (!button) return;
    // A result's cross-link opens its exact ledger with a clean in-ledger search, so the found word is listed.
    if (button.dataset.action === 'openTag') { selectView(G.viewOf(ledgers(), button.dataset.tagId), false, true); return; }
    const row = button.closest('[data-word-id]'), word = data.words.find(w => w.id === row.dataset.wordId);
    if (button.dataset.action === 'edit') openEditor('word', word);
    else if (button.dataset.action === 'delete') confirmAction('删除词条', `确认删除“${word.english}”？此操作将移除整条词条记录。`, '删除词条', async () => {
      await commit('deleteWord', { id: word.id });
      // Saved first; only then does the card leave. Focus moves to a neighbouring card, not the departing one.
      const rows = [...$('word-list').children], at = rows.indexOf(row), next = rows[at + 1]?.dataset.wordId || rows[at - 1]?.dataset.wordId;
      const account = accountGeneration;
      confirmReturnFocus = { element: row, wordId: next, action: 'edit' };
      if (row.isConnected) { row.inert = true; row.classList.add('word-leaving'); await later(170); }
      if (account !== accountGeneration) return;
      render(); feedback('词条已删除。');
    });
  });
  for (const id of ['global-search', 'local-search']) {
    $(id).addEventListener('input', () => { page = 1; render(); });
    // Escape empties a search line in every browser (not only where type=search does it natively).
    $(id).addEventListener('keydown', e => { if (e.key === 'Escape' && !e.isComposing && $(id).value) { e.preventDefault(); $(id).value = ''; $(id).dispatchEvent(new Event('input', { bubbles: true })); } });
  }
  // "/" jumps to the nearest search line: the in-ledger one while a ledger is open (unfolding the phone toolbar if
  // needed), otherwise the header search. Never while typing, composing or inside a dialog.
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return;
    if (e.target.closest?.('input,textarea,select,[contenteditable]') || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    const local = $('local-search');
    if (view && !globalMode() && !$('ledger-bar').hidden && local.getClientRects().length) { local.focus(); local.select(); return; }
    $('global-search').focus(); $('global-search').select();
  });
  $('status-filter').addEventListener('change', () => { page = 1; render(); });
  $('sort-order').addEventListener('change', () => {
    sortMode = O.MODES.includes($('sort-order').value) ? $('sort-order').value : 'asc';
    // Choosing 乱序 again always deals a fresh arrangement; other modes drop the old one.
    shuffleRanks = sortMode === 'shuffle' ? O.shuffle(data.words.map(w => w.id)) : null;
    page = 1; listMotion = sortMode === 'shuffle' ? 'dealt' : 'resorted'; render();
  });
  $('reshuffle').addEventListener('click', () => {
    shuffleRanks = O.shuffle(data.words.map(w => w.id)); page = 1; listMotion = 'dealt'; render();
    pulse($('reshuffle'), 'is-spun', 420); feedback('已重新洗牌。');
  });
  $('loading-retry').addEventListener('click', () => $('reload-button').click());
  $('clear-global').addEventListener('click', () => { $('global-search').value = ''; page = 1; render(); $('global-search').focus(); });
  for (const [id, change] of [['page-prev', -1], ['page-next', 1]]) $(id).addEventListener('click', () => { page += change; if (!reducedMotion.matches) listMotion = 'resorted'; render(); $('results-title').scrollIntoView({ block: 'nearest' }); });
  $('export-button').addEventListener('click', async () => { try { const latest=await store.read(); exportData(latest, undefined, await reviewSection(latest)); pulse($('export-button'), 'is-done', 900); feedback(store.mode==='guest'?'已下载游客账本 JSON，请妥善保管。':'已下载最新云端账本 JSON，请妥善保管。'); } catch (error) { report(error); } });
  $('import-button').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      if (file.size > M.LIMITS.bytes + REVIEW_BYTES) throw new M.LedgerError('文件过大，账本最多 8 MiB（复习记录另计 16 MiB）。');
      let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw new M.LedgerError('文件不是有效 UTF-8，现有账本未改变。');}
      const split = R.splitBackup(raw), imported = M.parse(split.ledgerRaw), s = M.stats(imported.words);
      const importedReview = split.review ? { cards: new Map(split.review.cards.map(c => [c.wordId, c])), days: new Map(split.review.days.map(d => [d.day, d])), settings: split.review.settings } : null;
      const reviewNote = importedReview ? `\n文件还包含 ${importedReview.cards.size} 条复习记录：覆盖时一并恢复；合并时保留现有设置，逐日统计取较大值，避免重复导入累加。` : '';
      const preview=M.mergePreview(data,imported);
      confirmAction('导入备份 · 先核对再选择', `文件“${file.name}”包含 ${imported.tags.length} 个账本、${s.total} 条词条（${s.mastered} 条已掌握）。\n当前有 ${data.tags.length} 个账本、${data.words.length} 条词条。重名账本 ${preview.tags} 个，可能重名词条 ${preview.words} 条。\n“合并”会为重名账本加导入后缀，保留全部记录；“覆盖”会替换当前全部数据。两种操作均先下载当前备份。${reviewNote}\n取消不改变任何数据。`, '备份并覆盖恢复', async () => {
        if (hasData) {
          const before=await store.read();
          if(before.revision!==data.revision)throw new S.StorageError('账本已在另一设备修改。请重新读取后再次导入，原数据未覆盖。','conflict');
          exportData(before, 'vocabulary-before-restore', await reviewSection(before));
        }
        const review=importedReview&&R.toSection(importedReview,imported.words);
        data = await saving(()=>store.save(imported, { restore: true,...(review?{review,expectedReviewRevision:reviewStore.revision}:{}) })); hasData = true; view = defaultView();
        await restoreReview(review);
        $('add-form').reset(); $('global-search').value = ''; $('local-search').value = ''; $('status-filter').value = 'all'; page = 1;
        warning(null); status(); render(); feedback('账本已完整恢复并保存。');
      });
      mergeImport=async()=>{
        const before=await store.read();if(before.revision!==data.revision)throw new S.StorageError('账本已变化，请重新读取核对。','conflict');
        const merged=M.merge(before,imported);exportData(before,'vocabulary-before-merge',await reviewSection(before));
        const map=new Map(imported.words.map((w,i)=>[w.id,merged.words[before.words.length+i].id]));
        const review=importedReview&&R.toSection(R.mergeSection(reviewStore,importedReview,map),merged.words);
        data=await saving(()=>store.save(merged,{restore:true,...(review?{review,expectedReviewRevision:reviewStore.revision}:{})}));hasData=true;view=defaultView();
        // LedgerModel.merge appends the imported words after the existing ones, in file order: that fixes the id map.
        if(review)await restoreReview(review);
        $('add-form').reset();page=1;warning(null);status();render();feedback('备份已合并，全部记录均已保留。');
      };$('merge-confirm').hidden=false;
    } catch (error) { report(error); }
  });
  $('reload-button').addEventListener('click',async()=>{ if(busy)return; await refresh(true); });
  window.addEventListener('ledger-sharing-received',async()=>{if(store.mode==='cloud'&&!busy)await refresh(true);});
  window.addEventListener('ledger-sharing-auth',e=>{if(identity?.key===e.detail)clearAccount(true);});
  let refreshGeneration = 0;
  function refresh(manual=false) {
    if (!manual && automaticRefresh?.account === accountGeneration) return automaticRefresh.promise;
    const flight = { account: accountGeneration, promise: refreshOnce(manual) };
    if (!manual) {
      automaticRefresh = flight;
      const settled = () => { if (automaticRefresh === flight) automaticRefresh = null; };
      flight.promise.then(settled, settled);
    }
    return flight.promise;
  }
  async function refreshOnce(manual=false) {
    if(store.mode!=='cloud') return;
    const account=accountGeneration;
    let request=0, generation=mutationGeneration;
    try { const currentIdentity=await sessionGate.check();if(account!==accountGeneration)return;
      if(!currentIdentity.authenticated||currentIdentity.key!==identity.key){clearAccount(true);feedback('登录状态已变化，原账号数据已清理。请登录读取当前账号账本。',true);return;}
      if (document.body.classList.contains('identity-check')) setIdentityGuard(false);
      if(busy || $('confirm-dialog').open)return;
      if(!manual && await store.revision()===data.revision)return;
      // Only the newest read may change data/status; a save always owns its pending status.
      request=++refreshGeneration; generation=mutationGeneration;
      if(manual){status('正在重新读取云端账本…');pulse($('reload-button'),'is-spun',420);if(!hasData){loadingPanel('loading','正在重新连接云端账本','读取完成后会自动显示。');render();}}
      const latest=await store.read(); if(busy || generation!==mutationGeneration||account!==accountGeneration||request!==refreshGeneration)return;
      if(manual)loadingPanel(null);
      if(latest.revision!==data.revision || manual) { data=latest; hasData=true; store.current=M.clone(data); ensureView(); render(); }
      if(manual) { store.current=M.clone(data); store.pending=null; store.blocked=false; warning(null); status('已读取最新云端记录 · 未提交输入已保留'); const review=reviewStore; if(!review.pending) review.load().then(()=>{if(review===reviewStore){reviewStamp++;updateReviewEntry();reviewUI.refresh();}}); }
    } catch(error) {
      if (account !== accountGeneration || error.code === 'stale') return;
      if (error.code === 'auth') { clearAccount(true); feedback('登录状态已失效，旧账号数据已清理。请重新登录。', true); return; }
      if (document.body.classList.contains('identity-check')) { setIdentityGuard(true, '网络暂不可用，私人内容仍受保护，当前输入已保留。请重新验证。'); return; }
      if(busy||generation!==mutationGeneration||(request&&request!==refreshGeneration))return;
      if(manual){if(!hasData){loadingPanel('error','云端账本读取失败',error.message);render();}report(error);}
      else feedback('暂时无法复核云端状态，当前内容和输入已保留。', true);
    }
  }
  function identityAway() {
    if (store.mode !== 'cloud' || awaySince !== null) return;
    awaySince = Date.now();
    awayTimer = setTimeout(() => { if (awaySince !== null && store.mode === 'cloud') setIdentityGuard(true); }, PRIVACY_AFTER_MS);
  }
  function identityResume() {
    if (store.mode !== 'cloud') return;
    const longAway = awaySince !== null && Date.now() - awaySince >= PRIVACY_AFTER_MS;
    awaySince = null; clearTimeout(awayTimer); clearTimeout(resumeTimer);
    if (longAway) setIdentityGuard(true);
    // Visibility and focus normally arrive together; one scheduled refresh and one in-flight request.
    resumeTimer = setTimeout(() => { resumeTimer = null; if (!document.hidden) refresh(); }, 60);
  }
  $('identity-retry').addEventListener('click', () => { setIdentityGuard(true); refresh(); });
  $('identity-guard').addEventListener('cancel', event => event.preventDefault());
  window.addEventListener('focus', identityResume);
  window.addEventListener('blur', identityAway);
  window.addEventListener('blur', pauseFeedback);
  window.addEventListener('focus', resumeFeedback);
  document.addEventListener('visibilitychange', () => document.hidden ? pauseFeedback() : resumeFeedback());
  document.addEventListener('visibilitychange',()=>document.hidden ? identityAway() : identityResume());
  $('feedback').addEventListener('pointerenter', pauseFeedback);
  $('feedback').addEventListener('pointerleave', resumeFeedback);
  window.addEventListener('beforeunload', e => {
    if (!leaving && (drafts() || busy || store.pending || reviewStore.pending || (store.mode==='guest'&&store.dirty))) { e.preventDefault(); e.returnValue = ''; }
  });
  for (const dialog of [$('editor-dialog'), $('confirm-dialog'),$('auth-dialog'),$('review-dialog'),$('facet-sheet'),$('groups-dialog')]) {
    dialog.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('button, input, textarea, select, a[href], [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    });
  }
  $('merge-confirm').addEventListener('click',async()=>{try{await mergeImport();$('confirm-dialog').close();}catch(error){if(authFailure(error))return;$('confirm-error').textContent=error.message;}});
  $('sign-in').addEventListener('click',e=>{
    if(store.mode!=='guest')return;
    if(data.tags.length||data.words.length||drafts()){
      e.preventDefault();authExported=false;$('auth-continue').setAttribute('aria-disabled','true');$('draft-ack').checked=false;
      $('draft-ack-label').hidden=!drafts();$('auth-description').textContent=`当前游客数据：${data.tags.length} 个账本，${data.words.length} 条词条。尚未提交的输入不在 JSON 中，请先提交或另行备份。`;
      $('auth-error').textContent='';$('auth-dialog').showModal();$('auth-cancel').focus();
    }else leaving=true;
  });
  $('auth-export').addEventListener('click',()=>{exportData(data,'vocabulary-guest',R.toSection(reviewStore,data.words));authExported=true;$('auth-continue').setAttribute('aria-disabled',String(!$('draft-ack-label').hidden&&!$('draft-ack').checked));});
  $('draft-ack').addEventListener('change',()=>{$('auth-continue').setAttribute('aria-disabled',String(!authExported||!$('draft-ack').checked));});
  $('auth-cancel').addEventListener('click',()=>{$('auth-dialog').close();$('sign-in').focus();});
  $('auth-continue').addEventListener('click',e=>{if(!authExported||(!$('draft-ack-label').hidden&&!$('draft-ack').checked)){e.preventDefault();$('auth-error').textContent='请先导出游客账本，并处理未提交输入。';return;}leaving=true;});
  $('sign-out').addEventListener('click',e=>{
    if(busy||store.pending||reviewStore.pending){e.preventDefault();reviewStore.flush();feedback('仍有未完成或尚未确认的保存。请先确认同步后退出。',true);return;}
    if(leaving)return;
    e.preventDefault();const leave=()=>{leaving=true;clearAccount(true);$('sign-out').click();};
    if(drafts())confirmAction('退出登录','云端已确认的记录会保留。尚未提交的输入将清空。是否退出？','清空输入并退出',leave);else leave();
  });
  // bfcache must never restore another person's private records.
  window.addEventListener('pagehide',()=>{if(store.mode==='cloud'){reviewStore.flush({keepalive:true});clearAccount();}});
  window.addEventListener('pageshow',e=>{if(e.persisted){clearAccount();load();}});
  load();
})();
