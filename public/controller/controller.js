'use strict';

(function () {
  // State
  var party = null;
  var clientId = null;
  var playerColor = null;
  var playerName = null;
  var roomCode = null;
  var touchInput = null;
  var currentScreen = 'name';
  var isHost = false;
  var playerCount = 0;
  var gameCancelled = false;
  var lastLines = 0;
  var lastGameResults = null;

  // Ping/pong
  var PING_INTERVAL_MS = 1000;
  var PONG_TIMEOUT_MS = 3000;
  var pingTimer = null;
  var pongCheckTimer = null;
  var lastPongTime = 0;

  function getViewportMetrics() {
    if (window.visualViewport) {
      return {
        width: Math.round(window.visualViewport.width),
        height: Math.round(window.visualViewport.height),
        offsetTop: Math.round(window.visualViewport.offsetTop || 0),
      };
    }
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetTop: 0,
    };
  }

  function syncViewportLayout() {
    var metrics = getViewportMetrics();
    var keyboardInset = Math.max(0, window.innerHeight - metrics.height - metrics.offsetTop);
    var keyboardOpen = keyboardInset > 120
      && currentScreen === 'name'
      && document.activeElement === nameInput;

    document.documentElement.style.setProperty('--app-height', metrics.height + 'px');
    document.documentElement.style.setProperty('--keyboard-inset', keyboardInset + 'px');
    document.body.classList.toggle('keyboard-open', keyboardOpen);

    if (welcomeBg) {
      welcomeBg.resize(metrics.width, metrics.height);
    }
  }

  // Falling tetromino background
  var bgCanvas = document.getElementById('bg-canvas');
  var welcomeBg = null;
  if (bgCanvas) {
    welcomeBg = new WelcomeBackground(bgCanvas, 8);
    var metrics = getViewportMetrics();
    welcomeBg.resize(metrics.width, metrics.height);
    welcomeBg.start();
  }
  window.addEventListener('resize', syncViewportLayout);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportLayout);
    window.visualViewport.addEventListener('scroll', syncViewportLayout);
  }

  // DOM refs
  var nameForm = document.getElementById('name-form');
  var nameInput = document.getElementById('name-input');
  var nameJoinBtn = document.getElementById('name-join-btn');
  var nameStatusText = document.getElementById('name-status-text');
  var nameStatusDetail = document.getElementById('name-status-detail');
  var roomGoneMessage = document.getElementById('room-gone-message');
  var roomGoneHeading = document.getElementById('room-gone-heading');
  var roomGoneDetail = document.getElementById('room-gone-detail');
  var nameScreen = document.getElementById('name-screen');
  var lobbyScreen = document.getElementById('lobby-screen');
  var lobbyBackBtn = document.getElementById('lobby-back-btn');
  var lobbyTitle = document.getElementById('lobby-title');
  var waitingActionText = document.getElementById('waiting-action-text');
  var gameScreen = document.getElementById('game-screen');
  var gameoverScreen = document.getElementById('gameover-screen');
  var playerIdentity = document.getElementById('player-identity');
  var startBtn = document.getElementById('start-btn');
  var statusText = document.getElementById('status-text');
  var statusDetail = document.getElementById('status-detail');
  var playerNameEl = document.getElementById('player-name');
  var playerIdentityName = document.getElementById('player-identity-name');
  var touchArea = document.getElementById('touch-area');
  var feedbackLayer = document.getElementById('feedback-layer');
  var resultsList = document.getElementById('results-list');
  var gameoverButtons = document.getElementById('gameover-buttons');
  var playAgainBtn = document.getElementById('play-again-btn');
  var newGameBtn = document.getElementById('new-game-btn');
  var gameoverStatus = document.getElementById('gameover-status');
  var pauseBtn = document.getElementById('pause-btn');
  var pauseOverlay = document.getElementById('pause-overlay');
  var pauseContinueBtn = document.getElementById('pause-continue-btn');
  var pauseNewGameBtn = document.getElementById('pause-newgame-btn');
  var pauseStatus = document.getElementById('pause-status');
  var pauseButtons = document.getElementById('pause-buttons');
  var reconnectOverlay = document.getElementById('reconnect-overlay');
  var reconnectHeading = document.getElementById('reconnect-heading');
  var reconnectStatus = document.getElementById('reconnect-status');
  var reconnectRejoinBtn = document.getElementById('reconnect-rejoin-btn');
  var pingDisplay = document.getElementById('ping-display');
  var muteBtn = document.getElementById('mute-btn');
  ControllerAudio.setMuted(localStorage.getItem('tetris_muted') === '1');

  // Apply initial mute state
  if (ControllerAudio.isMuted()) {
    muteBtn.classList.add('muted');
    muteBtn.querySelector('.sound-waves').style.display = 'none';
  }

  muteBtn.addEventListener('click', function () {
    vibrate(10);
    ControllerAudio.setMuted(!ControllerAudio.isMuted());
    localStorage.setItem('tetris_muted', ControllerAudio.isMuted() ? '1' : '0');
    muteBtn.classList.toggle('muted', ControllerAudio.isMuted());
    muteBtn.querySelector('.sound-waves').style.display = ControllerAudio.isMuted() ? 'none' : '';
  });

  // Screen management
  var SCREEN_ORDER = { name: 0, lobby: 1, game: 2, gameover: 3 };

  function showScreen(name) {
    var prev = currentScreen;
    currentScreen = name;
    nameScreen.classList.toggle('hidden', name !== 'name');
    lobbyScreen.classList.toggle('hidden', name !== 'lobby');
    gameScreen.classList.toggle('hidden', name !== 'game');
    gameoverScreen.classList.toggle('hidden', name !== 'gameover');

    if (welcomeBg) {
      if (name === 'name' || name === 'lobby') {
        bgCanvas.classList.remove('hidden');
        welcomeBg.start();
      } else {
        welcomeBg.stop();
        bgCanvas.classList.add('hidden');
      }
    }

    if ((SCREEN_ORDER[name] || 0) > (SCREEN_ORDER[prev] || 0)) {
      history.pushState({ screen: name }, '');
    }

    syncViewportLayout();
  }

  // Extract room code from URL path
  roomCode = location.pathname.split('/').filter(Boolean)[0] || null;
  var rejoinId = new URLSearchParams(location.search).get('rejoin');
  if (!roomCode) {
    showRoomGone();
    return;
  }

  // Generate or restore clientId
  function generateClientId() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var id = '';
    for (var i = 0; i < 12; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
  }

  // Check for stored clientId BEFORE generating a new one (used for auto-reconnect)
  var hadStoredId = sessionStorage.getItem('clientId_' + roomCode);

  if (rejoinId) {
    // QR-based rejoin — use the clientId from the URL to reclaim the slot
    clientId = rejoinId;
  } else {
    clientId = hadStoredId || generateClientId();
    sessionStorage.setItem('clientId_' + roomCode, clientId);
  }

  // --- Name input ---
  var savedName = localStorage.getItem('tetris_player_name') || '';

  function submitName() {
    var name = nameInput.value.trim();

    playerName = name || null;
    if (name) localStorage.setItem('tetris_player_name', name);
    nameJoinBtn.disabled = true;
    nameJoinBtn.textContent = 'CONNECTING...';
    nameInput.disabled = true;
    nameStatusText.textContent = '';
    nameStatusDetail.textContent = '';
    connect();
  }

  nameJoinBtn.addEventListener('click', function () { vibrate(10); submitName(); });
  nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitName();
  });
  nameInput.addEventListener('focus', function () {
    setTimeout(syncViewportLayout, 50);
  });
  nameInput.addEventListener('blur', function () {
    setTimeout(syncViewportLayout, 50);
  });

  function vibrate(pattern) {
    if (!navigator.vibrate) return;
    navigator.vibrate(pattern);
  }

  // Prime audio on first interaction
  document.addEventListener('pointerdown', function onFirstPointer() {
    vibrate(1);
    ControllerAudio.prime();
    document.removeEventListener('pointerdown', onFirstPointer, true);
  }, { capture: true, passive: true });

  // =====================================================================
  // Party-Server Connection
  // =====================================================================

  function connect() {
    if (party) party.close();

    party = new PartyConnection(RELAY_URL, { clientId: clientId });

    party.onOpen = function () {
      party.join(roomCode);
    };

    party.onProtocol = function (type, msg) {
      if (type === 'joined') {
        // Successfully joined room — send hello to display
        startPing();
        vibrate(10);
        party.sendTo('display', {
          type: MSG.HELLO,
          name: playerName
        });
      } else if (type === 'peer_left') {
        if (msg.clientId === 'display') {
          // Display disconnected — show reconnect overlay, it may come back
          if (currentScreen === 'game') {
            reconnectOverlay.classList.remove('hidden');
            reconnectHeading.textContent = 'RECONNECTING';
            reconnectStatus.textContent = 'Display reconnecting...';
            reconnectRejoinBtn.classList.add('hidden');
          }
        }
      } else if (type === 'error') {
        showRoomGone();
      }
    };

    party.onMessage = function (from, data) {
      if (from === 'display') {
        handleMessage(data);
      }
    };

    party.onClose = function (attempt, maxAttempts) {
      stopPing();
      if (gameCancelled) return;
      if (currentScreen === 'game') {
        reconnectOverlay.classList.remove('hidden');
        if (attempt >= maxAttempts) {
          reconnectHeading.textContent = 'DISCONNECTED';
          reconnectStatus.textContent = '';
          reconnectRejoinBtn.classList.remove('hidden');
        } else {
          reconnectHeading.textContent = 'RECONNECTING';
          reconnectStatus.textContent = 'Attempt ' + attempt + ' of ' + maxAttempts;
          reconnectRejoinBtn.classList.add('hidden');
        }
      }
    };

    party.connect();
  }

  // =====================================================================
  // Ping / Pong
  // =====================================================================

  function startPing() {
    stopPing();
    lastPongTime = Date.now();
    pingTimer = setInterval(function () {
      party.sendTo('display', { type: MSG.PING, t: Date.now() });
    }, PING_INTERVAL_MS);
    pongCheckTimer = setInterval(function () {
      if (Date.now() - lastPongTime > PONG_TIMEOUT_MS) {
        // Stop ping/pong and force reconnect through normal attempt cycle
        stopPing();
        if (currentScreen === 'game') {
          reconnectOverlay.classList.remove('hidden');
          reconnectHeading.textContent = 'RECONNECTING';
          reconnectStatus.textContent = 'Display not responding';
          reconnectRejoinBtn.classList.add('hidden');
        }
        party.reconnectNow();
      }
    }, 1000);
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (pongCheckTimer) { clearInterval(pongCheckTimer); pongCheckTimer = null; }
  }

  function updatePingDisplay(ms) {
    if (!pingDisplay) return;
    pingDisplay.textContent = ms + 'ms';
    pingDisplay.classList.remove('ping-good', 'ping-ok', 'ping-bad');
    pingDisplay.classList.add(ms < 50 ? 'ping-good' : ms < 100 ? 'ping-ok' : 'ping-bad');
  }

  // =====================================================================
  // Send Helper
  // =====================================================================

  function sendToDisplay(type, payload) {
    if (!party) return;
    party.sendTo('display', Object.assign({ type: type }, payload));
  }

  // =====================================================================
  // Message Handling
  // =====================================================================

  function handleMessage(data) {
    switch (data.type) {
      case MSG.WELCOME:
        onWelcome(data);
        break;
      case MSG.LOBBY_UPDATE:
        onLobbyUpdate(data);
        break;
      case MSG.GAME_START:
        onGameStart();
        break;
      case MSG.COUNTDOWN:
        removeKoOverlay();
        if (currentScreen !== 'game') {
          gameScreen.classList.remove('dead');
          gameScreen.classList.remove('paused');
          gameScreen.classList.add('countdown');
          gameScreen.style.setProperty('--player-color', playerColor);
          pauseOverlay.classList.add('hidden');
          pauseBtn.disabled = false;
          pauseBtn.classList.toggle('hidden', !isHost);
          showScreen('game');
        }
        break;
      case MSG.PLAYER_STATE:
        onPlayerState(data);
        break;
      case MSG.GAME_OVER:
        break;
      case MSG.GAME_END:
        onGameEnd(data);
        break;
      case MSG.GAME_PAUSED:
        onGamePaused();
        break;
      case MSG.GAME_RESUMED:
        onGameResumed();
        break;
      case MSG.RETURN_TO_LOBBY:
        playerCount = data.playerCount || playerCount;
        gameScreen.classList.remove('dead');
        gameScreen.classList.remove('paused');
        showLobbyUI();
        break;
      case MSG.PONG:
        lastPongTime = Date.now();
        if (data.t) {
          var rtt = Date.now() - data.t;
          updatePingDisplay(Math.round(rtt / 2));
        }
        reconnectOverlay.classList.add('hidden');
        break;
      case MSG.ERROR:
        onError(data);
        break;
    }
  }

  function onWelcome(data) {
    playerColor = data.playerColor || PLAYER_COLORS[0];
    isHost = !!data.isHost;
    playerCount = data.playerCount || 1;
    gameCancelled = false;

    reconnectOverlay.classList.add('hidden');

    // Use display-assigned name if we didn't provide one (e.g. "P1")
    if (!playerName) playerName = data.playerName || 'Player';
    playerNameEl.textContent = playerName;

    // Reconnected into active game
    if (data.roomState === 'playing' || data.roomState === 'countdown') {
      gameScreen.classList.remove('dead');
      gameScreen.classList.remove('paused');
      gameScreen.style.setProperty('--player-color', playerColor);
      removeKoOverlay();

      if (data.paused) {
        onGamePaused();
      } else {
        pauseOverlay.classList.add('hidden');
        pauseBtn.classList.toggle('hidden', !isHost);
      }

      if (data.alive === false) {
        gameScreen.classList.add('dead');
        showKoOverlay();
      }

      showScreen('game');
      initTouchInput();
      return;
    }

    // Reconnected into results
    if (data.roomState === 'results' && lastGameResults) {
      renderGameResults(lastGameResults);
      showScreen('gameover');
      return;
    }

    showLobbyUI();
  }

  function onLobbyUpdate(data) {
    playerCount = data.playerCount;
    if (typeof data.isHost === 'boolean') {
      isHost = data.isHost;
    }
    if (isHost) updateStartButton();
  }

  function updateStartButton() {
    startBtn.textContent = 'START (' + playerCount + (playerCount === 1 ? ' player)' : ' players)');
  }

  function setWaitingActionMessage(message) {
    waitingActionText.textContent = message || '';
    waitingActionText.classList.toggle('hidden', !message);
  }

  function performDisconnect() {
    stopPing();
    if (party) {
      try { party.sendTo('display', { type: MSG.LEAVE }); } catch (_) {}
      party.close();
      party = null;
    }
    sessionStorage.removeItem('clientId_' + roomCode);
    var params = new URLSearchParams(location.search);
    params.delete('rejoin');
    var qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    rejoinId = null;
    clientId = generateClientId();
    sessionStorage.setItem('clientId_' + roomCode, clientId);
    playerColor = null;
    isHost = false;
    gameCancelled = false;
    nameInput.value = playerName || '';
    nameJoinBtn.disabled = false;
    nameJoinBtn.textContent = 'JOIN';
    nameInput.disabled = false;
    nameStatusText.textContent = '';
    nameStatusDetail.textContent = '';
    roomGoneMessage.classList.add('hidden');
    reconnectOverlay.classList.add('hidden');
    showScreen('name');
    nameInput.focus();
  }

  function showRoomGone() {
    sessionStorage.removeItem('clientId_' + roomCode);
    gameCancelled = true;
    nameForm.classList.add('hidden');
    nameJoinBtn.classList.add('hidden');
    nameStatusText.textContent = '';
    nameStatusDetail.textContent = '';
    roomGoneHeading.textContent = 'Room Not Found';
    roomGoneDetail.textContent = 'Scan Game QR code to join';
    roomGoneMessage.classList.remove('hidden');
    showScreen('name');
  }

  function showErrorState(heading, detail) {
    sessionStorage.removeItem('clientId_' + roomCode);
    gameCancelled = true;
    stopPing();

    nameJoinBtn.disabled = false;
    nameJoinBtn.textContent = 'JOIN';
    nameInput.disabled = false;
    roomGoneMessage.classList.add('hidden');

    nameStatusText.textContent = heading;
    nameStatusDetail.textContent = detail || '';
    showScreen('name');
  }

  function showLobbyUI() {
    playerIdentity.style.setProperty('--player-color', playerColor);
    playerIdentityName.textContent = playerName || 'Player';

    if (isHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = false;
      setWaitingActionMessage('');
      updateStartButton();
      statusText.textContent = '';
      statusDetail.textContent = '';
    } else {
      startBtn.classList.add('hidden');
      setWaitingActionMessage('Waiting for host to start...');
      statusText.textContent = '';
      statusDetail.textContent = '';
    }

    showScreen('lobby');
  }

  function onGameStart() {
    ControllerAudio.tick();
    lastLines = 0;
    gameScreen.classList.remove('dead');
    gameScreen.classList.remove('paused');
    gameScreen.classList.remove('countdown');
    gameScreen.style.setProperty('--player-color', playerColor);
    removeKoOverlay();
    reconnectOverlay.classList.add('hidden');
    pauseOverlay.classList.add('hidden');
    pauseBtn.disabled = false;
    pauseBtn.classList.toggle('hidden', !isHost);
    showScreen('game');
    initTouchInput();
  }

  function onPlayerState(data) {
    if (!touchInput) {
      gameScreen.classList.remove('countdown');
      pauseBtn.disabled = false;
      pauseBtn.classList.toggle('hidden', !isHost);
      initTouchInput();
    }
    if (data.lines !== undefined && data.lines > lastLines) {
      ControllerAudio.lineClear(data.lines - lastLines);
    }
    if (data.lines !== undefined) lastLines = data.lines;
    if (data.alive === false && !gameScreen.classList.contains('dead')) {
      gameScreen.classList.add('dead');
      showKoOverlay();
    }
  }

  function onGameEnd(data) {
    lastGameResults = data.results;
    renderGameResults(data.results);
    showScreen('gameover');
  }

  function renderGameResults(results) {
    resultsList.innerHTML = '';
    gameoverButtons.classList.toggle('hidden', !isHost);
    gameoverStatus.textContent = isHost ? '' : 'Waiting for host...';

    var winnerColor = 'rgba(255, 215, 0, 0.06)';
    if (results && results.length) {
      var winner = results.find(function(r) { return r.rank === 1; });
      if (winner) {
        var wc = winner.playerColor || PLAYER_COLORS[0];
        winnerColor = 'color-mix(in srgb, ' + wc + ' 8%, transparent)';
      }
    }
    gameoverScreen.style.setProperty('--winner-glow', winnerColor);

    if (playerColor) {
      gameoverScreen.style.setProperty('--me-color', playerColor);
    }

    if (!results || !results.length) return;

    var sorted = results.slice().sort(function(a, b) { return a.rank - b.rank; });
    var solo = sorted.length === 1;
    for (var i = 0; i < sorted.length; i++) {
      var r = sorted[i];
      var pColor = r.playerColor || PLAYER_COLORS[i % PLAYER_COLORS.length];

      var row = document.createElement('div');
      row.className = solo ? 'result-row' : 'result-row rank-' + r.rank;
      row.style.setProperty('--row-delay', (0.2 + i * 0.08) + 's');
      if (r.playerId === clientId) row.classList.add('is-me');

      if (!solo) {
        var rankEl = document.createElement('span');
        rankEl.className = 'result-rank';
        rankEl.textContent = r.rank <= 3 ? ['', '1st', '2nd', '3rd'][r.rank] : r.rank + 'th';
        row.appendChild(rankEl);
      }

      var info = document.createElement('div');
      info.className = 'result-info';

      var nameEl = document.createElement('span');
      nameEl.className = 'result-name';
      nameEl.textContent = r.playerName || 'Player';
      nameEl.style.color = pColor;

      var stats = document.createElement('div');
      stats.className = 'result-stats';
      stats.innerHTML = '<span>' + (r.score || 0).toLocaleString() + ' points</span><span>' + (r.lines || 0) + ' lines</span><span>Lv ' + (r.level || 1) + '</span>';

      info.appendChild(nameEl);
      info.appendChild(stats);
      row.appendChild(info);
      resultsList.appendChild(row);
    }
  }

  function onError(data) {
    if (data.code === 'HOST_DISCONNECTED') {
      showErrorState('', 'Host disconnected');
      return;
    }
    if (data.message === 'Room not found' || data.message === 'Room is full') {
      showRoomGone();
      return;
    }
    showErrorState('', data.message || 'Unknown error');
  }

  // Pause
  function onGamePaused() {
    gameScreen.classList.add('paused');
    pauseOverlay.classList.remove('hidden');
    pauseBtn.classList.add('hidden');
    if (isHost) {
      pauseButtons.classList.remove('hidden');
      pauseStatus.textContent = '';
    } else {
      pauseButtons.classList.add('hidden');
      pauseStatus.textContent = '';
    }
  }

  function onGameResumed() {
    gameScreen.classList.remove('paused');
    pauseOverlay.classList.add('hidden');
    if (isHost) {
      pauseBtn.classList.remove('hidden');
    }
  }

  pauseBtn.addEventListener('click', function () {
    if (!isHost) return;
    vibrate(10);
    sendToDisplay(MSG.PAUSE_GAME);
  });

  pauseContinueBtn.addEventListener('click', function () {
    if (!isHost) return;
    vibrate(10);
    sendToDisplay(MSG.RESUME_GAME);
  });

  pauseNewGameBtn.addEventListener('click', function () {
    if (!isHost) return;
    vibrate(10);
    sendToDisplay(MSG.RETURN_TO_LOBBY);
  });

  // KO overlay
  function showKoOverlay() {
    removeKoOverlay();
    var ko = document.createElement('div');
    ko.id = 'ko-overlay';
    ko.textContent = 'KO';
    touchArea.appendChild(ko);
  }

  function removeKoOverlay() {
    var el = document.getElementById('ko-overlay');
    if (el) el.remove();
  }

  // Gesture feedback
  var lastTouchX = 0, lastTouchY = 0;
  var coordTracker = null;
  var softDropActive = false;
  var softDropWash = null;
  var buildupEl = null;
  var buildupDir = null;

  function createFeedback(type, x, y) {
    var el = document.createElement('div');
    el.className = 'feedback-' + type;
    if (x !== undefined && y !== undefined) {
      var rect = feedbackLayer.getBoundingClientRect();
      el.style.left = (x - rect.left) + 'px';
      el.style.top = (y - rect.top) + 'px';
    }
    feedbackLayer.appendChild(el);
    el.addEventListener('animationend', function () { el.remove(); });
  }

  function createWash(direction) {
    var el = document.createElement('div');
    el.className = 'feedback-wash feedback-wash-' + direction;
    feedbackLayer.appendChild(el);
    el.addEventListener('animationend', function () { el.remove(); });
  }

  function removeBuildupEl() {
    if (buildupEl) {
      buildupEl.remove();
      buildupEl = null;
      buildupDir = null;
    }
  }

  function flashBuildup() {
    if (buildupEl) {
      buildupEl.classList.add('flash');
      var el = buildupEl;
      buildupEl = null;
      buildupDir = null;
      el.addEventListener('animationend', function () { el.remove(); });
    }
  }

  function onDragProgress(direction, progress) {
    if (!direction || progress <= 0) {
      removeBuildupEl();
      return;
    }
    if (buildupDir !== direction) {
      removeBuildupEl();
      var washDir = direction;
      if (direction === 'left') washDir = 'right';
      else if (direction === 'right') washDir = 'left';
      else if (direction === 'down') washDir = 'up';
      else if (direction === 'up') washDir = 'down';
      buildupEl = document.createElement('div');
      buildupEl.className = 'feedback-buildup feedback-wash-' + washDir;
      feedbackLayer.appendChild(buildupEl);
      buildupDir = direction;
    }
    buildupEl.style.opacity = progress * 0.15;
  }

  // Touch input
  function initTouchInput() {
    if (touchInput) {
      touchInput.destroy();
    }

    if (coordTracker) touchArea.removeEventListener('pointerdown', coordTracker);
    coordTracker = function (e) {
      lastTouchX = e.clientX;
      lastTouchY = e.clientY;
    };
    touchArea.addEventListener('pointerdown', coordTracker, { passive: true });

    touchInput = new TouchInput(touchArea, function (action, data) {
      // Gesture feedback
      if (action === 'rotate_cw') {
        ControllerAudio.tick();
        createFeedback('ripple', lastTouchX, lastTouchY);
      } else if (action === 'left' || action === 'right') {
        ControllerAudio.tick();
        if (buildupEl) {
          flashBuildup();
        } else {
          createWash(action === 'left' ? 'right' : 'left');
        }
      } else if (action === 'hard_drop') {
        ControllerAudio.drop();
        removeBuildupEl();
        createWash('up');
      } else if (action === 'hold') {
        ControllerAudio.hold();
        removeBuildupEl();
        createWash('down');
      }

      if (action === 'soft_drop') {
        if (!softDropActive) {
          softDropActive = true;
          ControllerAudio.tick();
          removeBuildupEl();
          softDropWash = document.createElement('div');
          softDropWash.className = 'feedback-wash feedback-wash-up feedback-wash-hold';
          feedbackLayer.appendChild(softDropWash);
        }
        sendToDisplay(MSG.SOFT_DROP, { speed: data && data.speed });
      } else if (action === 'soft_drop_end') {
        // Local visual cleanup only — no network message sent
        softDropActive = false;
        if (softDropWash) {
          var el = softDropWash;
          softDropWash = null;
          el.classList.add('fade-out');
          el.addEventListener('animationend', function () { el.remove(); });
        }
      } else {
        // Regular input: left, right, rotate_cw, hard_drop, hold
        sendToDisplay(MSG.INPUT, { action: action });
      }
    }, onDragProgress);
  }

  // Reconnect overlay rejoin button
  reconnectRejoinBtn.addEventListener('click', function () {
    vibrate(10);
    reconnectOverlay.classList.add('hidden');
    performDisconnect();
  });

  // Lobby back button
  lobbyBackBtn.addEventListener('click', function () {
    vibrate(10);
    performDisconnect();
  });

  // Start button (host only)
  startBtn.addEventListener('click', function () {
    if (!isHost || startBtn.disabled) return;
    vibrate(10);
    sendToDisplay(MSG.START_GAME);
  });

  // Play Again button (host only)
  playAgainBtn.addEventListener('click', function () {
    if (!isHost) return;
    vibrate(10);
    sendToDisplay(MSG.PLAY_AGAIN);
  });

  // New Game button (host only)
  newGameBtn.addEventListener('click', function () {
    if (!isHost) return;
    vibrate(10);
    sendToDisplay(MSG.RETURN_TO_LOBBY);
  });

  // Visibility change — force reconnection when page becomes visible
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (gameCancelled) return;
    if (currentScreen === 'name' && !playerColor) return;

    // Tear down stale connection and reconnect
    stopPing();
    if (party) {
      party.close();
      party = null;
    }
    connect();
  });

  // Browser back button
  window.addEventListener('popstate', function () {
    if (currentScreen === 'lobby') {
      performDisconnect();
    } else if (currentScreen === 'game' || currentScreen === 'gameover') {
      history.pushState({ screen: currentScreen }, '');
    }
  });

  // --- Initialization ---
  if ((hadStoredId || rejoinId) && savedName) {
    playerName = savedName || null;
    nameInput.value = savedName;
    nameJoinBtn.disabled = true;
    nameJoinBtn.textContent = 'CONNECTING...';
    nameInput.disabled = true;
    nameStatusText.textContent = '';
    nameStatusDetail.textContent = '';
    showScreen('name');
    connect();
  } else {
    nameInput.value = savedName;
    nameStatusText.textContent = '';
    nameStatusDetail.textContent = '';
    showScreen('name');
    nameInput.focus();
  }

  syncViewportLayout();
})();
