'use strict';

// =====================================================================
// Display Game — game lifecycle, event handlers, audio
// Depends on: DisplayState.js (globals), DisplayConnection.js (publishRoomState, showDisconnectQR)
// Called by: display.js (message handlers and UI buttons)
// =====================================================================

// Wake Lock — prevent screen sleep during active games
function acquireWakeLock() {
  if (!navigator.wakeLock) return;
  navigator.wakeLock.request('screen').then(function(lock) {
    wakeLock = lock;
    lock.addEventListener('release', function() { wakeLock = null; });
  }).catch(function() {});
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(function() {});
    wakeLock = null;
  }
}

function startGame() {
  if (roomState !== ROOM_STATE.LOBBY) return;
  if (players.size < 1) return;
  startNewGame();
}

function playAgain() {
  if (roomState !== ROOM_STATE.RESULTS) return;
  if (players.size < 1) return;
  startNewGame();
}

// =====================================================================
// Pause
//
// Six operations, one per (reason, direction). The DECISIONS — which reason wins
// and which trigger may lift which freeze — belong to roomCore.pause/resume, so
// tvOS and Android TV run this same state machine rather than three lookalikes.
// What lives here is only the effects: engine, music, overlay, toolbar chrome.
// =====================================================================

// Toolbar chrome follows the reason: an auto-pause means nobody is at the
// controllers, so the toolbar stops auto-hiding and the cursor comes back.
function applyPauseChrome() {
  var isAuto = roomCore.pauseReason === PAUSE.AUTO;
  if (gameToolbar && currentScreen === SCREEN.GAME && !document.body.classList.contains('airconsole')) {
    document.body.classList.toggle('cursor-hidden', !isAuto);
    gameToolbar.classList.toggle('toolbar-autohide', !isAuto);
  }
}

// Stop the world. Shared by all three pause reasons; only the overlay differs,
// and that is the caller's business.
function freezeGame() {
  if (roomState === ROOM_STATE.COUNTDOWN) clearCountdownTimers();
  if (displayGame) displayGame.pause();
  if (music) music.pause();
  applyPauseChrome();
}

// Start it again. During COUNTDOWN the digits own the clock, so the current
// number gets its full second back (a shown GO re-arms its 500ms hold) instead
// of the engine resuming.
function thawGame() {
  applyPauseChrome();
  if (displayGame) displayGame.resume();
  if (music) music.resume();
  hidePauseOverlay();
  countdownOverlay.classList.remove('paused');
  // A countdown number still on screen came back with the scrim.
  if (countdownNumber.textContent) {
    cancelFadeHide(countdownOverlay);
    countdownOverlay.classList.remove('hidden');
  }
  if (roomState !== ROOM_STATE.COUNTDOWN || !countdown.callback) return;
  if (countdown.remaining === 0) {
    armCountdownDismiss();
    countdown.goTimeout = setTimeout(function() {
      countdown.goTimeout = null;
      countdown.callback();
    }, GameConstants.COUNTDOWN_GO_HOLD_MS);
  } else {
    startCountdown(countdown.callback, countdown.remaining);
  }
}

// The host pressed Pause (their controller, the display's own button, or a TV
// remote). Refused outside a running game, and while already frozen for any
// other reason: the room core keeps both decisions, so there is no state check
// here to drift from tvOS and Android's.
function pauseGame() {
  var res = roomCore.pause(PAUSE.MANUAL);
  if (!res.changed) return;
  freezeGame();
  showPauseOverlay();
  publishAs(res.publish);
}

// The host pressed Continue. Refused unless the freeze is theirs to lift, and
// while every participant is gone (there would be nobody to play). In that
// second case the overlay deliberately stays up: it carries New Game, which is
// what an operator staring at an emptied room actually wants.
function resumeGame() {
  var res = roomCore.resume(PAUSE.MANUAL);
  if (!res.changed) return;
  thawGame();
  publishAs(res.publish);
}

// Every participant dropped mid-game. Silent: controllers never see this reason,
// so the room core hints 'none' and nothing goes out — there is nobody left to
// tell. Refused if the host had already paused by hand, which is what keeps
// their pause (and its Continue) intact for whoever comes back.
function autoPause() {
  var res = roomCore.pause(PAUSE.AUTO);
  if (!res.changed) return;
  freezeGame();
  publishAs(res.publish);
}

