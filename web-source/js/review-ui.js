(function () {
  'use strict';
  // 智能复习 dialog: overview (today, scope, statistics), a study session on the existing flip cards, and a short guide
  // to the forgetting curve. Scheduling is LedgerCurve (fixed 1·2·3·5·7-day ladder); persistence goes through the
  // review store handed in by app.js. Flipping a card counts one recitation (每日背诵); 「记得」 moves the card up the
  // curve, 「忘记」 sends it to the back of this round without moving it, and 「标记为已掌握」 goes through the
  // ledger's ordinary toggle so the word's mastered state stays the single source of truth.
  const F = window.LedgerCurve, R = window.LedgerReview, D = window.LedgerFlashcards, G = window.LedgerGroups;
  const $ = id => document.getElementById(id);
  // [grade sent to the store, button id]. Grade 3 keeps the 记得 meaning older servers already understand.
  const GRADES = Object.freeze([[1, 'rv-forget'], [3, 'rv-remember']]);
  const SECONDS_PER_CARD = 8;
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function mount(deps) {
    const { node, richText, reducedMotion } = deps;
    const dialog = $('review-dialog'), home = $('rv-home'), sessionView = $('rv-session'), guide = $('rv-guide');
    const stage = $('rv-stage'), deck = $('rv-deck');
    let viewName = 'home', scope = null, scopeOpen = false, settingsOpen = false, customOpen = false, session = null, locked = false, liveSeq = 0;
    let gesture = null, suppressUntil = 0, undo = null, hintShown = false, loadingReview = false, openEpoch=0, resetTimer = 0;
    const timers = new Map();
    const later = (name, ms, fn) => { clearTimeout(timers.get(name)); timers.set(name, setTimeout(() => { timers.delete(name); fn(); }, reducedMotion.matches ? Math.min(ms, 1) : ms)); };
    const cancel = name => { clearTimeout(timers.get(name)); timers.delete(name); };
    const restartClass = (el, name, ms) => { el.classList.remove(name); void el.offsetWidth; el.classList.add(name); later('cls:' + name, ms, () => el.classList.remove(name)); };
    const store = () => deps.store();
    const art = id => { const t = $(id); return t ? t.content.cloneNode(true) : document.createDocumentFragment(); };
    const button = (label, className, onClick) => { const b = node('button', className, label); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };
    function announce(text) { const live = $('rv-live'), seq = ++liveSeq; live.textContent = ''; requestAnimationFrame(() => { if (seq === liveSeq) live.textContent = text; }); }

    // ── Data views ──────────────────────────────────────────────────────────────────────────────────────────
    function context() {
      const { data, org, ranks, folios } = deps.ledger();
      const words = [...data.words].sort((a, b) => ranks.get(a.id) - ranks.get(b.id));
      return { data, org, folios, words, s: store(), now: Date.now() };
    }
    const today = now => R.statisticsDay(now, store().settings);
    const counters = (s, now) => ({ ...R.zero(today(now)), ...(s.days.get(today(now)) || {}) });
    function scopeTags(org) {
      const all = [...org.masters.flatMap(m => m.subs.map(x => x.tag.id)), ...org.customs.map(t => t.id)];
      return scope ? all.filter(id => scope.has(id)) : all;
    }
    function scopeLabel(org) {
      if (!scope) return '全部账本';
      const ids = new Set(scopeTags(org)); if (!ids.size) return '未选择账本';
      const names = [];
      for (const m of org.masters) { const subs = m.subs.filter(x => ids.has(x.tag.id)); if (!subs.length) continue; if (subs.length === m.subs.length) names.push(G.display(m)); else for (const x of subs) names.push(x.tag.name); }
      for (const t of org.customs) if (ids.has(t.id)) names.push(t.name);
      return names.length <= 2 ? names.join('、') : names.slice(0, 2).join('、') + ` 等 ${names.length} 本`;
    }
    function planFor(c, scoped = true) {
      const learnedToday = counters(c.s, c.now).learned;
      return R.plan({ words: c.words, cards: c.s.cards, now: c.now, settings: c.s.settings, learnedToday, scope: scoped && scope ? new Set(scopeTags(c.org)) : null });
    }

    // ── View switching ──────────────────────────────────────────────────────────────────────────────────────
    function show(name, { focus = true } = {}) {
      viewName = name; dialog.dataset.view = name;
      home.hidden = name !== 'home'; sessionView.hidden = name !== 'session'; guide.hidden = name !== 'guide';
      $('rv-back').hidden = name === 'home';
      $('rv-counter').hidden = name !== 'session'; $('rv-progress').hidden = name !== 'session';
      const shown = name === 'home' ? home : name === 'session' ? sessionView : guide;
      if (!reducedMotion.matches) restartClass(shown, 'is-entering', 320);
      $('rv-title').textContent = name === 'guide' ? '遗忘曲线与复习算法' : name === 'session' && session ? session.title : '智能复习';
      if (name === 'guide' && !reducedMotion.matches) restartClass(guide.querySelector('.rv-curve') || guide, 'is-drawing', 2400);
      if (!focus) return;
      if (name === 'session') stage.focus({ preventScroll: true });
      else if (name === 'guide') $('rv-guide-back').focus({ preventScroll: true });
      else (home.querySelector('[data-rv-primary]') || home.querySelector('button') || $('rv-close')).focus({ preventScroll: true });
    }

    // ── Overview ────────────────────────────────────────────────────────────────────────────────────────────
    function renderHome() {
      const c = context(), org = c.org, p = planFor(c), queue = p.due.length + p.fresh.length, day = counters(c.s, c.now);
      const frag = document.createDocumentFragment();
      // Today
      const todayBlock = node('section', 'rv-today'); todayBlock.setAttribute('aria-labelledby', 'rv-today-title');
      const figure = node('div', 'rv-hero');
      const text = node('div', 'rv-today-text');
      const date = new Date(today(c.now) + 'T12:00:00Z');
      text.append(node('p', 'rv-date', `${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日 · 星期${WEEK[date.getUTCDay()]}`));
      const title = node('h3', 'rv-today-title'); title.id = 'rv-today-title';
      const sub = node('p', 'rv-today-sub'), actions = node('div', 'rv-today-actions'), extra = node('p', 'rv-today-extra');
      const inScope = c.words.filter(w => !scope || scope.has(w.tagId));
      if (!c.words.length) {
        figure.append(art('art-blank'));
        title.textContent = '先录入一些词条'; sub.textContent = '复习会按遗忘曲线安排每个词条的下一次出现。录入词条后回到这里即可开始。';
        actions.append(button('看看遗忘曲线怎么工作', 'quiet rv-link', () => show('guide')));
      } else if (!inScope.length) {
        figure.append(art('art-blank'));
        title.textContent = '这个范围里还没有词条'; sub.textContent = '在下方「复习范围」中换一组账本。';
      } else if (queue) {
        figure.append(art('art-review-hero'));
        if (p.due.length) title.append(node('span', 'rv-num', String(p.due.length)), document.createTextNode(' 张待复习'));
        if (p.due.length && p.fresh.length) title.append(document.createTextNode('，'));
        if (p.fresh.length) title.append(node('span', 'rv-num', String(p.fresh.length)), document.createTextNode(p.due.length ? ' 个新词' : ' 个新词待学'));
        sub.textContent = `约 ${Math.max(1, Math.ceil(queue * SECONDS_PER_CARD / 60))} 分钟 · ${scopeLabel(org)}`;
        const start = button('开始复习', 'primary rv-start', () => startSession('review')); start.dataset.rvPrimary = '';
        actions.append(start, button('翻阅卡片', 'quiet rv-browse', () => startSession('browse')));
        if (!p.fresh.length && p.freshTotal) extra.textContent = `今日新词已达上限 ${R.normalizeSettings(c.s.settings).newPerDay} 个，可在「复习设置」中调整。`;
      } else {
        figure.append(art('art-review-done'));
        title.textContent = '今天的复习都完成了';
        const next = R.nextDue({ words: c.words, cards: c.s.cards, scope: scope ? new Set(scopeTags(org)) : null });
        sub.textContent = (next ? `下一张将在 ${when(next, c.now)} 到期` : '还没有排进计划的词条') + ' · ' + scopeLabel(org);
        const ahead = R.ahead({ words: c.words, cards: c.s.cards, now: c.now, scope: scope ? new Set(scopeTags(org)) : null });
        if (ahead.length) { const b = button(`提前巩固 ${ahead.length} 张`, 'primary rv-start', () => startSession('ahead')); b.dataset.rvPrimary = ''; actions.append(b); }
        if (p.freshTotal) actions.append(button('多学 10 个新词', ahead.length ? 'quiet' : 'primary rv-start', () => startSession('extra')));
        actions.append(button('翻阅卡片', 'quiet rv-browse', () => startSession('browse')));
      }
      text.append(title, sub, actions); if (extra.textContent) text.append(extra);
      todayBlock.append(figure, text);
      if (loadingReview || (c.s.mode==='cloud'&&!c.s.loaded)) { for(const b of actions.querySelectorAll('button'))b.disabled=true; const dots = node('p', 'rv-loading'); dots.append(node('span', 'cm-dots'), document.createTextNode(loadingReview?'正在读取云端复习进度…':'复习进度尚未读取，请关闭后重试。')); dots.firstChild.append(node('i'), node('i'), node('i')); text.append(dots); }
      // Scope
      const scopeBlock = renderScope(c);
      // Statistics
      const stats = renderStats(c, day);
      // Foot: guide link, settings, sync line
      const foot = node('div', 'rv-foot');
      const guideLink = button('', 'quiet rv-guide-link', () => show('guide'));
      guideLink.append(icon('curve'), node('span', '', '遗忘曲线与复习算法'));
      const settingsToggle = button('', 'quiet rv-settings-toggle', () => { settingsOpen = !settingsOpen; customOpen = false; renderHome(); home.querySelector('.rv-settings-toggle')?.focus({ preventScroll: true }); });
      settingsToggle.append(node('span', '', '复习设置'), node('span', 'rv-settings-now', `每日新词 ${R.normalizeSettings(c.s.settings).newPerDay}`));
      settingsToggle.setAttribute('aria-expanded', String(settingsOpen));
      foot.append(guideLink, settingsToggle, node('span', 'rv-sync rv-sync-' + c.s.status, syncText(c.s)));
      const left = node('div', 'rv-col rv-col-main'), right = node('div', 'rv-col rv-col-side');
      left.append(todayBlock, scopeBlock); right.append(stats);
      frag.append(left, right, foot);
      if (settingsOpen) frag.append(renderSettings(R.normalizeSettings(c.s.settings)));
      home.replaceChildren(frag);
    }
    function syncText(s) {
      if (s.mode === 'guest') return '游客：复习进度只在本页，导出 JSON 时一并备份';
      return { synced: '复习进度已同步', pending: '正在同步复习进度…', offline: '复习进度暂未同步，联网后自动重试', error: '有一批复习记录未被云端接受' }[s.status] || '';
    }
    function when(ms, now) {
      const days = F.dayDiff(now, ms);
      if (days <= 0) return '今天'; if (days === 1) return '明天'; if (days === 2) return '后天';
      return days < 31 ? days + ' 天后' : new Date(ms).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
    }
    function renderScope(c) {
      const org = c.org, block = node('section', 'rv-scope'), end = R.endOfToday(c.now);
      const per = new Map();
      for (const w of c.words) {
        const s = per.get(w.tagId) || { total: 0, due: 0, fresh: 0 }; s.total++;
        if (!w.mastered) { const card = c.s.cards.get(w.id); if (!card) s.fresh++; else if (R.isDue(card,c.now)) s.due++; }
        per.set(w.tagId, s);
      }
      const sum = ids => ids.reduce((a, id) => { const s = per.get(id) || { total: 0, due: 0, fresh: 0 }; return { total: a.total + s.total, due: a.due + s.due, fresh: a.fresh + s.fresh }; }, { total: 0, due: 0, fresh: 0 });
      const head = node('div', 'rv-scope-head');
      head.append(node('h4', 'rv-h', '复习范围'));
      const chosen = scopeTags(org), total = sum(chosen);
      const toggle = button('', 'rv-scope-toggle', () => { scopeOpen = !scopeOpen; renderHome(); home.querySelector('.rv-scope-toggle')?.focus({ preventScroll: true }); });
      toggle.setAttribute('aria-expanded', String(scopeOpen)); toggle.setAttribute('aria-controls', 'rv-scope-list');
      toggle.append(node('span', 'rv-scope-name', scopeLabel(org)), node('span', 'rv-scope-count', `${total.total} 条`), icon('chevron'));
      head.append(toggle);
      const quick = node('div', 'rv-quick');
      const allChip = button('全部账本', 'rv-chip', () => { scope = null; renderHome(); }); allChip.setAttribute('aria-pressed', String(!scope));
      quick.append(allChip);
      const current = deps.ledger().viewTags;
      if (current.length) {
        const ids = current.map(t => t.id), same = scope && scope.size === ids.length && ids.every(id => scope.has(id));
        const label = deps.ledger().viewLabel;
        const chip = button('当前：' + label, 'rv-chip', () => { scope = new Set(ids); renderHome(); }); chip.setAttribute('aria-pressed', String(Boolean(same)));
        quick.append(chip);
      }
      block.append(head, quick);
      if (scopeOpen) {
        const list = node('div', 'rv-scope-list'); list.id = 'rv-scope-list'; list.setAttribute('role', 'group'); list.setAttribute('aria-label', '选择复习的账本');
        const has = id => !scope || scope.has(id);
        const set = (ids, on) => {
          const next = new Set(scopeTags(org)); for (const id of ids) { if (on) next.add(id); else next.delete(id); }
          const every = [...org.masters.flatMap(m => m.subs.map(x => x.tag.id)), ...org.customs.map(t => t.id)];
          scope = next.size === every.length ? null : next; renderHome();
          const again = home.querySelector(`[data-scope-key="${CSS.escape(ids.join(','))}"]`); again?.focus({ preventScroll: true });
        };
        const row = (label, meta, ids, className, langEn) => {
          const wrap = node('label', 'rv-scope-row ' + className), box = node('input'); box.type = 'checkbox';
          const on = ids.filter(has).length; box.checked = on === ids.length && ids.length > 0; box.indeterminate = on > 0 && on < ids.length;
          box.dataset.scopeKey = ids.join(','); box.addEventListener('change', () => set(ids, box.checked));
          const name = node('span', 'rv-scope-label', label); if (langEn) name.lang = 'en';
          const s = sum(ids), info = node('span', 'rv-scope-meta', meta || ''), tally = node('span', 'rv-scope-tally');
          tally.append(node('b', '', String(s.due)), document.createTextNode(' 待复习 · ' + s.total + ' 条'));
          wrap.append(box, name, info, tally); return wrap;
        };
        for (const m of org.masters) {
          if (!m.subs.length) continue;
          const group = node('div', 'rv-scope-group');
          group.append(row(G.display(m), G.caption(m), m.subs.map(x => x.tag.id), 'is-master', m.kind !== 'custom'));
          const subs = node('div', 'rv-scope-subs');
          for (const x of m.subs) subs.append(row(G.subLabel(m, x), '', [x.tag.id], 'is-sub'));
          group.append(subs); list.append(group);
        }
        for (const t of org.customs) list.append(row(t.name, t.date, [t.id], 'is-custom'));
        if (!org.masters.length && !org.customs.length) list.append(node('p', 'hint', '还没有账本。'));
        block.append(list);
      }
      return block;
    }
    // 学习记录 (every ledger). Three different counts are kept apart on purpose:
    //  · 背诵 / 作答 — events: each first turn of a card to its back / each 记得·忘记 (one word can count several times);
    //  · 复习过 — distinct words answered today (from the stored state, deleted words excluded);
    //  · 新学 — distinct words that entered review for the first time today (the daily allowance counts these).
    // Day counters belong to the learner's local calendar and roll over at local midnight (see the reset line).
    function renderStats(c, day) {
      const block = node('section', 'rv-stats'); block.setAttribute('aria-labelledby', 'rv-stats-title');
      const head = node('div', 'rv-stats-head'), h = node('h4', 'rv-h', '学习记录'); h.id = 'rv-stats-title';
      head.append(h, node('span', 'rv-reset', resetText(c.now))); block.append(head);
      // A cloud account's numbers are only shown once its review state has been read: before that every word would
      // look 未学习 and every count 0 (the flash seen right after a reload). A re-read keeps the last confirmed numbers.
      const loaded = c.s.mode !== 'cloud' || c.s.loaded;
      block.dataset.ready = String(loaded && !loadingReview);
      if (!loaded) {
        const wait = node('p', 'rv-loading rv-stats-wait'); wait.append(node('span', 'cm-dots'), document.createTextNode(loadingReview ? '正在读取复习进度，读取后显示统计。' : '复习进度尚未读取，统计暂不显示。'));
        wait.firstChild.append(node('i'), node('i'), node('i')); block.append(wait); return block;
      }
      const figures = node('dl', 'rv-figures');
      for (const [label, value, hint, title] of [['今日背诵', day.flips, '次', '翻到反面的次数，同一词条再次出现会再计一次'], ['新学', day.learned, '个', '今天第一次进入复习的词条数'], ['新掌握', day.mastered, '个', '今天标记为已掌握的词条数'], ['连续学习', R.streak(c.s.days, c.now, c.s.settings), '天', '截至今天（或昨天）连续有学习记录的天数']]) {
        const box = node('div'); box.title = title; const dd = node('dd'); dd.append(node('span', 'rv-fig', String(value)), node('small', '', hint)); box.append(node('dt', '', label), dd); figures.append(box);
      }
      block.append(figures);
      // Today's progress across every ledger: finished words out of finished + still waiting today.
      const all = planFor(c, false), mine = R.today(c.words, c.s.cards, c.now, c.s.settings), done = mine.finished, left = all.due.length + all.fresh.length;
      const pct = done + left ? Math.round(done / (done + left) * 100) : 0;
      const progress = node('div', 'rv-progress-line');
      const bar = node('div', 'rv-meter'); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', '今日复习进度'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(pct)); bar.setAttribute('aria-valuetext', `已完成 ${done} 个词条，还剩 ${left} 个`);
      const fill = node('span', 'rv-meter-fill'); fill.style.setProperty('--pct', pct + '%'); bar.append(fill);
      progress.append(node('p', 'rv-progress-text', left ? `今日进度 · 已完成 ${done} 个词条，还剩 ${left} 个` : done ? `今日进度 · 已完成 ${done} 个词条，全部完成` : '今日进度 · 还没有开始'), bar);
      if (day.ratings || mine.answered) progress.append(node('p', 'rv-progress-note', `今天作答 ${day.ratings} 次，复习过 ${mine.answered} 个不同词条，其中新学 ${day.learned} 个`));
      block.append(progress);
      // 30-day trend: bar height = 背诵次数 that day; today's bar in clay; a clay dot above a day with 新掌握.
      const trend = R.trend(c.s.days, c.now, 30, c.s.settings), max = Math.max(4, ...trend.map(d => d.flips)), total = trend.reduce((n, d) => n + d.flips, 0);
      const active = trend.filter(d => d.flips || d.ratings || d.mastered).length, mastered = trend.reduce((n, d) => n + d.mastered, 0);
      const chart = node('figure', 'rv-trend');
      const svg = svgEl('svg', { viewBox: '0 0 300 64', class: 'rv-bars', role: 'img', 'aria-label': `近 30 天共背诵 ${total} 次，学习 ${active} 天，新掌握 ${mastered} 个` });
      svg.append(svgEl('path', { class: 'rv-base', d: 'M1 58.6c74 .5 148 .4 298-.3' }));
      trend.forEach((d, i) => {
        const x = 2 + i * 10, hgt = d.flips ? Math.max(3, Math.round(d.flips / max * 50)) : 0, tip = svgEl('title', {});
        tip.textContent = `${Number(d.day.slice(5, 7))} 月 ${Number(d.day.slice(8))} 日 · 背诵 ${d.flips} 次 · 作答 ${d.ratings} 次 · 新学 ${d.learned} 个${d.mastered ? ' · 新掌握 ' + d.mastered + ' 个' : ''}`;
        const mark = hgt ? svgEl('rect', { class: 'rv-bar' + (i === 29 ? ' is-today' : ''), x, y: 57 - hgt, width: 7, height: hgt }) : svgEl('circle', { class: 'rv-bar-zero', cx: x + 3.5, cy: 55.6, r: 1 });
        mark.dataset.day = d.day; mark.style.setProperty('--i', String(i)); mark.append(tip); svg.append(mark);
        if (d.mastered) { const dot = svgEl('circle', { class: 'rv-bar-mastered', cx: x + 3.5, cy: 57 - hgt - 4, r: 2.2 }); dot.dataset.day = d.day; dot.style.setProperty('--i', String(i)); svg.append(dot); }
      });
      const caption = node('figcaption', 'rv-trend-caption');
      caption.append(node('span', '', '近 30 天'), node('span', '', total || active ? `共背诵 ${total} 次 · 学习 ${active} 天` : '还没有记录'));
      const keys = node('ul', 'rv-trend-keys'); keys.setAttribute('aria-hidden', 'true');
      for (const [cls, text] of [['rv-tk-bar', '每日背诵'], ['rv-tk-today', '今天'], ['rv-tk-mastered', '有新掌握']]) { const li = node('li', cls); li.append(node('i'), node('span', '', text)); keys.append(li); }
      chart.append(svg, caption, keys); block.append(chart);
      // Memory distribution across every ledger: four exclusive tiers that add up to the words counted.
      const dist = R.distribution(c.words, c.s.cards);
      const strip = node('div', 'rv-dist'); strip.setAttribute('role', 'img');
      const legend = node('ul', 'rv-legend');
      const names = [['fresh', '未学习'], ['memorizing', '记忆中'], ['consolidating', '巩固中'], ['mastered', '已掌握']];
      strip.setAttribute('aria-label', `记忆分布，共 ${dist.total} 个词条：` + names.map(([k, n]) => `${n} ${dist[k]}`).join('，'));
      for (const [k, n] of names) {
        if (dist[k]) { const seg = node('span', 'rv-seg rv-seg-' + k); seg.style.flexGrow = String(dist[k]); seg.title = `${n} ${dist[k]}`; strip.append(seg); }
        const li = node('li', 'rv-key rv-key-' + k); li.append(node('i'), node('span', '', n), node('b', '', String(dist[k]))); legend.append(li);
      }
      const distHead = node('p', 'rv-dist-title'); distHead.append(node('span', '', `记忆分布 · ${dist.total} 个词条`), node('span', 'rv-dist-hint', '巩固中 = 已排进 7 天复习间隔'));
      block.append(distHead, strip, legend);
      return block;
    }
    // "距今日统计重置还剩 5 小时 12 分（UTC+8）": counters roll over at this device's local midnight.
    function resetText(now) {
      const left = Math.max(0, R.untilReset(now, store().settings)), h = Math.floor(left / 3600000), m = Math.floor(left % 3600000 / 60000);
      const zone = R.offsetLabel(R.statisticsOffset(now, store().settings));
      return `距今日统计重置 ${h ? h + ' 小时 ' : ''}${m} 分 · ${zone}`;
    }
    // Keep the reset line current while the overview is on screen (text only; local midnight re-renders via app.js).
    let resetDay = null;
    function tickReset() { const now = Date.now(), key = today(now); if (resetDay !== null && resetDay !== key && viewName === 'home') renderHome(); resetDay = key; const line = home.querySelector('.rv-reset'); if (line) line.textContent = resetText(now); }
    // 每日新词上限: ten choices in one compact 5 × 2 grid of tiles — 自定义 first, then nine presets. A custom value is
    // typed in a small inline field that only appears when 自定义 is chosen, validated, saved and echoed in the tile.
    function renderSettings(s) {
      const panel = node('div', 'rv-settings'); panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', '复习设置');
      const current = s.newPerDay, preset = R.NEW_PER_DAY.includes(current), disabled = store().mode === 'cloud' && !store().loaded;
      const wrap = node('div', 'rv-setting rv-quota');
      const head = node('div', 'rv-quota-head'), label = node('span', 'rv-quota-label', '每日新词上限'); label.id = 'rv-quota-label';
      head.append(label, node('span', 'rv-quota-value', current + ' 个'));
      const grid = node('div', 'rv-quota-grid'); grid.setAttribute('role', 'radiogroup'); grid.setAttribute('aria-labelledby', 'rv-quota-label');
      const customOn = customOpen || !preset;
      const tile = (text, value, on, extra = '') => {
        const b = button('', 'rv-quota-tile' + extra); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; b.disabled = disabled;
        b.dataset.quota = String(value); b.append(node('span', 'rv-quota-num', text)); return b;
      };
      const custom = tile('自定义', 'custom', customOn, ' is-custom'); custom.setAttribute('aria-controls', 'rv-quota-form');
      if (!preset) custom.append(node('span', 'rv-quota-sub', String(current)));
      grid.append(custom);
      for (const v of R.NEW_PER_DAY) grid.append(tile(String(v), v, !customOn && v === current));
      if (![...grid.children].some(b => b.tabIndex === 0)) grid.firstChild.tabIndex = 0;
      grid.addEventListener('click', e => {
        const b = e.target.closest('[data-quota]'); if (!b || b.disabled) return;
        if (b.dataset.quota === 'custom') { customOpen = true; renderHome(); const input = $('rv-quota-input'); input?.focus({ preventScroll: true }); input?.select(); return; }
        customOpen = false; save({ newPerDay: Number(b.dataset.quota) }, `[data-quota="${b.dataset.quota}"]`);
      });
      // Arrow keys move inside the radio group (one tab stop); Space / Enter choose.
      grid.addEventListener('keydown', e => {
        const tiles = [...grid.children], at = tiles.indexOf(document.activeElement); if (at < 0) return;
        const step = { ArrowRight: 1, ArrowDown: 5, ArrowLeft: -1, ArrowUp: -5, Home: -at, End: tiles.length - 1 - at }[e.key]; if (step === undefined) return;
        e.preventDefault(); const next = tiles[Math.min(tiles.length - 1, Math.max(0, at + step))];
        for (const t of tiles) t.tabIndex = t === next ? 0 : -1; next.focus({ preventScroll: true });
      });
      wrap.append(head, grid);
      if (customOn) {
        const form = node('form', 'rv-quota-form'); form.id = 'rv-quota-form'; form.noValidate = true;
        const lab = node('label', 'sr-only', '自定义每日新词数量'); lab.htmlFor = 'rv-quota-input';
        const input = node('input'); input.id = 'rv-quota-input'; input.type = 'text'; input.inputMode = 'numeric'; input.autocomplete = 'off'; input.maxLength = 4; input.placeholder = '0–' + R.MAX_NEW;
        input.value = preset ? '' : String(current); input.disabled = disabled; input.setAttribute('aria-describedby', 'rv-quota-error');
        const error = node('p', 'rv-quota-error'); error.id = 'rv-quota-error'; error.setAttribute('role', 'alert');
        const submit = button('保存', 'primary small rv-quota-save'); submit.type = 'submit'; submit.disabled = disabled;
        const field = node('div', 'rv-quota-field'); field.append(input, node('span', 'rv-quota-unit', '个 / 天'), submit);
        form.append(lab, field, error);
        form.addEventListener('submit', e => {
          e.preventDefault();
          const raw = input.value.trim().replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0));
          if (!/^\d{1,4}$/.test(raw) || Number(raw) < 0 || Number(raw) > R.MAX_NEW) { error.textContent = `请输入 0–${R.MAX_NEW} 之间的整数。0 表示只复习旧词。`; input.setAttribute('aria-invalid', 'true'); input.focus({ preventScroll: true }); return; }
          customOpen = false; save({ newPerDay: Number(raw) }, '[data-quota="custom"]');
        });
        input.addEventListener('input', () => { error.textContent = ''; input.removeAttribute('aria-invalid'); });
        input.addEventListener('keydown', e => { if (e.key === 'Escape' && preset) { e.preventDefault(); e.stopPropagation(); customOpen = false; renderHome(); home.querySelector('[data-quota="custom"]')?.focus({ preventScroll: true }); } });
        wrap.append(form);
      }
      wrap.append(node('p', 'hint', '只计算当天第一次进入复习的新词；到期复习词、本轮「忘记」后重排的卡片都不占额度。'));
      function save(patch, focusSelector) {
        try { store().record({ settings: R.normalizeSettings({ ...store().settings, ...patch }) }); }
        catch (error) { deps.feedback(error.message || '暂时无法保存复习设置。', true); }
        deps.onChange(); renderHome(); home.querySelector(focusSelector)?.focus({ preventScroll: true });
        announce(Object.hasOwn(patch, 'utcOffsetMinutes') ? '每日统计重置设置已更新' : `每日新词上限：${R.normalizeSettings(store().settings).newPerDay} 个`);
      }
      panel.append(wrap);
      const clock = node('div', 'rv-reset-setting'), clockLabel = node('label', '', '每日统计重置');
      const select = node('select'); select.id = 'rv-reset-offset'; clockLabel.htmlFor = select.id; select.disabled = disabled;
      const automatic = node('option', '', `跟随设备（${R.offsetLabel(-new Date().getTimezoneOffset())}）`); automatic.value = 'auto'; select.append(automatic);
      for (let off = -720; off <= 840; off += 15) { const option = node('option', '', R.offsetLabel(off)); option.value = String(off); select.append(option); }
      select.value = R.validOffset(s.utcOffsetMinutes) ? String(s.utcOffsetMinutes) : 'auto';
      select.addEventListener('change', () => save({ utcOffsetMinutes: select.value === 'auto' ? null : Number(select.value) }, '#rv-reset-offset'));
      clock.append(clockLabel, select, node('p', 'hint', '按所选偏移的 00:00 重置统计。固定 UTC/GMT 偏移不随夏令时改变；复习间隔保持原规则。旧记录只有日汇总，保留原日期，不倒算或复制历史次数。'));
      panel.append(clock);
      return panel;
    }

    // ── Icons and SVG helpers ───────────────────────────────────────────────────────────────────────────────
    function svgEl(tag, attrs) { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; }
    const ICONS = {
      curve: [['hi-acc', 'M7.4 6.2c1-.8 2.6-.4 2.8.9.2 1.2-.8 2.1-2 2-1.1-.1-1.6-1.3-.8-2.9zM14 8.6c.9-.6 2.2-.2 2.3.9.1 1-.7 1.7-1.7 1.6-.9 0-1.3-1-.6-2.5z'], ['hi-ink', 'M3.4 4.6c1.2 4.6 2.6 7.4 4.8 8.6M8.6 7.2c1.8 3.8 3.8 5.8 6.6 6.6M15.4 9.6c1.6 2.6 3.4 3.8 5.2 4.2'], ['hi-ink hi-thin', 'M3.2 19.2c5.8.3 11.6.3 17.6-.2']],
      chevron: [['hi-ink', 'M6.4 9.6c1.9 1.7 3.8 3.5 5.7 5.4 1.8-1.9 3.7-3.7 5.6-5.5']],
      seal: [['hi-acc', 'M7.2 6.4c3-2.2 8.2-1.6 10.2 1.4 1.8 2.8 1 7.2-1.8 9.2-3 2-7.8 1.6-9.8-1.4-1.8-2.8-1.6-7.2 1.4-9.2z'], ['hi-ink', 'M8.2 12.4c1.3.9 2.3 1.9 3.1 3.1 1.7-3.1 3.6-5.5 5.9-7.4']]
    };
    function icon(name) {
      const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'hi', 'aria-hidden': 'true', focusable: 'false' });
      for (const [cls, d] of ICONS[name]) svg.append(svgEl('path', { class: cls, d }));
      return svg;
    }

    // ── Session ─────────────────────────────────────────────────────────────────────────────────────────────
    function startSession(mode) {
      const c = context(), org = c.org, ids = scope ? new Set(scopeTags(org)) : null;
      if(c.s.mode==='cloud'&&!c.s.loaded)return;
      let queue;
      if (mode === 'review') { const p = planFor(c); queue = R.interleave(p.due, p.fresh); }
      else if (mode === 'ahead') queue = R.ahead({ words: c.words, cards: c.s.cards, now: c.now, scope: ids });
      else if (mode === 'extra') queue = c.words.filter(w => !w.mastered && (!ids || ids.has(w.tagId)) && !c.s.cards.has(w.id)).slice(0, 10).map(w => w.id);
      else queue = c.words.filter(w => !ids || ids.has(w.tagId)).map(w => w.id);
      if (!queue.length) { deps.feedback('这个范围里暂时没有可以复习的词条。'); return; }
      // Cards show where they live when the deck spans several ledgers.
      const byId = new Map(c.words.map(w => [w.id, w]));
      const tags = new Map(c.data.tags.map(t => [t.id, t])), spans = new Set(queue.map(id => byId.get(id)?.tagId)).size > 1;
      const sources = spans ? new Map(queue.map(id => { const t = tags.get(byId.get(id).tagId); return [id, G.source(org, t.id) || t.name]; })) : null;
      const cards = new Map(D.snapshot(queue.map(id => byId.get(id)), c.folios, sources).map(card => [card.id, card]));
      session = { mode, queue: [...queue], index: 0, face: 'front', flipped: false, cards, mastered: new Set(queue.filter(id => byId.get(id).mastered)), done: false,
        tally: { flips: 0, ratings: 0, again: 0, remembered: 0, learned: 0, mastered: 0 }, title: { review: '今日复习', ahead: '提前巩固', extra: '新词加练', browse: '翻阅卡片' }[mode] + ' · ' + scopeLabel(org) };
      dialog.dataset.mode = mode;
      renderCard('deal'); renderChrome(); show('session');
      if (!hintShown) {
        hintShown = true; const hint = $('rv-hint');
        hint.textContent = matchMedia('(pointer: coarse)').matches ? (mode === 'browse' ? '点按卡片翻面，左右滑动切换' : '点按卡片翻面，再选「忘记」或「记得」') : mode === 'browse' ? '点击卡片或按 Space 翻面 · ← → 切换' : '点击卡片或按 Space 翻面 · 1 忘记 · 2 记得';
        hint.classList.add('is-visible'); later('hint', 4200, () => hint.classList.remove('is-visible'));
      }
      announce(`${session.title}，共 ${session.queue.length} 张。第 1 张：${current().english}`);
    }
    const currentId = () => (session && !session.done ? session.queue[session.index] : null);
    const current = () => (currentId() ? session.cards.get(currentId()) : null);
    function renderCard(enter) {
      stage.scrollTop = 0; deck.classList.remove('is-leaving');
      if (session.done) { renderDone(); return; }
      const card = current(), left = session.queue.length - session.index - 1;
      deck.dataset.stack = String(Math.min(2, left));
      const scene = node('div', 'fc-scene'); scene.dataset.enter = enter;
      const inner = node('div', 'fc-card'); inner.dataset.id = card.id;
      inner.append(D.face('front', card, { node, richText }), D.face('back', card, { node, richText }));
      if (session.mastered.has(card.id)) inner.classList.add('is-sealed');
      const seal = node('span', 'rv-seal'); seal.setAttribute('aria-hidden', 'true'); seal.append(art('art-seal'), node('span', '', '已掌握'));
      scene.append(inner, seal); deck.replaceChildren(scene); applyFace();
    }
    function applyFace() {
      const card = deck.querySelector('.fc-card'); if (!card) return;
      card.dataset.face = session.face;
      for (const side of card.querySelectorAll('.fc-face')) { const hidden = side.dataset.side !== session.face; side.inert = hidden; side.setAttribute('aria-hidden', String(hidden)); }
      const back = session.face === 'back', rating = session.mode !== 'browse';
      $('rv-grades').hidden = !(back && rating); $('rv-front-controls').hidden = back && rating;
      $('rv-flip').setAttribute('aria-label', back ? '翻面 · 回到正面' : '翻面 · 看释义');
      stage.setAttribute('aria-label', `第 ${session.index + 1} 张，共 ${session.queue.length} 张 · ${back ? '反面' : '正面'}`);
      if (back && rating) {
        // 记得 shows the date it would set; a card that is not due (提前巩固) keeps its date.
        const id = currentId(), now = Date.now(), days = F.preview(store().cards.get(id) || null, now, R.dayKey(now), new Date(now).getTimezoneOffset());
        $('rv-forget').querySelector('.rv-grade-ivl').textContent = '放到本轮最后';
        $('rv-remember').querySelector('.rv-grade-ivl').textContent = days ? `${days} 天后再见` : '日期不变';
      }
      const sealed = session.mastered.has(currentId());
      $('rv-master').setAttribute('aria-pressed', String(sealed));
      $('rv-master').querySelector('.rv-master-text').textContent = sealed ? '已掌握 · 取消' : '标记为已掌握';
    }
    function renderChrome() {
      const n = session.queue.length, position = session.done ? n : session.index + 1;
      const pad = x => String(x).padStart(2, '0');
      $('rv-position').textContent = pad(position); $('rv-total').textContent = pad(n);
      const bar = $('rv-progress'); bar.setAttribute('aria-valuemax', String(n)); bar.setAttribute('aria-valuenow', String(position));
      bar.setAttribute('aria-valuetext', session.done ? `本轮完成，共 ${n} 张` : `第 ${position} 张，共 ${n} 张`);
      $('rv-progress-fill').style.width = (n ? (session.done ? 1 : session.index / n) * 100 : 0) + '%';
      const browse = session.mode === 'browse';
      $('rv-prev').hidden = !browse; $('rv-next').hidden = !browse;
      $('rv-shuffle').hidden=!browse;$('rv-shuffle').disabled=locked;
      $('rv-prev').disabled = session.index === 0 && !session.done; $('rv-next').disabled = session.done;
      $('rv-flip').disabled = session.done; $('rv-master').disabled = session.done || locked;
      $('rv-mode').textContent = { review: '遗忘曲线 · 1 · 2 · 3 · 5 · 7 天', ahead: '提前巩固 · 不改变复习日期', extra: '新词加练 · 超出今日上限', browse: '翻阅 · 不改变复习计划' }[session.mode];
      dialog.dataset.done = String(session.done);
      if (session.done) { $('rv-grades').hidden = true; $('rv-front-controls').hidden = !browse; }
    }
    function keepFocus() {
      const active = document.activeElement;
      if (active && dialog.contains(active) && !active.disabled && active.isConnected && active.getClientRects().length) return;
      (session?.done ? deck.querySelector('button') : stage)?.focus({ preventScroll: true });
    }
    function flip() {
      if (!session || session.done || locked) return;
      session.face = session.face === 'front' ? 'back' : 'front';
      // One recitation per showing of a card: turning it to the back the first time.
      if (session.face === 'back' && !session.flipped) {
        session.flipped = true; session.tally.flips++;
        store().record({ days: [{ ...R.zero(today(Date.now())), flips: 1 }] }); deps.onChange();
      }
      applyFace();
      const scene = deck.querySelector('.fc-scene'); if (scene && !reducedMotion.matches) restartClass(scene, 'is-turning', 640);
      const card = current(); announce(session.face === 'back' ? '反面：' + card.meaning + (session.mode !== 'browse' ? '。按 1 忘记，按 2 记得。' : '') : '正面：' + card.english);
      $('rv-hint').classList.remove('is-visible');
      keepFocus(); checkOverflow();
      if (session.face === 'back' && session.mode !== 'browse' && document.activeElement === $('rv-flip')) $('rv-remember').focus({ preventScroll: true });
    }
    function advance(enter = 'next') {
      session.index++; session.face = 'front'; session.flipped = false;
      if (session.index >= session.queue.length) { session.done = true; deps.onChange(); }
      renderCard(enter); renderChrome(); keepFocus(); checkOverflow();
      if (session.done) announce(`本轮完成，共 ${session.queue.length} 张`); else announce(`第 ${session.index + 1} 张，共 ${session.queue.length} 张：${current().english}`);
    }
    // The current card leaves the round entirely (marked mastered): the next one takes its place.
    function dropCurrent() {
      session.queue.splice(session.index, 1); session.face = 'front'; session.flipped = false;
      if (session.index >= session.queue.length) { session.done = true; deps.onChange(); }
      renderCard('next'); renderChrome(); keepFocus(); checkOverflow();
      announce(session.done ? `本轮完成，共 ${session.queue.length} 张` : `第 ${session.index + 1} 张，共 ${session.queue.length} 张：${current().english}`);
    }
    // 记得 moves the card up the curve (or keeps its date when it is not due); 忘记 leaves the curve alone and sends the
    // card to the back of this round. The round can be left at any time: what was forgotten stays due today.
    function grade(g) {
      if (!session || session.done || session.mode === 'browse' || session.face !== 'back' || locked) return;
      const id = currentId(), now = Date.now(), day = today(now), before = store().cards.get(id) || null;
      const event = { wordId: id, grade: g, at: now, day: R.dayKey(now), tz: new Date(now).getTimezoneOffset(), ...(R.validOffset(store().settings.utcOffsetMinutes) ? { statisticsDay: day, statisticsOffset: store().settings.utcOffsetMinutes } : {}) };
      const next = F.apply(before, event);
      store().record({ cards: next ? [next] : [], events: [event], days: [{ ...R.zero(day), ratings: 1, lapses: g === 1 ? 1 : 0, learned: before ? 0 : 1 }] });
      session.tally.ratings++; if (g === 1) session.tally.again++; else session.tally.remembered++; if (!before) session.tally.learned++;
      if (g === 1) session.queue.push(id);
      deps.onChange();
      const kind = g === 1 ? 'again' : 'good', pressed = $(g === 1 ? 'rv-forget' : 'rv-remember');
      if (reducedMotion.matches) { advance(); return; }
      locked = true; restartClass(pressed, 'is-pressed', 420);
      const days = next && g !== 1 ? F.dayDiff(now, next.due) : 0;
      const scene = deck.querySelector('.fc-scene'), chip = node('span', 'rv-next-chip rv-next-' + kind, g === 1 ? '稍后再来' : days ? days + ' 天后再见' : '日期不变');
      chip.setAttribute('aria-hidden', 'true'); scene?.append(chip); scene?.classList.add('is-out', 'is-out-' + kind);
      later('advance', 300, () => { locked = false; if (session && !session.done) advance(); });
    }
    async function toggleMastered() {
      if (!session || session.done || locked) return;
      const source=store(),id = currentId(), on = !session.mastered.has(id), scene = deck.querySelector('.fc-scene');
      locked = true; renderChrome();
      try { await deps.setMastered(id, on); }
      catch (error) { if(!session||source!==store())return;locked = false; renderChrome(); say(error.message || '暂时无法保存掌握状态。', true); return; }
      locked = false;
      if (source!==store()||!session || session.done || currentId() !== id) return;
      if (on) session.mastered.add(id); else session.mastered.delete(id);
      if (on) session.tally.mastered++; else session.tally.mastered = Math.max(0, session.tally.mastered - 1);
      deps.onChange();
      deck.querySelector('.fc-card')?.classList.toggle('is-sealed', on);
      applyFace(); renderChrome();
      if (on) offerUndo(id); else clearUndo();
      say(on ? '已标记为已掌握，这个词条退出复习计划。' : '已取消掌握，它会带着原来的记忆状态回到复习计划。');
      if (on && session.mode !== 'browse') {
        // It leaves the schedule: drop its later re-shows, stamp it, then move on.
        for (let i = session.queue.length - 1; i > session.index; i--) if (session.queue[i] === id) session.queue.splice(i, 1);
        if (scene && !reducedMotion.matches) { locked = true; scene.classList.add('is-sealing'); later('advance', 620, () => { locked = false; if (session && !session.done && currentId() === id) dropCurrent(); }); }
        else dropCurrent();
      }
    }
    function offerUndo(id) {
      clearUndo(); const bar = $('rv-undo'); undo = id; bar.hidden = false;
      later('undo', 8000, clearUndo);
    }
    function clearUndo() { cancel('undo'); undo = null; $('rv-undo').hidden = true; }
    async function undoMastered() {
      const id = undo; if (!id) return; clearUndo();
      try { await deps.setMastered(id, false); } catch (error) { say(error.message || '暂时无法撤销。', true); return; }
      if (!session) return;
      session.mastered.delete(id); session.tally.mastered = Math.max(0, session.tally.mastered - 1);
      if (session.mode !== 'browse' && (session.done || currentId() !== id)) {
        // Put it back right here so it can still be reviewed in this round.
        if (session.done) { session.done = false; session.index = session.queue.length; }
        session.queue.splice(session.index, 0, id); session.face = 'front'; session.flipped = false; renderCard('prev'); renderChrome(); keepFocus();
      } else { deck.querySelector('.fc-card')?.classList.remove('is-sealed'); applyFace(); renderChrome(); }
      say('已撤销，词条回到复习计划。');
    }
    function say(text, error = false) { const line = $('rv-status'); line.textContent = text; line.classList.toggle('is-error', error); later('status', error ? 7000 : 3600, () => { line.textContent = ''; }); }
    function renderDone() {
      deck.dataset.stack = '0';
      const t = session.tally, panel = node('div', 'fc-done rv-done'); panel.dataset.enter = 'deal';
      const figure = node('div', 'rv-done-art'); figure.append(art('art-review-done'));
      const stamp = node('p', 'fc-done-stamp', '本轮完成');
      const figures = node('dl', 'rv-done-figures');
      const rows = session.mode === 'browse' ? [['翻看', t.flips], ['新掌握', t.mastered]] : [['背诵', t.flips], ['记得', t.remembered], ['忘记', t.again], ['新掌握', t.mastered]];
      for (const [label, value] of rows) { const box = node('div'); box.append(node('dt', '', label), node('dd', '', String(value))); figures.append(box); }
      const c = context(), next = R.nextDue({ words: c.words, cards: c.s.cards, scope: scope ? new Set(scopeTags(c.org)) : null });
      const note = node('p', 'fc-done-note', session.mode === 'browse' ? '翻阅不改变复习计划。' : next ? `下一张将在 ${when(next, c.now)} 到期。` : '这个范围里的词条都已掌握。');
      const leftToday = session.mode === 'browse' ? 0 : R.plan({ words: c.words, cards: c.s.cards, now: c.now, settings: c.s.settings, learnedToday: counters(c.s, c.now).learned, scope: scope ? new Set(scopeTags(c.org)) : null }).due.length;
      if (leftToday) note.textContent = `还有 ${leftToday} 张今天到期（包括刚才忘记的），可以稍后再来。`;
      const actions = node('div', 'fc-done-actions');
      const back = button('返回概览', 'primary', () => { renderHome(); show('home'); }); back.dataset.rvPrimary = '';
      actions.append(back);
      const ahead = R.ahead({ words: c.words, cards: c.s.cards, now: c.now, scope: scope ? new Set(scopeTags(c.org)) : null });
      if (session.mode !== 'browse' && ahead.length) actions.append(button(`提前巩固 ${ahead.length} 张`, 'quiet', () => startSession('ahead')));
      actions.append(button('关闭', 'quiet', () => close()));
      panel.append(figure, stamp, figures, note, actions); deck.replaceChildren(panel);
      stage.setAttribute('aria-label', '本轮完成');
    }
    function prevCard() { if (!session || session.mode !== 'browse' || locked) return; if (session.done) { session.done = false; session.index = session.queue.length - 1; } else if (session.index > 0) session.index--; else return; session.face = 'front'; session.flipped = false; renderCard('prev'); renderChrome(); keepFocus(); announce(`第 ${session.index + 1} 张：${current().english}`); }
    function nextCard() { if (!session || session.mode !== 'browse' || session.done || locked) return; advance('next'); }
    function checkOverflow() { if (session) stage.dataset.scroll = stage.scrollHeight > stage.clientHeight + 1 ? 'y' : 'none'; }

    // ── Open / close ────────────────────────────────────────────────────────────────────────────────────────
    function teardown(instant) {
      for (const id of timers.values()) clearTimeout(id); timers.clear();
      session = null; locked = false; gesture = null; undo = null; liveSeq++;loadingReview=false;openEpoch++;clearInterval(resetTimer);resetTimer=0;
      $('rv-undo').hidden = true; $('rv-hint').classList.remove('is-visible'); $('rv-live').textContent = ''; $('rv-status').textContent = '';
      const wipe = () => { deck.replaceChildren(); home.replaceChildren(); stage.removeAttribute('aria-label'); };
      if (instant) { wipe(); scope = null; scopeOpen = false; settingsOpen = false; customOpen = false; } else later('wipe', 220, wipe);
    }
    async function open() {
      const selected=scope;cancel('wipe'); teardown(true);scope=selected; viewName = 'home';const epoch=openEpoch;
      dialog.classList.remove('is-instant');
      renderHome(); show('home', { focus: false });
      if (!dialog.open) dialog.showModal();
      show('home');
      clearInterval(resetTimer); resetTimer = setInterval(tickReset, 30000);
      // A cloud account re-reads its review progress on open, so another device's session is reflected.
      if (store().mode === 'cloud' && !store().pending) {
        const s = store(); loadingReview = true; renderHome(); show('home', { focus: false });
        const error = await deps.reload();if(epoch!==openEpoch)return; loadingReview = false;
        if (s !== store() || !dialog.open || viewName !== 'home') return;
        renderHome();
        (home.querySelector('[data-rv-primary]') || home.querySelector('button'))?.focus({ preventScroll: true });
        if (error && error.code !== 'auth') say('暂时无法读取云端复习进度，显示的是本页已有记录。', true);
      }
    }
    function close({ instant = false } = {}) {
      if (!dialog.open && !instant) return;
      teardown(instant);
      if (!dialog.open) return;
      if (instant) { dialog.classList.add('is-instant'); requestAnimationFrame(() => requestAnimationFrame(() => dialog.classList.remove('is-instant'))); }
      dialog.close();
    }
    // Re-render the overview when the data underneath changed (a sync finished, a word was edited).
    function refresh() { if (dialog.open && viewName === 'home') { const had = home.contains(document.activeElement); renderHome(); if (had) (home.querySelector('[data-rv-primary]') || home.querySelector('button'))?.focus({ preventScroll: true }); } }

    // ── Events ──────────────────────────────────────────────────────────────────────────────────────────────
    dialog.addEventListener('cancel', e => { e.preventDefault(); if (viewName !== 'home' && !locked) { renderHome(); show('home'); } else close(); });
    dialog.addEventListener('close', () => { if (dialog.open) return; if (session || home.childElementCount) teardown(false); deps.onClose(); });
    $('rv-close').addEventListener('click', () => close());
    $('rv-back').addEventListener('click', () => { if (locked) return; renderHome(); show('home'); });
    $('rv-guide-back').addEventListener('click', () => { renderHome(); show('home'); });
    $('rv-flip').addEventListener('click', flip);
    $('rv-prev').addEventListener('click', prevCard);
    $('rv-next').addEventListener('click', nextCard);
    $('rv-shuffle').addEventListener('click',()=>{if(!session||session.mode!=='browse'||locked)return;session.queue=D.permute(session.queue);session.index=0;session.done=false;session.face='front';session.flipped=false;renderCard('deal');renderChrome();keepFocus();announce('本轮卡片已洗牌，学习计划不变。');});
    $('rv-master').addEventListener('click', toggleMastered);
    $('rv-undo-button').addEventListener('click', undoMastered);
    for (const [g, id] of GRADES) $(id).addEventListener('click', () => grade(g));
    deck.addEventListener('click', e => {
      if (!session || session.done) return;
      if (!e.target.closest('.fc-scene')) return;
      if (performance.now() < suppressUntil) { suppressUntil = 0; return; }
      flip();
    });
    dialog.addEventListener('keydown', e => {
      if (!session || viewName !== 'session' || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.key === 'Tab') return;
      const control = e.target.closest('button, input, select, textarea, a[href]');
      if (session.mode !== 'browse' && /^[12]$/.test(e.key) && session.face === 'back') { e.preventDefault(); if (!e.repeat) grade(e.key === '1' ? 1 : 3); return; }
      if (session.mode === 'browse') { const step = { ArrowLeft: 'prev', ArrowUp: 'prev', ArrowRight: 'next', ArrowDown: 'next' }[e.key]; if (step) { e.preventDefault(); if (!e.repeat) (step === 'prev' ? prevCard : nextCard)(); return; } }
      if ((e.key === ' ' || e.key === 'Enter') && !control) { e.preventDefault(); if (!e.repeat) flip(); }
    });
    // Touch: a tap flips; in 翻阅 a horizontal swipe changes card. Ratings stay on explicit buttons (no accidental swipes).
    stage.addEventListener('pointerdown', e => { suppressUntil = 0; if (!session || e.pointerType === 'mouse') return; gesture = e.isPrimary && !gesture ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null; });
    stage.addEventListener('pointercancel', () => { gesture = null; });
    stage.addEventListener('pointerup', e => {
      if (!session || !gesture || e.pointerId !== gesture.id) return;
      const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y, moved = Math.max(Math.abs(dx), Math.abs(dy)) > 10; gesture = null;
      if (e.target.closest('button')) { if (moved) suppressUntil = performance.now() + 700; return; }
      suppressUntil = performance.now() + 700;
      if (!moved) { if (e.target.closest('.fc-scene')) flip(); return; }
      if (session.mode === 'browse' && Math.abs(dx) >= 48 && Math.abs(dx) >= Math.abs(dy) * 1.4) (dx < 0 ? nextCard : prevCard)();
    });
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => checkOverflow()).observe(stage);

    return { open, close, refresh, isOpen: () => dialog.open };
  }
  window.LedgerReviewUI = { mount };
})();
