'use strict';

// Shared behavior for the "← Back" link on legal pages (/privacy, /imprint).
// When the user arrived from the same origin (display or controller),
// prefer history.back() so they return to exactly where they were — the
// controller room instead of the display welcome, for example — and avoid
// adding a new history entry. Cross-origin or direct navigation falls
// through to the static href on the link.
(function () {
  var backEl = document.querySelector('.back-link');
  if (!backEl || !document.referrer) return;
  try {
    if (new URL(document.referrer).origin === location.origin) {
      backEl.addEventListener('click', function (e) {
        e.preventDefault();
        history.back();
      });
    }
  } catch (e) { /* invalid referrer URL */ }
})();
