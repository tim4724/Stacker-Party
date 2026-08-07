'use strict';

// =====================================================================
// Gamepad Input — pads attached to the DISPLAY machine, as local seats
//
// A pad is not a second kind of player. Every press becomes the SAME message
// a phone would have sent and goes through handleControllerMessage(), so
// joining, auto-naming, colour slots, host election, liveness, pause and the
// engine's input timing all keep running their one implementation. What a
// local seat skips is the relay, and that is also why its peer index is
// NEGATIVE: the relay hands out 1..N and owns slot 0, so -(padIndex+1) can
// never collide with a phone (see isLocalSeat in DisplayState.js, which is
// what guards the two party.sendTo call sites).
//
// Buttons are bound by INDEX, never by label. Index 0 is the physically
// bottom face button on every brand, so one binding lands in the same place
// on an Xbox pad (A), a DualSense (Cross) and a Switch Pro (B). Rotation
// follows the Tetris convention — right face button clockwise, bottom
// counter-clockwise — which is why INPUT.ROTATE_CCW exists at all; no touch
// gesture produces it.
//
// The pad does three different jobs and the room state picks between them:
//   playing  the D-pad and stick are the piece, the face buttons rotate
//   lobby    the D-pad and stick step this seat's start level, the bottom face
//            button (or Start) begins the round (host only), a shoulder side
//            cycles this seat's colour
//   overlays the D-pad and stick move a focus ring over the display's real
//            buttons and the bottom face button clicks the focused one
//            (results, pause, reconnect)
// The lobby is the exception because it has no choice to make on screen: the
// round is its one action, so a ring there would have a single stop and the
// D-pad is better spent on the level. Everywhere else the ring is what makes
// Play Again, New Game, Continue and Reconnect reachable without a binding
// each: add a button to one of those screens and the pad reaches it with no
// change here. Select and the stick clicks stay unbound on purpose.
//
// A whole shoulder SIDE is one action, never two: both left shoulders hold
// (colour previous in the lobby), both right ones hard drop (colour next), so
// there is nothing to remember about which of the two your finger found.
// Neither side is the ONLY way to reach its action, which is what keeps a pad
// with no shoulders playable: D-pad up hard drops and the top face button
// holds. Only the lobby's colour cycling is shoulder-only, and a colour is
// assigned either way.
//
// The display operator's own chrome — the toolbar and the relay diagnostics —
// is never pad-reachable (see OPERATOR_CHROME). It belongs to whoever set the
// screen up, which is also the one person guaranteed to have a pointer.
//
// Two boundaries worth knowing:
//   - Chrome does not report a pad through navigator.getGamepads() until a
//     button has been pressed on it, so a pad cannot be detected before the
//     gesture that joins it, and there is no connect event that would be any
//     earlier. That is why the lobby's controller hint is on the join line's
//     rotation unconditionally rather than shown on detection, and why ANY
//     button joins: naming one would leave a player who pressed a different
//     one with no feedback, and index 0 is labelled A on Xbox, Cross on
//     PlayStation and B on a Switch pad, so no letter is right everywhere.
//   - The welcome screen is not pad-driven. There is no room to join yet, and
//     whoever opened the display in a browser has the pointer to press its one
//     button.
// =====================================================================

// The mapping itself lives in the portable core (server/PadMapper.js), which
// tvOS and Android TV load out of the same bundle: what a press MEANS must not
// depend on which shell read the pad. Everything below is the part that needs a
// browser — navigator.getGamepads, the DOM focus ring and vibrationActuator.
var PAD_BTN = window.GameEngine.PadMapper.PAD_BTN;
var GamepadMapper = window.GameEngine.PadMapper.GamepadMapper;
var gamepadDisplayName = window.GameEngine.PadMapper.gamepadDisplayName;

