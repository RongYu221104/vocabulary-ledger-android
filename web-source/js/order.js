(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LedgerOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Display order only: nothing here changes stored data, record IDs or the persisted array order.
  const MODES = Object.freeze(['asc', 'desc', 'az', 'za', 'shuffle']);
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  // Natural creation order: createdAt first, then the stored array position (D1 position / JSON order),
  // which is unique and survives reloads, so equal timestamps never swap.
  function creationRanks(words) {
    const order = words.map((w, i) => ({ id: w.id, at: w.createdAt, i }));
    order.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.i - b.i));
    return new Map(order.map((x, rank) => [x.id, rank]));
  }
  // Ledger-internal entry numbers: 1 is the earliest remaining entry of that ledger.
  function folios(words, ranks = creationRanks(words)) {
    const byTag = new Map();
    for (const w of words) { if (!byTag.has(w.tagId)) byTag.set(w.tagId, []); byTag.get(w.tagId).push(w.id); }
    const result = new Map();
    for (const ids of byTag.values()) { ids.sort((a, b) => ranks.get(a) - ranks.get(b)); ids.forEach((id, n) => result.set(id, n + 1)); }
    return result;
  }
  // Case-insensitive, whitespace-normalised; leading quotes/hyphens do not decide the letter.
  function sortKey(english) {
    const plain = english.normalize('NFC').trim().replace(/\s+/g, ' ');
    return plain.replace(/^[^\p{L}\p{N}]+/u, '') || plain;
  }
  // Fisher-Yates over the given ids; returns id -> display rank.
  function shuffle(ids, random = Math.random) {
    const list = [...ids];
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return new Map(list.map((id, rank) => [id, rank]));
  }
  function sortWords(words, mode, ranks, shuffleRanks = null) {
    const created = (a, b) => ranks.get(a.id) - ranks.get(b.id);
    const list = [...words];
    if (mode === 'desc') return list.sort((a, b) => created(b, a));
    if (mode === 'az' || mode === 'za') {
      const sign = mode === 'az' ? 1 : -1, keys = new Map(list.map(w => [w.id, sortKey(w.english)]));
      return list.sort((a, b) => sign * collator.compare(keys.get(a.id), keys.get(b.id)) || created(a, b));
    }
    if (mode === 'shuffle' && shuffleRanks) {
      // Entries that arrived after the last shuffle keep the arrangement and follow it in creation order.
      const at = w => shuffleRanks.has(w.id) ? shuffleRanks.get(w.id) : Number.MAX_SAFE_INTEGER;
      return list.sort((a, b) => at(a) - at(b) || created(a, b));
    }
    return list.sort(created);
  }
  return { MODES, creationRanks, folios, sortKey, shuffle, sortWords };
});
