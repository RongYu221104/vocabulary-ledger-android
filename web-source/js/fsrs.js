(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.LedgerFSRS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // FSRS-6 (Free Spaced Repetition Scheduler, open-spaced-repetition). Pure functions only: a card state in, the
  // next card state out. Nothing here reads the clock, the DOM or storage, so the same inputs always schedule the
  // same way in the browser, in Node tests and on another device.
  //
  // Memory model (DSR): Difficulty D ∈ [1,10], Stability S (days until recall probability falls to 90%) and
  // Retrievability R(t,S) = (1 + F·t/S)^(−w20). A review at the right moment makes S grow; forgetting shrinks it.
  // W is the published FSRS-6 default parameter set, fitted on ~10k Anki collections.
  const W = Object.freeze([0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542]);
  const STATE = Object.freeze({ NEW: 0, LEARNING: 1, REVIEW: 2, RELEARNING: 3 });
  const RATING = Object.freeze({ AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 });
  const MINUTE = 60000, DAY = 86400000;
  const S_MIN = 0.001, S_MAX = 36500, MAX_INTERVAL = 36500;
  // Learning steps are short in-session re-shows, not days: a forgotten card comes back a few cards later.
  const STEP = Object.freeze({ again: MINUTE, hard: 5 * MINUTE, relearn: 10 * MINUTE });
  const DECAY = -W[20], FACTOR = Math.pow(0.9, 1 / DECAY) - 1;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  const retrievability = (days, stability) => (stability > 0 ? Math.pow(1 + FACTOR * Math.max(0, days) / stability, DECAY) : 0);
  // Days until R falls to the desired retention (equals S at 90%).
  const intervalFor = (stability, retention) => stability / FACTOR * (Math.pow(retention, 1 / DECAY) - 1);
  const initDifficulty = grade => W[4] - Math.exp(W[5] * (grade - 1)) + 1;
  const initStability = grade => Math.max(W[grade - 1], 0.1);
  function nextDifficulty(d, grade) {
    const damped = d + (-W[6] * (grade - 3)) * (10 - d) / 9;
    return clamp(W[7] * initDifficulty(4) + (1 - W[7]) * damped, 1, 10);
  }
  function recallStability(d, s, r, grade) {
    const hard = grade === RATING.HARD ? W[15] : 1, easy = grade === RATING.EASY ? W[16] : 1;
    return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy);
  }
  function forgetStability(d, s, r) {
    const next = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
    return Math.min(next, s / Math.exp(W[17] * W[18]));
  }
  // Same-day reviews (learning steps, a re-show in the same session) use the short-term formula.
  function shortTermStability(s, grade) {
    let increase = Math.exp(W[17] * (grade - 3 + W[18])) * Math.pow(s, -W[19]);
    if (grade >= RATING.HARD) increase = Math.max(increase, 1);
    return s * increase;
  }

  // Calendar days between two instants in the learner's local time zone (DST-safe).
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const dayDiff = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / DAY);

  // Deterministic fuzz: spreads cards learned together over neighbouring days without randomness, so a preview of
  // the four buttons always equals what the chosen button schedules, on every device.
  function hash(text) { let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
  function fuzz(days, seed) {
    if (days < 2.5) return days;
    const delta = 1 + 0.15 * (Math.min(days, 7) - 2.5) + (days > 7 ? 0.1 * (Math.min(days, 20) - 7) : 0) + (days > 20 ? 0.05 * (days - 20) : 0);
    const lo = Math.max(2, Math.round(days - delta)), hi = Math.round(days + delta);
    return Math.floor(hash(seed) * (hi - lo + 1)) + lo;
  }

  const empty = wordId => ({ wordId, state: STATE.NEW, stability: 0, difficulty: 0, reps: 0, lapses: 0, due: 0, lastReview: 0 });

  // The four possible next states of one card, keyed by rating 1–4.
  function preview(card, now, { retention = 0.9, maxInterval = MAX_INTERVAL } = {}) {
    if (!(typeof retention === 'number' && retention >= 0.7 && retention <= 0.99)) retention = 0.9;
    const base = card && card.state !== STATE.NEW ? card : empty(card ? card.wordId : '');
    const elapsed = base.state === STATE.NEW ? 0 : Math.max(0, Math.floor((now - base.lastReview) / DAY));
    const r = base.state === STATE.NEW ? 1 : retrievability(elapsed, base.stability);
    const out = {};
    for (const grade of [1, 2, 3, 4]) {
      let s, d;
      if (base.state === STATE.NEW) { s = initStability(grade); d = clamp(initDifficulty(grade), 1, 10); }
      else {
        d = nextDifficulty(base.difficulty, grade);
        if (elapsed < 1) s = shortTermStability(base.stability, grade);
        else s = grade === RATING.AGAIN ? forgetStability(base.difficulty, base.stability, r) : recallStability(base.difficulty, base.stability, r, grade);
      }
      s = clamp(s, S_MIN, S_MAX);
      const next = { wordId: base.wordId, state: STATE.REVIEW, stability: s, difficulty: d, reps: base.reps + 1, lapses: base.lapses, due: 0, lastReview: now };
      if (grade === RATING.AGAIN) {
        const lapsed = base.state === STATE.REVIEW || base.state === STATE.RELEARNING;
        if (base.state === STATE.REVIEW) next.lapses++;
        next.state = lapsed ? STATE.RELEARNING : STATE.LEARNING;
        next.due = now + (lapsed ? STEP.relearn : STEP.again);
      } else if (grade === RATING.HARD && base.state !== STATE.REVIEW) {
        // A first "模糊" earns one more look this session before the card graduates.
        next.state = base.state === STATE.RELEARNING ? STATE.RELEARNING : STATE.LEARNING; next.due = now + STEP.hard;
      }
      out[grade] = next;
    }
    // Graduating answers get whole-day intervals ordered 模糊 < 记得 < 轻松.
    const days = {};
    for (const grade of [2, 3, 4]) if (out[grade].state === STATE.REVIEW) {
      days[grade] = clamp(Math.round(fuzz(intervalFor(out[grade].stability, retention), base.wordId + ':' + base.reps + ':' + grade)), 1, maxInterval);
    }
    if (base.state === STATE.REVIEW) {
      if (days[2] && days[3]) days[2] = Math.min(days[2], Math.max(1, days[3] - 1));
      if (days[3]) days[3] = Math.max(days[3], (days[2] || 0) + 1);
      if (days[4]) days[4] = Math.max(days[4], (days[3] || 0) + 1);
    }
    for (const grade of [2, 3, 4]) if (days[grade]) out[grade].due = now + Math.min(days[grade], maxInterval) * DAY;
    return out;
  }
  const review = (card, grade, now, options) => {
    if (![1, 2, 3, 4].includes(grade)) throw new RangeError('rating must be 1–4');
    return preview(card, now, options)[grade];
  };
  // Probability of recall right now (1 for a card that was never studied is meaningless, so it reports 0).
  const recall = (card, now) => (!card || card.state === STATE.NEW ? 0 : retrievability(Math.max(0, Math.floor((now - card.lastReview) / DAY)), card.stability));

  // Short human label for the time until `due`, e.g. 1 分钟 · 10 分钟 · 3 天 · 2 个月.
  function label(ms) {
    const minutes = Math.max(1, Math.round(ms / MINUTE));
    if (minutes < 60) return minutes + ' 分钟';
    if (minutes < 60 * 24) return Math.round(minutes / 60) + ' 小时';
    const days = Math.round(ms / DAY);
    if (days < 31) return days + ' 天';
    if (days < 365) return Math.round(days / 30.4) + ' 个月';
    const years = days / 365;
    return (years < 10 ? Math.round(years * 10) / 10 : Math.round(years)) + ' 年';
  }

  return Object.freeze({ W, STATE, RATING, MINUTE, DAY, MAX_INTERVAL, empty, preview, review, recall, retrievability, intervalFor, initDifficulty, initStability, nextDifficulty, recallStability, forgetStability, shortTermStability, startOfDay, dayDiff, fuzz, label });
});