// A participant came back.
function autoResume() {
  var res = roomCore.resume(PAUSE.AUTO);
  if (!res.changed) return;
  thawGame();
  publishAs(res.publish);
}

// Our own relay link dropped: freeze so the sim can't run blind behind the
// reconnect overlay. Publishing is best-effort by definition — the relay is
// exactly what we cannot reach.
function connectionPause() {
  var res = roomCore.pause(PAUSE.CONNECTION);
  if (!res.changed) return;
  freezeGame();
  publishAs(res.publish);
}

// The relay answered created/joined: we are back IN the room, not merely holding
// an open socket. Lifts only a link-drop freeze, so a blip during a manual pause
// leaves that pause standing.
function connectionResume() {
  var res = roomCore.resume(PAUSE.CONNECTION);
  if (!res.changed) return;
  thawGame();
  publishAs(res.publish);
}

// Room-lifecycle clear (new match, return to lobby, fresh room): the pause ends
// outright, whatever it was, and the state transition alongside it publishes.
function clearPause() {
  roomCore.resume(null);
  applyPauseChrome();
}

function startNewGame() {
  stopDisplayGame();
  clearPause();
  lastResults = null;
  roomCore.clearAlive();
  // Drop players still flagged as disconnected from the previous game so they
  // don't carry into the new one, including a relay peer that dropped right as
  // RESULTS appeared, before peer_left or the liveness tick flagged it.
  // Reconnects clear the flag, so present players survive.
  roomCore.pruneDisconnected(Date.now());
  // Clear stale disconnected-QR flags from the previous game so they don't
  // suppress host eligibility here. (onGameEnd no longer clears them — we
  // keep the disconnected state through RESULTS so the host role hands off
  // correctly; see getHostPeerIndex().)
  disconnectedQRs.clear();
  roomCore.clearDisconnected(Date.now());
  // Everyone who remained was disconnected — don't launch an empty game.
  // Both callers (startGame, playAgain) check players.size before this prune,
  // so neither catches the all-disconnected case. From RESULTS, returnToLobby()
  // resets the UI; from a LOBBY start it would no-op (already in LOBBY), so
  // refresh the lobby controls directly.
  if (players.size < 1) {
    if (roomState === ROOM_STATE.LOBBY) {
      updatePlayerList();
      updateStartButton();
    } else {
      returnToLobby();
    }
    return;
  }
  // Fold in the late joiners who sat out the previous round.
  roomCore.admitWaiting();
  setRoomState(ROOM_STATE.COUNTDOWN);
  acquireWakeLock();

  startCountdown(function() {
    // The transition publishes; that is what moves controllers off the
    // countdown-dimmed pad and arms their touch input.
    setRoomState(ROOM_STATE.PLAYING);
    runGameLocally();

    // Show disconnect QR for any players that disconnected during countdown
    for (const entry of players) {
      if (roomCore.isExpired(entry[0], Date.now())) {
        showDisconnectQR(entry[0]);
      }
    }
    checkAllPlayersDisconnected();
  });
}

// The countdown digits are display-only: controllers learn they are counting
// down from snapshot.roomState (which dims their pad) and learn the game is
// live from the COUNTDOWN -> PLAYING transition. Nothing per-second crosses
// the wire.
function startCountdown(onComplete, startFrom) {
  var count = startFrom || GameConstants.COUNTDOWN_SECONDS;
  countdown.callback = onComplete;
  countdown.remaining = count;

  // On resume (startFrom is set), the current number is already on screen —
  // skip the redundant beep.
  if (!startFrom) {
    onCountdownDisplay(count);
  }

  countdown.timer = setInterval(function() {
    count--;
    countdown.remaining = count;
    if (count > 0) {
      onCountdownDisplay(count);
    } else {
      clearInterval(countdown.timer);
      countdown.timer = null;
      countdown.remaining = 0;
      onCountdownDisplay('GO');
      countdown.goTimeout = setTimeout(function() {
        countdown.goTimeout = null;
        onComplete();
      }, GameConstants.COUNTDOWN_GO_HOLD_MS);
    }
  }, GameConstants.COUNTDOWN_STEP_MS);
}

