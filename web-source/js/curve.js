(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LedgerCurve = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Built-in forgetting curve: a fixed ladder of 1, 2, 3, 5, 7 days, then every 7 days for good. Pure functions only
  // (no clock, DOM or storage), shared by the browser and the /api/review Worker so both schedule identically.
  //
  // Two answers:
  //  · 记得 (grade 2–4) on a card that is due climbs one step. The next date counts from the day of that success, so a
  //    late (overdue) review never inherits the missed date. Remembering again after forgetting it the same day only
  //    repeats the current step instead of climbing.
  //  · 忘记 (grade 1) never moves the curve. It only marks that the word has entered review today (a new word stops
  //    being "new", so it no longer takes the daily allowance) and keeps it due today; the session re-queues it.
  // A card that is not due yet (提前巩固, a second device that already answered today) is never rescheduled.
  //
  // Stored card fields stay those of the original FSRS rows (no schema change): state 2 = on the ladder, with
  // `stability` holding the current interval in days. Legacy FSRS cards map onto the ladder by that same field
  // (FSRS stability ≈ its interval at 90% retention); their existing due dates are kept.
  const LADDER = Object.freeze([1, 2, 3, 5, 7]);
  const STATE = Object.freeze({ NEW: 0, LEARNING: 1, REVIEW: 2, RELEARNING: 3 });
  const MINUTE = 60000, DAY = 86400000;
  const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

  // Learner-local calendar (browser).
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const dayDiff = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / DAY);
  // The same calendar in a fixed offset (minutes, as Date#getTimezoneOffset). The Worker only knows the learner's
  // zone from the event, so every date below is computed from a day key plus that offset.
  const keyAt = (ms, tz) => new Date(ms - tz * MINUTE).toISOString().slice(0, 10);
  function addDays(key, n) { const d = new Date(key + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  // A due date is noon of the learner's day: a ±1 h daylight-saving shift can never push it onto another date.
  const noonOf = (key, tz) => Date.parse(key + 'T12:00:00Z') + tz * MINUTE;
  const offset = tz => (Number.isSafeInteger(tz) && tz >= -840 && tz <= 840 ? tz : 0);

  // Steps already climbed: 0 for a new / never-remembered card, 1–5 on the ladder (5 = the 7-day loop).
  function stageOf(card) {
    if (!card || card.state !== STATE.REVIEW) return 0;
    let n = 0; for (let i = 0; i < LADDER.length; i++) if (card.stability >= LADDER[i] - 1e-9) n = i + 1;
    return n;
  }
  const intervalOf = stage => LADDER[Math.min(Math.max(stage, 1), LADDER.length) - 1];
  // Has this curve actually scheduled the card on its 7-day interval? Only `remember` writes ladder values, so an
  // exact 7 on a review card is that step. A legacy FSRS card keeps its own (non-ladder) stability, e.g. 7.8 or 12.4:
  // stageOf maps it for its next 记得, but it has not been placed on the 7-day interval yet. Read-only; never schedules.
  const inLoop = card => Boolean(card) && card.state === STATE.REVIEW && card.stability === LADDER[LADDER.length - 1];
  const isDueOn = (card, day, tz) => !card || keyAt(card.due, offset(tz)) <= day;
  const difficulty = card => (card && typeof card.difficulty === 'number' && card.difficulty >= 1 && card.difficulty <= 10 ? card.difficulty : 5);

  // 记得: returns the next card, or null when nothing changes (not due yet).
  function remember(card, { wordId, at, day, tz }) {
    tz = offset(tz);
    if (card && !isDueOn(card, day, tz)) return null;
    const stage = stageOf(card);
    // Still due although it was answered today means today's answer was 忘记 (a success moves it past today).
    const lapsedToday = Boolean(card) && keyAt(card.lastReview, tz) === day;
    const next = lapsedToday ? Math.max(stage, 1) : Math.min(stage + 1, LADDER.length);
    const days = intervalOf(next);
    return { wordId: card ? card.wordId : wordId, state: STATE.REVIEW, stability: days, difficulty: difficulty(card), reps: (card ? card.reps : 0) + 1, lapses: card ? card.lapses : 0, due: noonOf(addDays(day, days), tz), lastReview: Math.max(at, card ? card.lastReview : 0) };
  }
  // 忘记: the curve stays where it is. Returns null when nothing changes (not due yet).
  function forget(card, { wordId, at, day, tz }) {
    tz = offset(tz);
    if (card && !isDueOn(card, day, tz)) return null;
    if (!card) return { wordId, state: STATE.LEARNING, stability: 1, difficulty: 5, reps: 1, lapses: 1, due: noonOf(day, tz), lastReview: at };
    return { ...card, difficulty: difficulty(card), reps: card.reps + 1, lapses: card.lapses + 1, due: Math.min(card.due, noonOf(day, tz)), lastReview: Math.max(at, card.lastReview) };
  }
  // One rating event { wordId, grade 1–4, at, day, tz? }. Grades 2–4 from older four-button clients mean 记得.
  function apply(card, event) {
    if (![1, 2, 3, 4].includes(event.grade)) throw new RangeError('grade must be 1–4');
    // An offline device may deliver yesterday's answer after a newer answer was saved elsewhere.
    if (card && event.at < card.lastReview) return null;
    return event.grade === 1 ? forget(card || null, event) : remember(card || null, event);
  }
  // Days until the date 「记得」 would set today (null when the card is not due), for the button caption.
  function preview(card, at, day, tz) {
    const next = remember(card || null, { wordId: card ? card.wordId : '', at, day, tz });
    return next ? next.stability : null;
  }

  return Object.freeze({ LADDER, STATE, MINUTE, DAY, DAY_KEY, startOfDay, dayDiff, keyAt, addDays, noonOf, stageOf, intervalOf, inLoop, isDueOn, remember, forget, apply, preview });
});