var GamepadInput = (function () {
  // padIndex -> { seatId, mapper, pendingGarbage, cancelledLines }
  var seats = new Map();
  var rafId = null;

  // The relay owns 1..N and the display owns 0, so negatives are ours alone.
  // Derived from the pad's own slot, so unplugging and replugging the same pad
  // lands back on the same seat (a reconnect, not a new player).
  function seatIdFor(padIndex) { return -(padIndex + 1); }

  function seatFor(seatId) {
    for (var entry of seats) {
      if (entry[1].seatId === seatId) return entry[1];
    }
    return null;
  }

  function feed(seatId, msg) {
    handleControllerMessage(seatId, msg);
  }

  // --- Focus navigation ---------------------------------------------
  // Outside play the pad drives the display's OWN controls rather than a
  // per-screen list of bindings: the D-pad moves a focus ring over whatever
  // buttons the current screen shows, and the bottom face button clicks the
  // focused one. That is what makes Start / Play Again / New Game / pause /
  // mute / fullscreen all reachable without a binding each, and it means a
  // button added to the display is reachable by pad the day it lands.
  //
  // Focus is a property of the SCREEN, not of a seat: there is one ring and
  // any seated pad can move it, the same way a shared display has one mouse
  // pointer. Buttons only — links would navigate the display away from the
  // running room.
  var focusEl = null;

  // Chrome the display OPERATOR owns, never a ring stop: the toolbar's mute /
  // fullscreen / pause and the relay diagnostics belong to whoever set the
  // screen up, and a pad is a player's device. What is left for the ring is
  // exactly the screens with a real choice on them (results, pause, reconnect).
  var OPERATOR_CHROME = '#game-toolbar, #relay-status-bar';

  function focusCandidates() {
    var out = [];
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      // `inert` is how the hidden trailer modal already keeps its own controls
      // out of the tab order; honouring it keeps the ring out of overlays that
      // are on screen but not interactive.
      if (el.disabled || el.closest('[inert]') || !el.getClientRects().length) continue;
      if (el.closest(OPERATOR_CHROME)) continue;
      out.push(el);
    }
    // Reading order (top row first, then left to right), so left/up step back
    // and right/down step forward through a layout the player can see.
    out.sort(function (a, b) {
      var ra = a.getBoundingClientRect();
      var rb = b.getBoundingClientRect();
      if (Math.abs(ra.top - rb.top) > 8) return ra.top - rb.top;
      return ra.left - rb.left;
    });
    return out;
  }

  // The screen's own call to action, so a screen change lands the ring on the
  // button the player almost certainly wants (Start, Play Again, Continue).
  function primaryOf(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].classList.contains('btn-primary')) return list[i];
    }
    return list[0] || null;
  }

  function setFocus(el) {
    if (focusEl && focusEl !== el) focusEl.classList.remove('pad-focus');
    focusEl = el || null;
    if (!focusEl) return;
    focusEl.classList.add('pad-focus');
    // Focus for real as well, so assistive tech and :focus-driven styling
    // agree with the ring. The ring is its own class because a programmatic
    // focus() is not reliably :focus-visible.
    try { focusEl.focus({ preventScroll: true }); } catch (e) { /* detached */ }
  }

  function focusStillValid() {
    return !!focusEl && focusEl.isConnected && !focusEl.disabled &&
      !focusEl.closest('[inert]') && focusEl.getClientRects().length > 0;
  }

  function moveFocus(step) {
    var list = focusCandidates();
    if (!list.length) { setFocus(null); return; }
    var at = list.indexOf(focusEl);
    setFocus(at < 0 ? primaryOf(list) : list[(at + step + list.length) % list.length]);
  }

  function activateFocus() {
    if (!focusStillValid()) {
      var list = focusCandidates();
      setFocus(primaryOf(list));
      return;
    }
    focusEl.click();
  }

  // The lobby has no choice to make on screen — Start is its one action, and
  // with the operator chrome out of the ring there is nothing else to land on.
  // So the D-pad is the level stepper there instead, and Start gets a button.
  function ringActive() {
    return roomState !== ROOM_STATE.LOBBY;
  }

  // A direction step. Note the two readings of the same input: the ring runs
  // in READING order, where up means backwards, while the level is an AXIS,
  // where up means more.
  function onMenuNav(seatId, dir) {
    if (ringActive()) {
      // Pad activity counts as presence, exactly like moving the mouse.
      showCursor();
      moveFocus(dir === 'left' || dir === 'up' ? -1 : 1);
      return;
    }
    var step = (dir === 'right' || dir === 'up') ? 1 : -1;
    var level = roomCore.levelAfterStep(seatId, step);
    if (level !== null) feed(seatId, { type: MSG.SET_LEVEL, level: level });
  }

  // Menu bindings. Out of range levels and colours are rejected by the room
  // core, so the bounds are not re-checked here.
  function onMenuPress(seatId, index) {
    if (index === PAD_BTN.FACE_DOWN && ringActive()) {
      showCursor();
      activateFocus();
      return;
    }

    if (roomState !== ROOM_STATE.LOBBY || !players.has(seatId)) {
      // Outside the lobby Start toggles the pause directly. It is the one
      // action with no button on screen to focus while a game is running.
      if (index === PAD_BTN.START) {
        feed(seatId, { type: paused ? MSG.RESUME_GAME : MSG.PAUSE_GAME });
      }
      return;
    }

    // Starting the round is the host's call, the same rule the phones' lobby
    // renders (only the host is shown a Start button). The display's own
    // on-screen button is unaffected: that one belongs to whoever set the
    // screen up, not to a player.
    //
    // The bottom face button, because it is the one a player reaches for when
    // they want something to happen, and because it is already what clicks the
    // focused button on every other screen. No face button is brand-safe: the
    // labels that make index 0 confirm on Xbox and PlayStation make it cancel
    // on a Switch pad, and index 1 mirrors that exactly, so no choice makes
    // them agree. What breaks the tie is that a cancel press is a response to
    // being somewhere you want out of, and the lobby is not that: there is
    // nothing to back out of, so nothing for the mismatch to collide with.
    //
    // Start does it too. It is the one button whose meaning holds on every
    // brand (Menu / Options / +), it is free here because pause has nothing to
    // act on yet, and it serves the player who reasons "Start starts". It needs
    // no on-screen hint precisely because it is the redundant path, not the one
    // anybody has to find.
    if (index === PAD_BTN.FACE_DOWN || index === PAD_BTN.START) {
      if (seatId === getHostPeerIndex()) feed(seatId, { type: MSG.START_GAME });
      return;
    }

    // Colour has no on-screen control to focus (the picker lives on the
    // phone), so it keeps a shoulder side of its own in each direction. The
    // room core resolves which slot is next, then this sends the same SET_COLOR
    // the phone's picker sends.
    var step = 0;
    if (index === PAD_BTN.L1 || index === PAD_BTN.L2) step = -1;
    else if (index === PAD_BTN.R1 || index === PAD_BTN.R2) step = 1;
    if (step === 0) return;
    var next = roomCore.colorAfterStep(seatId, step);
    if (next !== null) feed(seatId, { type: MSG.SET_COLOR, colorIndex: next });
  }

  function join(padIndex, pad) {
    var seatId = seatIdFor(padIndex);
    var name = gamepadDisplayName(pad.id, window.GameEngine.RoomCore.NAME_MAX_LEN);
    seats.set(padIndex, {
      seatId: seatId,
      mapper: new GamepadMapper(),
      pendingGarbage: 0,
      cancelledLines: 0
    });
    // The same HELLO a phone sends. autoName stays false: the pad's name is a
    // real (if borrowed) identity, not a request for an HX-n slot.
    feed(seatId, { type: MSG.HELLO, name: name, autoName: false });
    // A refused join (room full) leaves no row behind — drop the seat so the
    // next press tries again rather than feeding input nobody owns.
    if (!players.has(seatId)) {
      seats.delete(padIndex);
      return null;
    }
    return seats.get(padIndex);
  }

  function retire(padIndex) {
    var seat = seats.get(padIndex);
    if (!seat) return;
    seats.delete(padIndex);
    // Same path as a phone closing its tab: mid-game the row is held (with a
    // rejoin QR) so replugging the pad — or scanning with a phone — resumes
    // the seat; in lobby or results it is dropped outright.
    feed(seat.seatId, { type: MSG.LEAVE });
  }

  function pump(padIndex, pad, nowMs) {
    var buttons = [];
    for (var b = 0; b < pad.buttons.length; b++) {
      buttons.push(!!(pad.buttons[b] && pad.buttons[b].pressed));
    }

    var seat = seats.get(padIndex);
    if (!seat) {
      // Any press joins, but only once there is a room to join.
      if (currentScreen === SCREEN.WELCOME) return;
      if (buttons.indexOf(true) < 0) return;
      seat = join(padIndex, pad);
      // Hand the joining press to the fresh mapper as the baseline. Without
      // this it reads as a NEW press on the next frame and fires whatever the
      // button is bound to — the bottom face button would join and then
      // immediately start the game.
      if (seat) seat.mapper.poll(buttons, pad.axes || [], nowMs, false);
      return;
    }

    // The row can disappear without the pad going anywhere — a session reset
    // back to welcome clears the whole roster. Give the seat up so the next
    // press joins the new room instead of feeding a player that is gone.
    if (!players.has(seat.seatId)) {
      seats.delete(padIndex);
      return;
    }

    // A local seat sends nothing over the wire, so nothing else proves it is
    // still there. The pad being present in this poll IS the proof; without
    // this the liveness sweep would expire an idle player mid-game.
    roomCore.onSeen(seat.seatId, Date.now());

    var playing = roomState === ROOM_STATE.PLAYING && !paused;
    var result = seat.mapper.poll(buttons, pad.axes || [], nowMs, playing);

    for (var m = 0; m < result.messages.length; m++) feed(seat.seatId, result.messages[m]);
    if (!playing) {
      for (var n = 0; n < result.nav.length; n++) onMenuNav(seat.seatId, result.nav[n]);
      for (var p = 0; p < result.pressed.length; p++) onMenuPress(seat.seatId, result.pressed[p]);
    } else if (result.pressed.indexOf(PAD_BTN.START) >= 0) {
      feed(seat.seatId, { type: MSG.PAUSE_GAME });
    }

    pollRumble(seat, pad);
  }

  // --- Rumble -------------------------------------------------------
  // Effects a phone gets as haptics through its own vibrate() call. Here the
  // pad is local, so they are driven straight off the engine's events.
  function rumble(pad, duration, weak, strong) {
    var actuator = pad.vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== 'function') return;
    try {
      var effect = actuator.playEffect('dual-rumble', {
        duration: duration,
        weakMagnitude: weak,
        strongMagnitude: strong
      });
      if (effect && typeof effect.catch === 'function') effect.catch(function () {});
    } catch (e) { /* unsupported effect type */ }
  }

  function padFor(seatId) {
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (var i = 0; i < pads.length; i++) {
      var seat = seats.get(i);
      if (pads[i] && seat && seat.seatId === seatId) return pads[i];
    }
    return null;
  }

  // The engine has no "garbage applied" event: rows go in at the next lock,
  // inside the board. What it does expose is the pending count, so an
  // unexplained DROP in it is the moment the stack got shoved up. The only
  // other way it can fall is a defended line clear, which garbage_cancelled
  // reports, so subtracting that leaves exactly the applied lines.
  function pollRumble(seat, pad) {
    if (roomState !== ROOM_STATE.PLAYING || !gameState || !gameState.players) {
      // Between matches there is nothing to compare against, and carrying a
      // count across would fire the thump on the next game's first frame.
      seat.pendingGarbage = 0;
      seat.cancelledLines = 0;
      return;
    }
    var pending = 0;
    for (var i = 0; i < gameState.players.length; i++) {
      if (gameState.players[i].id === seat.seatId) {
        pending = gameState.players[i].pendingGarbage || 0;
        break;
      }
    }
    var applied = seat.pendingGarbage - pending - seat.cancelledLines;
    seat.cancelledLines = 0;
    seat.pendingGarbage = pending;
    if (applied > 0) rumble(pad, 90 + 50 * applied, 0.4, 0.9);
  }

  // Called from renderEngineEvent for every engine event, alongside the board
  // animations — the same per-shell fan-out, for the effect that happens in
  // the player's hands instead of on screen.
  function onEngineEvent(event) {
    if (!seats.size) return;
    if (event.type === 'garbage_sent') {
      var target = padFor(event.toId);
      // The telegraph: garbage is queued and the meter is filling.
      if (target) rumble(target, 120 + 40 * event.lines, 0.35, 0.15);
    } else if (event.type === 'garbage_cancelled') {
      var defender = seatFor(event.playerId);
      if (defender) {
        defender.cancelledLines += event.lines;
        var pad = padFor(event.playerId);
        if (pad) rumble(pad, 60, 0.5, 0);
      }
    } else if (event.type === 'player_ko') {
      var out = padFor(event.playerId);
      if (out) rumble(out, 400, 0.6, 1);
    }
  }

  // --- Loop ---------------------------------------------------------
  function poll(nowMs) {
    rafId = requestAnimationFrame(poll);
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (var i = 0; i < pads.length; i++) {
      var pad = pads[i];
      if (!pad || !pad.connected) { retire(i); continue; }
      pump(i, pad, nowMs);
    }
    // A pad that vanished off the end of the array (shorter list, not a null
    // hole) still has to give up its seat.
    var stale = [];
    for (var entry of seats) {
      if (entry[0] >= pads.length) stale.push(entry[0]);
    }
    for (var s = 0; s < stale.length; s++) retire(stale[s]);
    maintainFocus(roomState === ROOM_STATE.PLAYING && !paused);
  }

  // One cheap check per frame keeps the ring honest across screen changes,
  // overlays opening, and buttons enabling (Start is disabled until somebody
  // joins) — without rebuilding the candidate list every frame.
  function maintainFocus(playing) {
    if (playing || !seats.size || !ringActive()) {
      setFocus(null);
      return;
    }
    if (!focusStillValid()) setFocus(primaryOf(focusCandidates()));
  }

  // Not started under the gallery/test harnesses: their rosters are fixtures,
  // and a pad plugged into the developer's machine must not join one.
  function start() {
    if (rafId !== null) return;
    if (!navigator.getGamepads) return;
    if (window.__TEST__) return;
    rafId = requestAnimationFrame(poll);
  }

  return {
    start: start,
    onEngineEvent: onEngineEvent,
    isLocalSeat: function (id) { return typeof id === 'number' && id < 0; }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GamepadMapper, gamepadDisplayName, PAD_BTN };
}