function clearCountdownTimers() {
  if (countdown.timer) { clearInterval(countdown.timer); countdown.timer = null; }
  if (countdown.goTimeout) { clearTimeout(countdown.goTimeout); countdown.goTimeout = null; }
  if (countdown.overlayTimer) { clearTimeout(countdown.overlayTimer); countdown.overlayTimer = null; }
}

// GO holds for 400ms, then the number and scrim fade off together; the text
// is cleared only once hidden — thawGame reads it to decide whether to re-show.
function armCountdownDismiss() {
  countdown.overlayTimer = setTimeout(function() {
    countdown.overlayTimer = null;
    fadeHide(countdownOverlay, 250, function() { countdownNumber.textContent = ''; });
  }, 400);
}

// Every participant is gone: return to the lobby if the late-joiner grace has
// elapsed, otherwise auto-pause. Called from the event path and the 1Hz sweep.
function checkAllPlayersDisconnected() {
  // Don't auto-pause during COUNTDOWN — let it finish so disconnect QRs become visible.
  if (roomState !== ROOM_STATE.PLAYING) return;
  if (!roomCore.allParticipantsDisconnected()) return;

  // Arm the late-joiner grace deadline immediately on the event path — a
  // manually-paused host who then disconnects strands late joiners the same way
  // an unpaused one does. graceTick both arms and (once the 5s window elapses)
  // fires; the 1Hz liveness loop normally observes the fire, but if an event
  // lands on/after the deadline between polls, honor the fire here instead of
  // discarding it — otherwise return-to-lobby slips a full window. Any active
  // player reconnecting drops allParticipantsDisconnected so graceTick clears
  // the deadline (implicit cancel).
  if (roomCore.graceTick(Date.now())) {
    returnToLobby();
    return;
  }

  // No-op if anything already has us frozen, a host's manual pause included:
  // that pause is theirs to lift, and its Continue works again the moment any
  // participant returns.
  autoPause();
}

// A participant reconnected. A thin alias, kept because display-airconsole.js
// wraps THIS name to hold the resume back while an ad or a platform pause is up;
// autoResume itself is what the AC handlers call to lift their own freeze.
function checkAutoResume() {
  autoResume();
}

function returnToLobby() {
  if (roomState === ROOM_STATE.LOBBY) return;
  countdown.callback = null;
  countdown.remaining = 0;
  // The LOBBY transition below publishes, so the lifted pause rides that.
  clearPause();
  releaseWakeLock();

  if (music) music.stop();
  stopDisplayGame(); // also calls clearCountdownTimers()

  // Remove disconnected players (AirConsole mode flags them without ever
  // expiring; relay mode can expire one before a QR flag was set), then fold in
  // the late joiners who were waiting out the round.
  roomCore.pruneDisconnected(Date.now());
  roomCore.admitWaiting();

  lastResults = null;
  roomCore.clearAlive();
  // Publishes: controllers see roomState back at LOBBY and route themselves
  // there, which is what the RETURN_TO_LOBBY broadcast used to do.
  setRoomState(ROOM_STATE.LOBBY);

  returnToLobbyUI();
}

function returnToLobbyUI() {
  var wasInGame = currentScreen === SCREEN.GAME || currentScreen === SCREEN.RESULTS;
  gameState = null;
  prevFrameTime = 0;
  disconnectedQRs.clear();
  roomCore.clearDisconnected(Date.now());
  garbageIndicatorEffects.clear();
  garbageDefenceEffects.clear();
  showScreen(SCREEN.LOBBY);
  updateStartButton();
  if (wasInGame && !popstateNavigating) {
    suppressPopstate = true;
    history.back();
  }
  popstateNavigating = false;
}

// =====================================================================
// Local Game Engine
// =====================================================================

function stopDisplayGame() {
  if (displayGame) {
    displayGame = null;
  }
  garbageDefenceEffects.clear();
  clearCountdownTimers();
}

function runGameLocally() {
  runGameLocallyWithSeed((Math.random() * 0xFFFFFFFF) >>> 0);
}

