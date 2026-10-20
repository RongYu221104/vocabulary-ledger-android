(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LedgerGroups = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // 主账本 / 分组 / 子账本. A 子账本 is always one real stored tag (the data container); 主账本 and 分组 are only
  // classification over tags, so nothing here ever copies, moves or deletes a word.
  //  · Exam names YY-MM-N-Type (e.g. 23-12-1-Cloze) still form 主账本 YY-MM by name alone, with the two derived preset
  //    groups 套题 / 题型 — old ledgers need no migration.
  //  · The optional ledger `structure` (validated in model.js) adds custom 主账本, custom 分组 with 分类项, and
  //    memberships: one tag can sit in several groups (and several items of one group) at once.
  // Filters: within one group the chosen items are a union; across groups they intersect.
  const TYPES = Object.freeze(['Writing', 'Listening', 'Cloze', 'Matching', 'Reading', 'Translation']);
  const SETS = Object.freeze([1, 2, 3]);
  const CANON = new Map(TYPES.map(t => [t.toLowerCase(), t]));
  const PATTERN = /^(\d{2})-(0[1-9]|1[0-2])-([1-9]\d{0,2})-([A-Za-z]+)$/;
  const EXAM_KEY = /^(\d{2})-(0[1-9]|1[0-2])$/;
  const NONE = Object.freeze(new Set());

  function parse(name) {
    const m = PATTERN.exec(String(name).trim()); if (!m) return null;
    const type = CANON.get(m[4].toLowerCase()); if (!type) return null;
    return Object.freeze({ key: m[1] + '-' + m[2], year: m[1], month: m[2], set: Number(m[3]), type });
  }
  const subName = (key, set, type) => key + '-' + set + '-' + type;
  const fullYear = yy => (Number(yy) >= 80 ? '19' : '20') + yy;
  const masterTitle = key => { const m = EXAM_KEY.exec(String(key)); return m ? `${fullYear(m[1])} 年 ${Number(m[2])} 月` : ''; };
  const byDate = (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);

  // Masters: exam / imported containers newest exam first, then custom masters newest first. Subs by set, then the
  // fixed CET section order, then name. Independent ledgers keep the old date order.
  function organize(tags, structure) {
    const entries = structure && Array.isArray(structure.masters) ? structure.masters : [];
    const known = new Set(tags.map(t => t.id)), owner = new Map();
    for (const e of entries) for (const m of e.members) if (known.has(m.tag) && !owner.has(m.tag)) owner.set(m.tag, { entry: e, items: new Set(m.items) });
    const masters = new Map(), customs = [], custom = new Map();
    for (const e of entries) if (!e.key) custom.set(e.id, { key: 'm:' + e.id, kind: 'custom', id: e.id, entry: e, label: e.name, createdAt: e.createdAt, subs: [] });
    for (const tag of tags) {
      const own = owner.get(tag.id);
      if (own && !own.entry.key) { custom.get(own.entry.id).subs.push({ tag, set: null, type: null, items: own.items }); continue; }
      const c = tag.sharing?.container;
      const exam = c ? { key: c.key, year: c.year, month: c.month, set: c.set, type: c.type } : parse(tag.name);
      const key = own ? own.entry.key : exam ? exam.key : null;
      if (!key) { customs.push(tag); continue; }
      if (!masters.has(key)) {
        const ym = EXAM_KEY.exec(key) ? { year: key.slice(0, 2), month: key.slice(3) } : exam || {};
        masters.set(key, { key, kind: 'exam', ...(c ? { label: c.label, imported: true } : {}), year: ym.year, month: ym.month, subs: [] });
      }
      masters.get(key).subs.push({ tag, set: exam ? exam.set : null, type: exam ? exam.type : null, items: own ? own.items : NONE });
    }
    const list = [...masters.values()];
    for (const e of entries) if (e.key && masters.has(e.key)) { const m = masters.get(e.key); m.entry = e; m.id = e.id; }
    const order = (a, b) => (a.set ?? 1e9) - (b.set ?? 1e9) || (a.type ? TYPES.indexOf(a.type) : 99) - (b.type ? TYPES.indexOf(b.type) : 99) || a.tag.name.localeCompare(b.tag.name);
    for (const m of list) m.subs.sort(order);
    list.sort((a, b) => (fullYear(b.year || '00') + (b.month || '00')).localeCompare(fullYear(a.year || '00') + (a.month || '00')));
    const own = [...custom.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const m of own) m.subs.sort((a, b) => a.tag.name.localeCompare(b.tag.name, 'zh-Hans-CN', { numeric: true }));
    const all = [...list, ...own];
    for (const m of all) m.groups = groupsOf(m);
    return { masters: all, customs: customs.sort(byDate), byKey: new Map(all.map(m => [m.key, m])) };
  }
  // The groups a master offers: the two derived presets for exam masters, then its stored groups.
  function groupsOf(master) {
    const stored = master.entry ? master.entry.groups.map(g => ({ id: g.id, name: g.name, preset: g.preset || null, derived: false, items: g.items.map(i => ({ id: i.id, name: i.name })) })) : [];
    if (master.kind !== 'exam') return stored;
    return [
      { id: 'set', name: '套题', preset: 'set', derived: true, items: sets(master).map(n => ({ id: 'set:' + n, name: `第 ${n} 套`, value: n })) },
      { id: 'type', name: '题型', preset: 'type', derived: true, items: TYPES.map(t => ({ id: 'type:' + t, name: t, value: t, lang: 'en' })) },
      ...stored
    ];
  }
  function hasItem(sub, groupId, itemId) {
    if (groupId === 'set') return 'set:' + sub.set === itemId;
    if (groupId === 'type') return 'type:' + sub.type === itemId;
    return sub.items.has(itemId);
  }
  // A view is { master, filter: { groupId: [itemId] }, sub? } or { tag } for an independent ledger. The older
  // { master, set, type } shape (set: 'all' | number, type: 'all' | TYPES) still reads the same.
  function filterOf(view) {
    if (!view) return {};
    if (view.filter) return view.filter;
    const out = {};
    if (view.set !== undefined && view.set !== 'all') out.set = ['set:' + view.set];
    if (view.type !== undefined && view.type !== 'all') out.type = ['type:' + view.type];
    return out;
  }
  function matches(sub, filter) {
    for (const gid of Object.keys(filter)) { const ids = filter[gid]; if (ids.length && !ids.some(id => hasItem(sub, gid, id))) return false; }
    return true;
  }
  function viewSubs(org, view) {
    if (!view || view.tag) return [];
    const master = org.byKey.get(view.master); if (!master) return [];
    if (view.sub) return master.subs.filter(s => s.tag.id === view.sub);
    const filter = filterOf(view);
    return master.subs.filter(s => matches(s, filter));
  }
  function viewTags(org, view) {
    if (!view) return [];
    if (view.tag) return org.customs.filter(t => t.id === view.tag);
    return viewSubs(org, view).map(s => s.tag);
  }
  function viewOf(org, tagId) {
    if (org.customs.some(t => t.id === tagId)) return { tag: tagId };
    for (const m of org.masters) {
      const s = m.subs.find(x => x.tag.id === tagId); if (!s) continue;
      if (s.set !== null && s.type !== null && m.subs.filter(x => x.set === s.set && x.type === s.type).length === 1) return { master: m.key, filter: { set: ['set:' + s.set], type: ['type:' + s.type] } };
      return { master: m.key, filter: {}, sub: tagId };
    }
    return null;
  }
  const valid = (org, view) => Boolean(view && (view.tag ? org.customs.some(t => t.id === view.tag) : org.byKey.has(view.master) && (!view.sub || org.byKey.get(view.master).subs.some(s => s.tag.id === view.sub))));
  const all = master => ({ master: master.key, filter: {} });
  function first(org) {
    if (org.masters.length) return all(org.masters[0]);
    return org.customs.length ? { tag: org.customs[0].id } : null;
  }
  function key(view) {
    if (!view) return '';
    if (view.tag) return 't:' + view.tag;
    const f = filterOf(view);
    return 'm:' + view.master + ':' + Object.keys(f).filter(g => f[g].length).sort().map(g => g + '=' + [...f[g]].sort().join('|')).join('&') + (view.sub ? ':' + view.sub : '');
  }
  // Sets offered for an exam master: 1–3 always, plus any higher set that already exists in legacy data.
  const sets = master => [...new Set([...SETS, ...(master ? master.subs.map(s => s.set).filter(n => n !== null) : [])])].sort((a, b) => a - b);
  const display = master => master.label || master.key;
  // Second line under a master's name, e.g. 2023 年 12 月 · 3 个子账本.
  function caption(master) {
    const parts = [];
    if (master.kind === 'exam' && masterTitle(master.year + '-' + master.month)) parts.push(masterTitle(master.year + '-' + master.month));
    else if (master.kind === 'custom') parts.push('自定义主账本');
    parts.push(master.subs.length + ' 个子账本');
    return parts.join(' · ');
  }
  // How a 子账本 is named inside its master: 第 1 套 · Cloze for exam names; otherwise its own name without a
  // leading "主账本 · " prefix (custom subs are suggested as 主账本 · 分类 · 分类).
  function subLabel(master, sub) {
    if (sub.set !== null && sub.type !== null) return `第 ${sub.set} 套 · ${sub.type}`;
    const name = sub.tag.name, prefix = master ? display(master) + ' · ' : '';
    return prefix && name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : name;
  }
  // "第 1 套 · Cloze", "第 1、2 套", "全部子账本" … for a filter over a master.
  function label(view, master) {
    if (!view || view.tag) return '';
    if (view.sub && master) { const s = master.subs.find(x => x.tag.id === view.sub); return s ? subLabel(master, s) : ''; }
    const f = filterOf(view), groups = master ? master.groups : [], parts = [];
    // Exam 主账本 filtered only by one 套题 and/or one 题型 keep their familiar wording.
    const one = gid => (f[gid] || []).length === 1 ? f[gid][0] : null, others = Object.keys(f).some(gid => gid !== 'set' && gid !== 'type' && f[gid].length);
    if (!others && (one('set') || one('type')) && (f.set || []).length <= 1 && (f.type || []).length <= 1) {
      const set = one('set') && `第 ${one('set').slice(4)} 套`, type = one('type') && one('type').slice(5);
      return set && type ? `${set} · ${type}` : set ? `${set} · 全部题型` : `${type} · 全部套题`;
    }
    // In the master's group order (套题 · 题型 · 难度 …), whatever order the tabs were pressed in.
    const order = [...groups.map(g => g.id).filter(id => f[id]), ...Object.keys(f).filter(id => !groups.some(g => g.id === id))];
    for (const gid of order) {
      if (!f[gid].length) continue;
      const g = groups.find(x => x.id === gid), names = f[gid].map(id => g?.items.find(i => i.id === id)?.name || (id.startsWith('set:') ? `第 ${id.slice(4)} 套` : id.startsWith('type:') ? id.slice(5) : id));
      parts.push(gid === 'set' && names.every(n => /^第 \d+ 套$/.test(n)) && names.length > 1 ? '第 ' + names.map(n => n.slice(2, -2)).join('、') + ' 套' : names.join('、'));
    }
    return parts.length ? parts.join(' · ') : '全部子账本';
  }
  // Where a tag lives, for cards and search results: 23-12 · 第 1 套 · Cloze, 考研英语 · 阅读 …
  function source(org, tagId) {
    for (const m of org.masters) { const s = m.subs.find(x => x.tag.id === tagId); if (s) return display(m) + ' · ' + subLabel(m, s); }
    const t = org.customs.find(x => x.id === tagId); return t ? t.name : '';
  }

  return { TYPES, SETS, EXAM_KEY, parse, subName, masterTitle, organize, groupsOf, hasItem, filterOf, matches, viewSubs, viewTags, viewOf, valid, all, first, key, sets, display, caption, subLabel, label, source };
});
