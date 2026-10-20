// Only the guest's display-time preference persists here. No words, account identity or study records.
(function () {
  'use strict';
  const key = 'cet-review-guest-utc-offset-v1';
  window.LedgerReviewPreference = Object.freeze({
    read() { try { const v = JSON.parse(localStorage.getItem(key)); return v === null ? {} : { utcOffsetMinutes: v }; } catch { return {}; } },
    write(s) { try { localStorage.setItem(key, JSON.stringify(s.utcOffsetMinutes ?? null)); } catch { /* preference remains effective in this page */ } }
  });
})();
