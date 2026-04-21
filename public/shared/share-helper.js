'use strict';

// Shared Web Share handler for the device-choice banner — used by both the
// display and the controller entry scripts. Tries the native share sheet
// first, falls back to opening hexstacker.com in a new tab. AbortError
// (user cancelled the sheet) is silent; any other rejection means the
// browser blocked the share and we drop to the fallback.
//
// Exposed under a `HexStacker` namespace (rather than a bare global) so
// the short name can't collide with third-party scripts loaded on the
// page.
var HexStacker = window.HexStacker || {};
HexStacker.share = function (shareText) {
  // The URL is hardcoded to the canonical production host deliberately
  // (not `location.origin`) so shares from preview / local servers
  // still point people to the real app rather than a transient URL.
  var payload = {
    title: 'HexStacker Party',
    text: shareText,
    url: 'https://hexstacker.com'
  };
  // `canShare` (where supported) probes whether the browser actually
  // accepts this payload shape — some older WebViews implement
  // `navigator.share` but silently reject payloads that include
  // `text`, which would open an empty share sheet and dismiss it.
  var canShare = navigator.share && (!navigator.canShare || navigator.canShare(payload));
  if (canShare) {
    navigator.share(payload).catch(function (err) {
      if (err && err.name !== 'AbortError') {
        window.open('https://hexstacker.com', '_blank', 'noopener,noreferrer');
      }
    });
  } else {
    window.open('https://hexstacker.com', '_blank', 'noopener,noreferrer');
  }
};
window.HexStacker = HexStacker;