function runGameLocallyWithSeed(seed) {
  stopDisplayGame();
  // Game start lands mid-GO-dismissal (the fadeHide arms at GO+400ms, this
  // runs at GO+500ms): let an in-flight fade finish — its onHidden callback
  // clears the text — instead of snapping the scrim to display:none.
  if (!countdownOverlay.classList.contains('closing')) {
    countdownOverlay.classList.add('hidden');
    countdownNumber.textContent = '';
  }

  var Game = window.GameEngine.Game;
  // Sort by join time so the engine's order matches the lobby's board positions
  // (first joiner leftmost; see calculateLayout, same rule), snapshot the array
  // so mid-game layout can't drift, and pin it as the host-eligibility set.
  roomCore.freezeParticipantOrder();
  var gamePlayers = new Map();
  for (var i = 0; i < playerOrder.length; i++) {
    var pInfo = players.get(playerOrder[i]);
    gamePlayers.set(playerOrder[i], { startLevel: (pInfo && pInfo.startLevel) || 1 });
  }

  displayGame = new Game(gamePlayers, {
    onEvent: function(event) {
      if (event.type === 'line_clear') {
        onLineClear(event);
        var snap = displayGame.getSnapshot();
        var p = snap.players.find(function(pl) { return pl.id === event.playerId; });
        if (p) {
          party.sendTo(event.playerId, {
            type: MSG.PLAYER_STATE,
            level: p.level, lines: p.lines,
            alive: p.alive, garbageIncoming: p.pendingGarbage || 0
          });
        }
      } else if (event.type === 'player_ko') {
        onPlayerKO(event);
        roomCore.setAlive(event.playerId, false);
        party.sendTo(event.playerId, { type: MSG.PLAYER_STATE, alive: false });
        // The snapshot carries alive too, so a reconnect right after a KO
        // still lands on the dead board. The targeted PLAYER_STATE above stays
        // because it is what fires the KO overlay the instant it happens.
        publishAs('now');
      } else if (event.type === 'piece_lock') {
        onPieceLock(event);
      } else if (event.type === 'garbage_cancelled') {
        onGarbageCancelled(event);
      } else if (event.type === 'garbage_sent') {
        onGarbageSent(event);
      }
    },
    onGameEnd: function(results) {
      // Label the ranking with roster names/colours and append the players who
      // sat this round out, flagged newPlayer so every screen renders them
      // rather than omitting them.
      if (results && results.results) roomCore.enrichResults(results.results);
      // Stash the ranking BEFORE the transition: setRoomState publishes, and
      // the RESULTS snapshot is what carries the results to controllers.
      lastResults = results && results.results;
      setRoomState(ROOM_STATE.RESULTS);
      onGameEnd(results);
    }
  }, seed);

  displayGame.init();
}

// =====================================================================
// Display-side Event Handlers (rendering)
// =====================================================================

function onCountdownDisplay(value) {
  gameState = null;
  var enteringCountdown = currentScreen !== SCREEN.GAME;
  if (enteringCountdown) {
    history.pushState({ screen: 'game' }, '');
  }
  showScreen(SCREEN.GAME);
  // Only force-hide on the first tick into countdown, and only if the user
  // isn't actively interacting — otherwise we'd fight showCursor() every
  // second and the mute/pause buttons become unclickable.
  if (enteringCountdown && cursorTimer === null) {
    document.body.classList.add('cursor-hidden');
    gameToolbar.classList.add('toolbar-autohide');
  }
  cancelFadeHide(countdownOverlay);
  countdownOverlay.classList.remove('hidden');
  countdownNumber.textContent = value;
  playCountdownBeep(value === 'GO');
  if (value === 'GO') {
    if (music && !music.playing) {
      music.start();
      if (muted) music.masterGain.gain.setValueAtTime(0, music.ctx.currentTime);
    }
    armCountdownDismiss();
  }
}

function onLineClear(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  animations.addHexCellClear(br, msg.clearCells || [], msg.lines);
}

