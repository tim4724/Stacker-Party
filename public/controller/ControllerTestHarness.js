'use strict';

// =====================================================================
// Controller Test Harness — scenario-driven state injection for the
// gallery page. Active only when ?scenario= is present (visual tests use
// ?test=1 alone and rely on the real connect() flow — don't stomp them).
// Loaded last so controller.js has already run its default init.
// =====================================================================

(function() {
  var params = new URLSearchParams(window.location.search);
  // Only activate when a scenario is explicitly requested. Visual tests run
  // with ?test=1 alone and still depend on the real connect() flow — don't
  // stub it out for them.
  if (!params.get('scenario')) return;

  // Gallery iframe: block outbound network so stray button clicks don't
  // hit the real relay.
  window.connect = function() {};
  // submitName is block-scoped inside controller.js; we can't override it,
  // but its only side-effect that reaches the network is connect() — already
  // stubbed above.

  var scenario = params.get('scenario');
  var colorIdx = Math.max(0, Math.min(parseInt(params.get('color'), 10) || 0, 7));
  var levelParam = parseInt(params.get('level'), 10);
  var FAKE_NAMES = ['Emma','Jake','Sofia','Liam','Mia','Noah','Ava','Leo'];
  var fakeName = params.get('name') || FAKE_NAMES[colorIdx];
  // Default non-host scenarios to a host at the next color slot so the
  // player's own name never collides with the host being waited for.
  var defaultHostIdx = (colorIdx + 1) % 8;

  // Apply identity + host info that scenarios depend on.
  function applyIdentity(opts) {
    opts = opts || {};
    playerColor = PLAYER_COLORS[colorIdx];
    document.body.style.setProperty('--player-color', playerColor);
    playerName = fakeName;
    playerCount = opts.playerCount || 4;
    isHost = !!opts.isHost;
    hostName = opts.hostName || (isHost ? playerName : FAKE_NAMES[defaultHostIdx]);
    hostColor = opts.hostColor || (isHost ? playerColor : PLAYER_COLORS[defaultHostIdx]);
    if (!isNaN(levelParam)) startLevel = levelParam;
    playerNameEl.textContent = playerName;
    touchArea.setAttribute('data-player-name', playerName);
    if (nameInput) nameInput.value = playerName;
  }

  function buildFakeResults(myRank, count) {
    var ranks = [];
    var names = FAKE_NAMES;
    // Pick opponent slots that skip the player's own color so we don't
    // show two entries sharing the player's identity.
    var opponentSlot = 0;
    for (var i = 0; i < count; i++) {
      var isMe = i === myRank - 1;
      var slot = isMe ? colorIdx : (opponentSlot === colorIdx ? ++opponentSlot : opponentSlot);
      if (!isMe) opponentSlot++;
      ranks.push({
        playerId: isMe ? clientId : 'debug' + i,
        playerName: isMe ? playerName : names[slot % names.length],
        playerColor: isMe ? playerColor : PLAYER_COLORS[slot % PLAYER_COLORS.length],
        rank: i + 1,
        lines: 30 - i * 3,
        level: 5 - i
      });
    }
    return ranks;
  }

  function showPlaying() {
    gameScreen.classList.remove('dead');
    gameScreen.classList.remove('paused');
    gameScreen.classList.remove('countdown');
    gameScreen.style.setProperty('--player-color', playerColor);
    pauseOverlay.classList.add('hidden');
    reconnectOverlay.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    pauseBtn.disabled = false;
    showScreen('game');
    initTouchInput();
    // Fake a ping display so layout isn't blank.
    updatePingDisplay(42);
  }

  // --- Dispatch by scenario ---
  switch (scenario) {
    case 'name':
      // Gallery iframes share localStorage; if a prior scenario stored a
      // clientId_<roomCode>, controller.js init takes the "reconnect"
      // branch and leaves the JOIN button disabled with "CONNECTING…".
      // Reset the name screen to its pristine first-visit state.
      nameInput.value = '';
      nameInput.disabled = false;
      nameJoinBtn.disabled = false;
      nameJoinBtn.textContent = t('join');
      break;

    case 'name-connecting':
      nameInput.value = fakeName;
      nameJoinBtn.disabled = true;
      nameJoinBtn.textContent = t('connecting');
      nameInput.disabled = true;
      break;

    case 'lobby-host':
      applyIdentity({ isHost: true, playerCount: Math.max(1, parseInt(params.get('players'), 10) || 1) });
      showLobbyUI();
      break;

    case 'lobby-waiting':
      applyIdentity({ isHost: false, playerCount: Math.max(2, parseInt(params.get('players'), 10) || 2) });
      showLobbyUI();
      break;

    case 'lobby-latejoiner':
      applyIdentity({ isHost: false, playerCount: Math.max(2, parseInt(params.get('players'), 10) || 2) });
      waitingForNextGame = true;
      showLobbyUI();
      startBtn.classList.add('hidden');
      startBtn.disabled = true;
      setWaitingActionMessage(t('game_in_progress'));
      break;

    case 'countdown':
      applyIdentity({ isHost: false });
      gameScreen.classList.add('countdown');
      gameScreen.style.setProperty('--player-color', playerColor);
      pauseBtn.classList.remove('hidden');
      pauseBtn.disabled = false;
      showScreen('game');
      break;

    case 'playing':
      applyIdentity({ isHost: false });
      showPlaying();
      break;

    case 'playing-settings':
      applyIdentity({ isHost: !!params.get('host') });
      showPlaying();
      // openSettings() itself calls updateSettingsHostUI, which hides/shows
      // the Music (display-mute) row based on isHost.
      window.openSettings();
      break;

    case 'paused':
      applyIdentity({ isHost: !!params.get('host') });
      showPlaying();
      onGamePaused();
      updateHostVisibility();
      break;

    case 'ko':
      applyIdentity({ isHost: false });
      showPlaying();
      gameScreen.classList.add('dead');
      showKoOverlay();
      break;

    case 'reconnecting':
      applyIdentity({ isHost: false });
      showPlaying();
      reconnectOverlay.classList.remove('hidden');
      reconnectHeading.textContent = t('reconnecting');
      reconnectStatus.textContent = t('attempt_n_of_m', { attempt: 2, max: 5 });
      break;

    case 'disconnected':
      applyIdentity({ isHost: false });
      showPlaying();
      reconnectOverlay.classList.remove('hidden');
      reconnectHeading.textContent = t('disconnected');
      reconnectStatus.textContent = '';
      reconnectRejoinBtn.classList.remove('hidden');
      break;

    case 'results-winner': {
      var countW = Math.max(2, parseInt(params.get('players'), 10) || 3);
      applyIdentity({ isHost: true, playerCount: countW });
      var resultsW = buildFakeResults(1, countW);
      lastGameResults = resultsW;
      renderGameResults(resultsW);
      showScreen('gameover');
      break;
    }

    case 'results-loser': {
      var countL = Math.max(2, parseInt(params.get('players'), 10) || 3);
      applyIdentity({ isHost: false, playerCount: countL });
      // Rotate non-winner ranks (2..countL) across the 8 cards for variety.
      var defaultRank = 2 + (colorIdx % Math.max(1, countL - 1));
      var rank = Math.min(countL, Math.max(2, parseInt(params.get('rank'), 10) || defaultRank));
      var resultsL = buildFakeResults(rank, countL);
      lastGameResults = resultsL;
      renderGameResults(resultsL);
      showScreen('gameover');
      break;
    }

    case 'end':
      showEndScreen('game_ended', true);
      break;

    case 'end-full':
      showEndScreen('game_full', true);
      break;

    default:
      console.warn('[ControllerTestHarness] unknown scenario:', scenario);
  }
})();
