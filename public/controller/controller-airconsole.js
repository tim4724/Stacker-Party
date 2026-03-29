'use strict';

// =====================================================================
// AirConsole Controller Bootstrap
// Loaded AFTER all normal controller scripts but BEFORE controller.js init.
// Overrides PartyConnection so that connect() — which sets up callbacks
// and calls party.connect() — works with AirConsole instead.
// =====================================================================

var airconsole = new AirConsole({ orientation: AirConsole.ORIENTATION_PORTRAIT });

// controller.js reads roomCode from location.pathname. In AirConsole the URL
// is /controller.html which would be parsed as roomCode="controller.html".
// Replace the path with a fake room code so the main init block executes
// and sessionStorage keys align.
history.replaceState(null, '', '/airconsole' + location.search + location.hash);

// Pre-set clientId (adapter maps real AirConsole device IDs at message time)
clientId = 'ac_controller';

// Force hadStoredId so controller.js auto-connects on load (skips name screen)
sessionStorage.setItem('clientId_airconsole', clientId);

// Replace PartyConnection with a factory that returns AirConsoleAdapter.
// connect() calls `new PartyConnection(...)`, sets callbacks, then calls
// party.connect(). By replacing the constructor, we let the original
// function body run unchanged.
PartyConnection = function() {
  return new AirConsoleAdapter(airconsole, { role: 'controller' });
};

// Wrap connect() to inject AirConsole nickname and guard against re-connects
var _originalConnect = connect;
var _acOnReadyWrapped = false;
connect = function() {
  if (party && party.connected) return;
  _originalConnect();
  // Wrap onReady AFTER adapter is created to inject nickname from AirConsole profile
  if (!_acOnReadyWrapped) {
    _acOnReadyWrapped = true;
    var _adapterOnReady = airconsole.onReady;
    airconsole.onReady = function(code) {
      var nickname = airconsole.getNickname(airconsole.getDeviceId());
      if (nickname) playerName = nickname;
      if (_adapterOnReady) _adapterOnReady.call(airconsole, code);
    };
    // If AirConsole was already ready, trigger now
    if (party && party._acReady && !party._ready) {
      party._fireReady();
    }
  }
};

// Hide ping display — AirConsole manages connectivity
if (pingDisplay) pingDisplay.style.display = 'none';
