(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LedgerFlashcards = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Card deck helpers: pure functions over a frozen snapshot of words, plus the face renderer. Nothing here saves,
  // fetches or touches stored data; the smart review dialog (js/review-ui.js) drives them.

  // sources optionally labels where each card lives (a 子账本 when the deck spans several).
  function snapshot(words, folios, sources) {
    return Object.freeze(words.map(w => Object.freeze({
      id: w.id, folio: folios && folios.get(w.id) || 0, source: sources && sources.get(w.id) || '', english: String(w.english), meaning: String(w.meaning),
      exampleSentence: String(w.exampleSentence || ''), exampleTranslation: String(w.exampleTranslation || ''), note: String(w.note || ''), mastered: Boolean(w.mastered)
    })));
  }
  // Unbiased Fisher-Yates over a copy; the input array is never reordered.
  function permute(list, random = Math.random) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }
  const counts = cards => ({ all: cards.length, unmastered: cards.filter(c => !c.mastered).length });
  const pool = (cards, scope) => cards.map((c, i) => i).filter(i => scope !== 'unmastered' || !cards[i].mastered);
  const fresh = (s, order, extra) => Object.freeze({ ...s, ...extra, order: Object.freeze(order), index: 0, face: 'front', done: false, backSeen: Object.freeze([]) });

  function start(cards, scope = 'all') {
    if (scope === 'unmastered' && !counts(cards).unmastered) scope = 'all';
    return fresh({ cards, scope, shuffled: false }, pool(cards, scope));
  }
  const current = s => (s.done || !s.order.length ? null : s.cards[s.order[s.index]]);
  function next(s) {
    if (s.done || !s.order.length) return s;
    if (s.index < s.order.length - 1) return Object.freeze({ ...s, index: s.index + 1, face: 'front' });
    return Object.freeze({ ...s, done: true, face: 'front' });
  }
  function prev(s) {
    if (s.done) return Object.freeze({ ...s, done: false, index: s.order.length - 1, face: 'front' });
    if (s.index > 0) return Object.freeze({ ...s, index: s.index - 1, face: 'front' });
    return s;
  }
  function flip(s) {
    const card = current(s); if (!card) return s;
    const face = s.face === 'front' ? 'back' : 'front';
    const backSeen = face === 'back' && !s.backSeen.includes(card.id) ? Object.freeze([...s.backSeen, card.id]) : s.backSeen;
    return Object.freeze({ ...s, face, backSeen });
  }
  const restart = s => fresh(s, [...s.order]);
  function shuffle(s, random = Math.random) {
    if (s.order.length < 2) return s;
    return fresh(s, permute(s.order, random), { shuffled: true });
  }
  function setScope(s, scope, random = Math.random) {
    if (scope === s.scope) return s;
    const order = pool(s.cards, scope); if (!order.length) return s;
    return fresh(s, s.shuffled ? permute(order, random) : order, { scope });
  }

  const pad = n => String(n).padStart(2, '0');
  const lengthClass = text => { const n = [...text.trim()].length; return n <= 12 ? 's' : n <= 24 ? 'm' : n <= 48 ? 'l' : 'xl'; };

  // One face of a card, shared by every study surface (js/review-ui.js). Built with createElement/textContent only;
  // bold example runs come from the page's richText(), which never parses HTML.
  function face(kind, card, { node, richText }) {
    const section = node('section', 'fc-face fc-' + kind); section.dataset.side = kind;
    section.setAttribute('aria-label', kind === 'front' ? '正面' : '反面');
    const hasExample = Boolean(card.exampleSentence.trim());
    const folio = node('span', 'fc-folio', card.folio ? '词条 ' + pad(card.folio) : '词条');
    if (card.source) folio.append(node('span', 'fc-source', card.source));
    const side = node('span', 'fc-side', kind === 'front' ? '正面' : '反面'); side.setAttribute('aria-hidden', 'true');
    if (kind === 'front') {
      const meta = node('div', 'fc-meta'); meta.append(folio, side);
      const word = node('h3', 'fc-word', card.english); word.lang = 'en'; word.dataset.length = lengthClass(card.english);
      section.append(meta, node('span', 'fc-lines'), word);
      if (hasExample) {
        const box = node('div', 'fc-example'); box.append(node('p', 'fc-label', '例句'));
        const sentence = richText(node('p', 'fc-sentence'), card.exampleSentence); sentence.lang = 'en'; box.append(sentence); section.append(box);
      }
    } else {
      const caption = node('div', 'fc-caption'), word = node('p', 'fc-caption-word', card.english); word.lang = 'en'; word.dataset.length = lengthClass(card.english);
      caption.append(folio, word, side);
      const meaning = node('div', 'fc-meaning-block'); meaning.append(node('p', 'fc-label', '释义'), node('p', 'fc-meaning', card.meaning));
      section.append(caption, meaning);
      if (hasExample) {
        const box = node('div', 'fc-example fc-example-back'); box.append(node('p', 'fc-label', '例句'));
        const sentence = richText(node('p', 'fc-sentence'), card.exampleSentence); sentence.lang = 'en'; box.append(sentence);
        if (card.exampleTranslation.trim()) box.append(richText(node('p', 'fc-translation'), card.exampleTranslation));
        section.append(box);
      }
      // The note is a back-only study aid; a blank note leaves no trace.
      if (card.note.trim()) {
        const note = node('div', 'fc-note'); note.append(node('p', 'fc-label', '备注'), node('p', 'fc-note-text', card.note));
        section.append(note);
      }
    }
    return section;
  }

  return { snapshot, permute, counts, start, current, next, prev, flip, restart, shuffle, setScope, lengthClass, face };
});
