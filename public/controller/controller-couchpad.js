'use strict';

// =====================================================================
// CouchPad Controller Bootstrap
// Loaded after ControllerConnection.js / ControllerGame.js (it wraps their
// globals at load time) but BEFORE controller.js init. Self-gated on ?cpName,
// which the launcher is the only thing to send, so this file is inert in
// plain browsers, gallery iframes, and the AirConsole build (which also
// strips it). There is no version param: every touchpoint is feature-detected,
// which is how the launcher adds capabilities without a coordinated release.
//
// Contract touchpoints:
//   launcher -> game   ?cpName=<name>                    join URL param
//   launcher -> game   window.CouchPad.setName(name)     live rename
//   game -> launcher   window.CouchPadHost.gameEnded(r)  terminal end
//     r: 'game_ended' | 'room_not_found' | 'game_full' | 'replaced'
//   game -> launcher   CouchPadHost.enableSystemBack(b)  arm the back gesture
//   launcher -> game   window.CouchPad.back()            armed back gesture
// The launcher is the identity authority: the name screen is skipped (CSS
// hides it via body.couchpad), the injected name is never persisted as the
// user's own typed name, and the shell owns leaving.
// =====================================================================

(function () {
  var params = new URLSearchParams(location.search);

  // The launcher guarantees a non-blank name of at most 16 chars; sanitize
  // anyway (same trim + length cap the name input's maxlength enforces).
  function sanitizeName(raw) {
    return String(raw == null ? '' : raw).trim().slice(0, 16);
  }
  // A usable cpName IS the gate: the launcher is the only thing that sends it,
  // and the shell can't run without the identity it carries.
  var shellName = sanitizeName(params.get('cpName'));
  if (!shellName) return;

  // CSS hooks — hides #name-screen and #lobby-back-btn (see the
  // body.couchpad rules in controller.css).
  document.body.classList.add('couchpad');

  // Take the auto-connect branch in controller.js init.
  skipNameScreen = true;

  // Inject the launcher-provided name right before each (re)connect — the
  // auto-connect init branch prefills playerName from localStorage first,
  // and a later reconnect must HELLO with the current shell name (setName
  // below keeps shellName up to date). The injected name is deliberately
  // NOT written to stacker_player_name: that key is the user's own typed
  // name for standalone web sessions. clientId IS persisted (mirroring
  // submitName, which the skipped name screen never runs) so a WebView
  // reload mid-session reconnects into the same player slot instead of
  // joining as a fresh player.
  var _originalConnect = connect;
  connect = function () {
    playerName = shellName;
    playerNameIsAuto = false;
    try {
      // A player is only in one room at a time — clean up other rooms' ids.
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var key = localStorage.key(i);
        if (key && key.indexOf('clientId_') === 0 && key !== 'clientId_' + roomCode) {
          localStorage.removeItem(key);
        }
      }
      localStorage.setItem('clientId_' + roomCode, clientId);
    } catch (e) { /* WebView storage disabled */ }
    _originalConnect();
  };

  // Live rename, called by the launcher when the user edits their name in
  // the shell. Shares applyShellRename (ControllerGame.js) with the
  // AirConsole profile-change path.
  window.CouchPad = {
    setName: function (name) {
      var next = sanitizeName(name);
      if (!next) return;
      // Keep shellName current even when the rename itself no-ops, so a
      // later reconnect HELLOs with the shell's latest name.
      shellName = next;
      applyShellRename(next);
    }
  };

  // Terminal session end → hand control back to the launcher instead of
  // location.replace('/?bail=…') — the display root is meaningless inside
  // the shell's WebView. Feature-detected so the same deployed controller
  // falls back to normal web behavior when the bridge is absent (plain
  // browser opening a ?cpName URL). Connection cleanup mirrors the original:
  // the launcher pops the WebView on gameEnded, but until it does this page
  // must not keep pinging a room it considers dead.
  var _originalBailToWelcome = bailToWelcome;
  bailToWelcome = function (toastKey, keepClientId) {
    var host = window.CouchPadHost;
    if (!host || typeof host.gameEnded !== 'function') {
      _originalBailToWelcome(toastKey, keepClientId);
      return;
    }
    if (gameCancelled) return;
    gameCancelled = true;
    stopPing();
    cancelFastlaneReopen();
    if (fastlane) { fastlane.closeAll(); fastlane = null; }
    if (party) { party.close(); party = null; }
    if (!keepClientId) {
      try { localStorage.removeItem('clientId_' + roomCode); } catch (e) { /* WebView storage disabled */ }
    }
    // keepClientId=true is only ever passed on the replaced-by-newer-tab
    // close (party.onClose meta.replaced), which carries no toastKey.
    host.gameEnded(toastKey || (keepClientId ? 'replaced' : 'game_ended'));
  };

  // Back never runs through history here. Same rationale as the AirConsole
  // bootstrap: skip the name→lobby history push so a spurious popstate can't
  // land on an entry that triggers performDisconnect, and no-op
  // performDisconnect itself as belt-and-suspenders. With no pushed modal
  // state, the settings Done button takes its direct hideSettings() fallback
  // instead of history.back(). The system gesture reaches us as back() below.
  history.pushState = function () {};
  performDisconnect = function () {};

  // --- System back (CONTRACT §9) ---
  // Arming yields the screen edges to the system, so it is off during a live
  // game where an edge swipe is a drag input. It is on where back has a
  // meaning: over an open dialog, which back() closes, and in the lobby and on
  // the results screen, where nothing is open and an unconsumed gesture leaves
  // the game the same way the shell's LEAVE bar does.
  function isOpen(el) {
    return !!el && !el.classList.contains('hidden');
  }

  // The pause overlay lives inside the game screen and is not always cleared
  // on the way out (a game that ends while paused goes straight to results),
  // so its class alone doesn't mean the player is looking at it.
  function pauseOpen() {
    return currentScreen === 'game' && isOpen(pauseOverlay);
  }

  var backArmed = null;
  function syncSystemBack() {
    var want = isOpen(settingsOverlay) || isOpen(colorPickerOverlay) || pauseOpen()
      || currentScreen === 'lobby' || currentScreen === 'gameover';
    if (want === backArmed) return;
    backArmed = want;
    var host = window.CouchPadHost;
    if (host && typeof host.enableSystemBack === 'function') host.enableSystemBack(want);
  }

  // Dialogs open and close from a dozen places (buttons, room snapshots, the
  // reconnect path, the test harness); the `hidden` class is the one thing
  // every path agrees on, so watch that instead of wrapping each caller.
  var overlayWatch = new MutationObserver(syncSystemBack);
  [settingsOverlay, colorPickerOverlay, pauseOverlay].forEach(function (el) {
    if (el) overlayWatch.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  var _originalShowScreen = showScreen;
  showScreen = function (name) {
    _originalShowScreen(name);
    syncSystemBack();
  };
  syncSystemBack();

  // Called by the launcher once per gesture, only while armed. Anything but a
  // literal true leaves the game, so the lobby and results answer nothing and
  // fall through. Settings first: it can sit on top of the pause overlay.
  // Decided synchronously: a Promise counts as unconsumed.
  window.CouchPad.back = function () {
    if (isOpen(settingsOverlay)) { window.closeSettingsOverlay(); return true; }
    if (isOpen(colorPickerOverlay)) { closeColorPicker(); return true; }
    if (pauseOpen()) { sendToDisplay(MSG.RESUME_GAME); return true; }
    return false;
  };
})();
