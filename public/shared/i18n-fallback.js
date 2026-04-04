// Safety net: if i18n.js fails to load, provide stub functions so the game stays functional.
if (typeof t === 'undefined') { t = function(k) { return k; }; tOrdinal = function(n) { return n + 'th'; }; }