function onGarbageCancelled(msg) {
  // The pending garbage count is already reduced in the engine;
  // the next getSnapshot() in renderLoop will update the meter.

  // Compute where the cancelled rows were on the meter.
  // gameState still has the previous frame's snapshot.
  var oldPending = 0;
  if (gameState && gameState.players) {
    for (var i = 0; i < gameState.players.length; i++) {
      if (gameState.players[i].id === msg.playerId) {
        oldPending = gameState.players[i].pendingGarbage || 0;
        break;
      }
    }
  }
  var cancelledLines = Math.min(msg.lines, oldPending);
  if (cancelledLines > 0) {
    // Top-down coords (row 0 = top of board). The meter occupies
    // rows (VISIBLE_ROWS - oldPending) through VISIBLE_ROWS-1. The meter shrinks from the top,
    // so flash the rows that disappear at the top of the old meter.
    var rowStart = GameConstants.VISIBLE_ROWS - oldPending;
    var existing = garbageDefenceEffects.get(msg.playerId) || [];
    existing.push({
      startTime: performance.now(),
      duration: 400,
      maxAlpha: 0.9,
      lines: cancelledLines,
      rowStart: rowStart
    });
    garbageDefenceEffects.set(msg.playerId, existing);
  }

  // Clear stale indicator effects since garbage was defended.
  var effects = garbageIndicatorEffects.get(msg.playerId);
  if (effects && effects.length > 0) {
    var remaining = msg.lines;
    while (remaining > 0 && effects.length > 0) {
      var front = effects[0];
      if (front.lines <= remaining) {
        remaining -= front.lines;
        effects.shift();
      } else {
        front.lines -= remaining;
        front.rowStart += remaining;
        remaining = 0;
      }
    }
    garbageIndicatorEffects.set(msg.playerId, effects);
  }
}

function onGarbageSent(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.toId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  var attackerInfo = players.get(msg.senderId);
  var attackerColor = attackerInfo ? PLAYER_COLORS[attackerInfo.playerIndex] : '#ffffff';
  animations.addGarbageShake(br.x, br.y);
  var shifted = (garbageIndicatorEffects.get(msg.toId) || [])
    .map(function(effect) { return { ...effect, rowStart: effect.rowStart - msg.lines }; })
    .filter(function(effect) { return effect.rowStart + effect.lines > 0; });
  shifted.push({
    startTime: performance.now(),
    duration: 1000,
    maxAlpha: 0.94,
    color: attackerColor,
    lines: msg.lines,
    rowStart: Math.max(0, GameConstants.VISIBLE_ROWS - msg.lines)
  });
  garbageIndicatorEffects.set(msg.toId, shifted);
}

function onPieceLock(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  var pieceColor = PIECE_COLORS[msg.typeId] || '#ffffff';
  animations.addHexLockFlash(br, msg.blocks, pieceColor);
}

function onPlayerKO(msg) {
  if (!animations || !boardRenderers.length) return;
  var idx = playerOrder.indexOf(msg.playerId);
  if (idx < 0 || !boardRenderers[idx]) return;
  var br = boardRenderers[idx];
  animations.addKO(br.x, br.y, br.boardWidth, br.boardHeight, br.cellSize, br._bgOutlineVerts);
}

function onGameEnd(msg) {
  if (music) music.stop();
  releaseWakeLock();
  stopDisplayGame();
  prevFrameTime = 0;
  // Intentionally do NOT clear disconnectedQRs here: the set is what keeps
  // gone players out of getHostPeerIndex() while we sit on RESULTS. A
  // prematurely-cleared set would re-promote the left-mid-game host and
  // freeze Play Again / New Game behind a "Waiting for {gone name}" banner.
  // Cleared instead in startNewGame() and returnToLobbyUI().
  garbageIndicatorEffects.clear();
  garbageDefenceEffects.clear();
  renderResults(msg.results);
  showScreen(SCREEN.RESULTS);
}

// Pure view toggles. They move the overlay and nothing else, so the display's own
// toolbar can raise it during an auto-pause — that overlay is how an operator with
// only a mouse reaches New Game while every controller is gone. The TVs reach the
// same action from a dedicated remote button, so they never need this.
function showPauseOverlay() {
  cancelFadeHide(pauseOverlay);
  pauseOverlay.classList.remove('hidden');
  gameToolbar.classList.add('hidden');
  countdownOverlay.classList.add('paused');
}

// Take the pause overlay down without touching the pause itself. Used by the
// thaw, and by the display's own Continue while auto-paused: there the overlay
// is pure chrome the operator raised, so dismissing it must not try to resume a
// freeze only a returning participant can lift.
function hidePauseOverlay() {
  fadeHide(pauseOverlay, 200);
  if (currentScreen === SCREEN.GAME) {
    gameToolbar.classList.remove('hidden');
  }
}

// Music & Audio — see DisplayAudio.js
