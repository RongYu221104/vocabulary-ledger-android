(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LedgerModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 2;
  const FORMAT = 'cet-vocabulary-ledger';
  const LIMITS = Object.freeze({ tags: 1000, words: 20000, name: 120, english: 200, meaning: 4000, example: 12000, note: 4000, bytes: 8 * 1024 * 1024 });
  class LedgerError extends Error {
    constructor(message, code = 'validation') { super(message); this.name = 'LedgerError'; this.code = code; }
  }
  function fail(message, code) { throw new LedgerError(message, code); }
  const clone = value => JSON.parse(JSON.stringify(value));
  const normalize = value => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  function text(value, label, max, multiline = false) {
    if (typeof value !== 'string') fail(label + '必须是文字。');
    const result = multiline ? value : value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
    if (!result || !result.replace(/[\s\u200B-\u200F\uFEFF]/g, '')) fail('请填写' + label + '。');
    if (result.length > max) fail(label + '最多 ' + max + ' 个字符。');
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(result) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result)) fail(label + '含有不合法字符。');
    if (!multiline && /[\n\t]/.test(result)) fail(label + '不能换行或包含制表符。');
    return result;
  }
  function version(value = 1) { if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail('记录版本不合法。'); return value; }
  function example(value, label, max = LIMITS.example) {
    if (typeof value !== 'string' || value.length > max) fail(label + '最多 ' + max + ' 个字符。');
    if (value && value.trim()) text(value, label, max, true);
    else if (value && /[^ \r\n\t]/.test(value)) fail(label + '含有不可见字符。');
    return value;
  }
  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01') fail('请输入有效录入日期（1900 年起）。');
    const parsed = new Date(value + 'T00:00:00.000Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('录入日期不存在。');
    return value;
  }
  function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('创建或修改时间不合法。');
    return value;
  }
  function id(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail('记录 ID 不合法。');
    return value;
  }
  function shape(obj, required, optional = []) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('数据结构不合法。');
    if (required.some(key => !Object.hasOwn(obj, key)) || Object.keys(obj).some(key => !required.includes(key) && !optional.includes(key))) fail('数据字段缺失或包含未知字段。');
  }
  function sharing(value) {
    shape(value, [], ['container', 'provenance']);
    const out = {};
    if(value.container) {
      const c=value.container; shape(c,['key','label','year','month','set','type']);
      if(!/^\d{2}$/.test(c.year)||!/^(0[1-9]|1[0-2])$/.test(c.month)||!Number.isInteger(c.set)||c.set<1||c.set>999||!['Writing','Listening','Cloze','Matching','Reading','Translation'].includes(c.type)) fail('来源账本层级不合法。');
      out.container={key:id(c.key),label:text(c.label,'容器名称',120),year:c.year,month:c.month,set:c.set,type:c.type};
    }
    if(value.provenance) {
      const p=value.provenance;shape(p,['originalName','originalId','sharerName','shareId','receivedAt','chain','proof','verified']);
      if(!Array.isArray(p.chain)||p.chain.length>5||typeof p.verified!=='boolean'||typeof p.proof!=='string'||!/^[a-f0-9]{0,64}$/.test(p.proof)) fail('来源元数据不合法。');
      out.provenance={originalName:text(p.originalName,'来源昵称',40),originalId:id(p.originalId),sharerName:text(p.sharerName,'分享昵称',40),shareId:id(p.shareId),receivedAt:timestamp(p.receivedAt),chain:p.chain.map(n=>text(n,'来源昵称',40)),proof:p.proof,verified:p.verified};
    }
    return out;
  }
  // Optional `structure`: custom 主账本, 分组 with 分类项, and which 子账本 (tags) sit in which 分类项 (see groups.js).
  // Shapes, names and ids are strict; a reference to a tag or 分类项 that no longer exists is simply dropped, so deleting
  // a 子账本 or a 分类项 can never make a ledger unreadable. Exam 主账本 (by name YY-MM) bind by `key`.
  const STRUCTURE = Object.freeze({ masters: 200, groups: 12, items: 100, name: 40, bytes: 256 * 1024 });
  function structure(value, tagIds) {
    shape(value, ['version', 'masters']);
    if (value.version !== 1 || !Array.isArray(value.masters) || value.masters.length > STRUCTURE.masters) fail('子账本分组数据不合法。');
    const used = new Set(), names = new Set(), keys = new Set(), claimed = new Set();
    const unique = value => { if (used.has(value)) fail('存在重复 ID。'); used.add(value); return value; };
    const masters = value.masters.map(m => {
      shape(m, ['id', 'name', 'createdAt', 'groups', 'members'], ['key']);
      const out = { id: unique(id(m.id)), name: text(m.name, '主账本名称', STRUCTURE.name), createdAt: timestamp(m.createdAt) };
      if (Object.hasOwn(m, 'key')) { out.key = id(m.key); if (keys.has(out.key)) fail('同一主账本存在重复分组设置。'); keys.add(out.key); }
      else { if (names.has(normalize(out.name))) fail('存在重名主账本。'); names.add(normalize(out.name)); }
      if (!Array.isArray(m.groups) || m.groups.length > STRUCTURE.groups || !Array.isArray(m.members) || m.members.length > LIMITS.tags) fail('子账本分组数据超出上限。');
      const groupNames = new Set(), items = new Set();
      out.groups = m.groups.map(g => {
        shape(g, ['id', 'name', 'items'], ['preset']);
        const group = { id: unique(id(g.id)), name: text(g.name, '分组名称', STRUCTURE.name) };
        if (group.id === 'set' || group.id === 'type' || Object.hasOwn(Object.prototype, group.id)) fail('分组 ID 不合法。');
        if (Object.hasOwn(g, 'preset')) { if (out.key || !['set', 'type'].includes(g.preset)) fail('分组预设不合法。'); group.preset = g.preset; }
        if (out.key && ['套题', '题型'].includes(group.name)) fail('真题主账本已自带「套题」「题型」分组。');
        if (groupNames.has(normalize(group.name))) fail('同一主账本中存在重名分组。'); groupNames.add(normalize(group.name));
        if (!Array.isArray(g.items) || g.items.length > STRUCTURE.items) fail('分类项数量超出上限。');
        const itemNames = new Set();
        group.items = g.items.map(i => {
          shape(i, ['id', 'name']);
          const item = { id: unique(id(i.id)), name: text(i.name, '分类项名称', STRUCTURE.name) };
          if (itemNames.has(normalize(item.name))) fail('同一分组中存在重名分类项。'); itemNames.add(normalize(item.name)); items.add(item.id);
          return item;
        });
        return group;
      });
      out.members = [];
      for (const r of m.members) {
        shape(r, ['tag', 'items']);
        if (!Array.isArray(r.items) || r.items.length > STRUCTURE.groups * STRUCTURE.items) fail('子账本归属数据不合法。');
        const tag = id(r.tag); for (const x of r.items) id(x);
        // A deleted 子账本, or one already placed in an earlier 主账本, is skipped.
        if (!tagIds.has(tag) || claimed.has(tag)) continue;
        claimed.add(tag); out.members.push({ tag, items: [...new Set(r.items.filter(x => items.has(x)))] });
      }
      return out;
    });
    const result = { version: 1, masters };
    if (new TextEncoder().encode(JSON.stringify(result)).length > STRUCTURE.bytes) fail('子账本分组数据超过 256 KiB。');
    return result;
  }
  function empty() { return { format: FORMAT, schemaVersion: VERSION, revision: 0, tags: [], words: [] }; }
  function validate(input) {
    shape(input, ['format', 'schemaVersion', 'revision', 'tags', 'words'], ['exportedAt', 'structure']);
    if (input.format !== FORMAT || ![1, VERSION].includes(input.schemaVersion)) fail('不支持此文件格式或 schema version；未修改现有账本。');
    if (!Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision >= Number.MAX_SAFE_INTEGER) fail('数据版本号不合法。');
    if (Object.hasOwn(input, 'exportedAt')) timestamp(input.exportedAt);
    if (!Array.isArray(input.tags) || !Array.isArray(input.words)) fail('账本和词条必须是数组。');
    if (input.tags.length > LIMITS.tags || input.words.length > LIMITS.words) fail('超出记录上限（1000 个账本 / 20000 条词条）。');
    const ids = new Set(), tagIds = new Set(), names = new Set(), duplicates = new Set();
    const tags = input.tags.map(t => {
      shape(t, ['id', 'name', 'date', 'createdAt', 'updatedAt'], ['recordVersion','sharing']);
      const item = { id: id(t.id), name: text(t.name, '账本名称', LIMITS.name), date: date(t.date), createdAt: timestamp(t.createdAt), updatedAt: timestamp(t.updatedAt) };
      item.recordVersion = version(t.recordVersion);
      if(Object.hasOwn(t,'sharing')) item.sharing = sharing(t.sharing);
      if (ids.has(item.id)) fail('存在重复 ID。');
      if (names.has(normalize(item.name))) fail('存在重名账本。');
      if (item.updatedAt < item.createdAt) fail('修改时间早于创建时间。');
      ids.add(item.id); tagIds.add(item.id); names.add(normalize(item.name)); return item;
    });
    const words = input.words.map(w => {
      shape(w, ['id', 'english', 'meaning', 'tagId', 'mastered', 'createdAt', 'updatedAt'], input.schemaVersion === 1 ? [] : ['exampleSentence', 'exampleTranslation', 'recordVersion', 'note']);
      const item = { id: id(w.id), english: text(w.english, '英文单词或短语', LIMITS.english), meaning: text(w.meaning, '中文释义', LIMITS.meaning, true), tagId: id(w.tagId), mastered: w.mastered, createdAt: timestamp(w.createdAt), updatedAt: timestamp(w.updatedAt) };
      if (!/[a-zA-Z]/.test(item.english)) fail('英文内容至少包含一个英文字母。');
      if (typeof item.mastered !== 'boolean') fail('掌握状态必须是布尔值。');
      item.recordVersion = version(w.recordVersion);
      item.exampleSentence = example(w.exampleSentence ?? '', '英文例句');
      item.exampleTranslation = example(w.exampleTranslation ?? '', '例句中文翻译');
      if (item.exampleTranslation.trim() && !item.exampleSentence.trim()) fail('请先填写英文例句，再填写中文翻译。');
      // Optional note (derived forms, roots, mnemonics). Absent or blank notes are omitted, so older records,
      // exports and snapshots stay byte-identical.
      const note = example(w.note ?? '', '备注', LIMITS.note);
      if (note.trim()) item.note = note;
      if (ids.has(item.id)) fail('存在重复 ID。');
      if (!tagIds.has(item.tagId)) fail('词条引用了不存在的账本。');
      if (item.updatedAt < item.createdAt) fail('修改时间早于创建时间。');
      const key = item.tagId + '\u0000' + normalize(item.english);
      if (duplicates.has(key)) fail('同一账本中已有相同的英文单词或短语。');
      duplicates.add(key); ids.add(item.id); return item;
    });
    const result = { format: FORMAT, schemaVersion: VERSION, revision: input.revision, tags, words };
    // An empty structure is omitted, so ledgers that never use custom groups stay byte-identical.
    if (Object.hasOwn(input, 'structure') && input.structure !== null) { const value = structure(input.structure, tagIds); if (value.masters.length) result.structure = value; }
    return result;
  }
  function parse(raw) {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > LIMITS.bytes) fail('文件过大（最多 8 MiB）。');
    let value;
    try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { fail('JSON 文件损坏或不是合法 JSON；现有数据未改变。'); }
    return validate(value);
  }
  function makeId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  function mutate(state, action, payload, env = {}) {
    const next = clone(state), now = env.now || new Date().toISOString();
    const freshId = env.id || makeId();
    function changedTime(item) { return now > item.updatedAt ? now : item.updatedAt; }
    if (action === 'addTag') {
      if (next.tags.length >= LIMITS.tags) fail('账本数量已达上限。');
      next.tags.push({ id: freshId, name: payload.name, date: payload.date, createdAt: now, updatedAt: now, ...(payload.container?{sharing:{container:payload.container}}:{}) });
    } else if (action === 'editTag' || action === 'deleteTag') {
      const tag = next.tags.find(t => t.id === payload.id);
      if (!tag) fail('该账本不存在，请重新读取。');
      if (action === 'editTag') Object.assign(tag, { name: payload.name, date: payload.date, updatedAt: changedTime(tag) });
      else { next.tags = next.tags.filter(t => t.id !== tag.id); next.words = next.words.filter(w => w.tagId !== tag.id); }
    } else if (action === 'setStructure') {
      // The whole classification is replaced at once; tags and words are never touched by it.
      if (payload.structure) next.structure = payload.structure; else delete next.structure;
    } else if (action === 'importTag') {
      // One new independent ledger and all its words in one step (官方词汇账本 → 我的账本). Every id is fresh and every
      // word starts unmastered, so the copy shares nothing with its source; existing tags and words are untouched.
      if (next.tags.length >= LIMITS.tags) fail('账本数量已达上限。');
      if (!Array.isArray(payload.words) || !payload.words.length) fail('没有可复制的词条。');
      if (next.words.length + payload.words.length > LIMITS.words) fail('复制后词条将超过 ' + LIMITS.words + ' 条上限。');
      next.tags.push({ id: freshId, name: payload.name, date: payload.date, createdAt: now, updatedAt: now });
      for (const w of payload.words) next.words.push({ id: makeId(), english: w.english, meaning: w.meaning, exampleSentence: w.exampleSentence || '', exampleTranslation: w.exampleTranslation || '', note: w.note ?? '', tagId: freshId, mastered: false, createdAt: now, updatedAt: now });
    } else if (action === 'addWord') {
      if (next.words.length >= LIMITS.words) fail('词条数量已达上限。');
      next.words.push({ id: freshId, english: payload.english, meaning: payload.meaning, exampleSentence: payload.exampleSentence || '', exampleTranslation: payload.exampleTranslation || '', note: payload.note ?? '', tagId: payload.tagId, mastered: false, createdAt: now, updatedAt: now });
    } else {
      const word = next.words.find(w => w.id === payload.id);
      if (!word) fail('该词条不存在，请重新读取。');
      if (action === 'editWord') Object.assign(word, { english: payload.english, meaning: payload.meaning, exampleSentence: payload.exampleSentence ?? word.exampleSentence, exampleTranslation: payload.exampleTranslation ?? word.exampleTranslation, note: payload.note ?? word.note ?? '', updatedAt: changedTime(word) });
      else if (action === 'toggleWord') Object.assign(word, { mastered: payload.mastered, updatedAt: changedTime(word) });
      else if (action === 'deleteWord') next.words = next.words.filter(w => w.id !== word.id);
      else fail('未知操作。');
    }
    return validate(next);
  }
  function stats(words) {
    const total = words.length, mastered = words.reduce((n, w) => n + (w.mastered ? 1 : 0), 0);
    return { total, mastered, unmastered: total - mastered, percent: total ? Math.round(mastered / total * 100) : 0 };
  }
  function tagStats(state) {
    const map = new Map(state.tags.map(t => [t.id, { total: 0, mastered: 0 }]));
    for (const w of state.words) { const s = map.get(w.tagId); s.total++; if (w.mastered) s.mastered++; }
    for (const s of map.values()) { s.unmastered = s.total - s.mastered; s.percent = s.total ? Math.round(s.mastered / s.total * 100) : 0; }
    return map;
  }
  function sortedTags(state) {
    return state.tags.map((tag, position) => ({ tag, position })).sort((a, b) => b.tag.date.localeCompare(a.tag.date) || b.tag.createdAt.localeCompare(a.tag.createdAt) || b.position - a.position).map(x => x.tag);
  }
  function findWords(state, { tagId = null, query = '', filter = 'all', includeExamples = true } = {}) {
    const q = normalize(query);
    return state.words.filter(w => (!tagId || w.tagId === tagId) && (filter === 'all' || w.mastered === (filter === 'mastered')) && (!q || normalize(w.english).includes(q) || normalize(w.meaning).includes(q) || (includeExamples && (normalize(w.exampleSentence.replaceAll('**', '')).includes(q) || normalize(w.exampleTranslation.replaceAll('**', '')).includes(q))))).reverse();
  }
  function mergePreview(current, incoming) {
    const names=new Map(current.tags.map(t=>[normalize(t.name),t.id])), targets=new Map(), keys=new Set(current.words.map(w=>w.tagId+'\u0000'+normalize(w.english)));let tags=0,words=0;
    for(const t of incoming.tags){const target=names.get(normalize(t.name));if(target){tags++;targets.set(t.id,target);}}
    for(const w of incoming.words)if(keys.has(targets.get(w.tagId)+'\u0000'+normalize(w.english)))words++;
    return {tags,words};
  }
  function merge(current,incoming) {
    const result=validate(current), addition=validate(incoming), names=new Set(result.tags.map(t=>normalize(t.name))), used=new Set([...result.tags,...result.words].map(x=>x.id)), ids=new Map();
    const fresh=()=>{let value;do{value=makeId();}while(used.has(value));used.add(value);return value;};
    for(const t of addition.tags){let name=t.name,n=1;while(names.has(normalize(name)))name=t.name+' · 导入 '+(++n);
      if(name.length>LIMITS.name)fail('重名账本名称过长，无法添加导入后缀。请先重命名此账本后合并；现有数据未改变。');
      const newId=used.has(t.id)?fresh():(used.add(t.id),t.id);ids.set(t.id,newId);names.add(normalize(name));result.tags.push({...t,id:newId,name});}
    for(const w of addition.words){const newId=used.has(w.id)?fresh():(used.add(w.id),w.id);result.words.push({...w,id:newId,tagId:ids.get(w.tagId)});}
    // Imported 主账本 / 分组 / 分类项 join by name (exam 主账本 by key); their 子账本 follow the tag id map above.
    if(addition.structure){
      const base=result.structure?clone(result.structure):{version:1,masters:[]};
      const taken=new Set(base.masters.flatMap(m=>[m.id,...m.groups.flatMap(g=>[g.id,...g.items.map(i=>i.id)])]));
      const own=x=>{if(!taken.has(x)){taken.add(x);return x;}let value;do{value=makeId();}while(taken.has(value));taken.add(value);return value;};
      const masterNames=new Set(base.masters.filter(m=>!m.key).map(m=>normalize(m.name)));
      for(const m of addition.structure.masters){
        let target=m.key?base.masters.find(x=>x.key===m.key):null;
        if(!target){let name=m.name,n=1;if(!m.key)while(masterNames.has(normalize(name)))name=m.name.slice(0,30)+' · 导入 '+(++n);if(!m.key)masterNames.add(normalize(name));
          target={id:own(m.id),name,createdAt:m.createdAt,...(m.key?{key:m.key}:{}),groups:[],members:[]};base.masters.push(target);}
        const itemMap=new Map();
        for(const g of m.groups){let tg=target.groups.find(x=>normalize(x.name)===normalize(g.name));if(!tg){tg={id:own(g.id),name:g.name,...(g.preset?{preset:g.preset}:{}),items:[]};target.groups.push(tg);}
          for(const i of g.items){let ti=tg.items.find(x=>normalize(x.name)===normalize(i.name));if(!ti){ti={id:own(i.id),name:i.name};tg.items.push(ti);}itemMap.set(i.id,ti.id);}}
        for(const r of m.members)if(ids.has(r.tag))target.members.push({tag:ids.get(r.tag),items:r.items.map(x=>itemMap.get(x)).filter(Boolean)});
      }
      result.structure=base;
    }
    const valid=validate(result);if(new TextEncoder().encode(JSON.stringify(valid)).length>LIMITS.bytes)fail('合并后超出 8 MiB，现有数据未改变。');return valid;
  }
  function today(now = new Date()) {
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  }
  return { VERSION, FORMAT, LIMITS, LedgerError, empty, validate, parse, mutate, stats, tagStats, sortedTags, findWords, mergePreview, merge, today, normalize, clone };
});
