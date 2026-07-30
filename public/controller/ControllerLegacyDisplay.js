'use strict';

// =====================================================================
// LEGACY DISPLAY COMPAT — pre-4.7 displays, temporary by design
// =====================================================================
//
// Apple TV 4.6.0 (in the App Store) publishes NO retained room snapshot: its
// RelayTransport has no setState at all, so it still speaks the per-message
// fanout the snapshot replaced (welcome, lobby_update, countdown, game_start,
// game_end, game_over, game_paused, game_resumed, display_muted,
// return_to_lobby). This controller derives its whole UI from the snapshot,
// screen routing included, so against that display it never leaves
// "Connecting..." while the TV happily seats the player: a silent deadlock.
//
// The two protocols are information-equivalent (tests/room-snapshot.test.js
// pins the snapshot against the frozen WELCOME payload in the other
// direction), so this file rebuilds a snapshot from the fanout and hands it to
// the ONE apply path, onState. No second UI path, no second source of truth:
// the rest of the controller cannot tell which kind of display it is talking
// to, and stays unaware that this file exists.
//
// TO REMOVE, once 4.6.x Apple TVs are gone (three edits, no logic to untangle):
//   1. delete this file and tests/legacy-display-shim.test.js
//   2. drop '/controller/ControllerLegacyDisplay.js' from CONTROLLER_SCRIPTS
//      and AC_DEAD in scripts/asset-manifest.js
//   3. drop the marked LEGACY DISPLAY COMPAT block from controller.js#handleMessage
// Nothing else references it. It is absent from the AirConsole bundles because
// an AC display ships in the same ZIP as its controller and can never be
// older than it.
//
// The retired type strings are hardcoded here on purpose. Putting them back in
// protocol.js would re-open the door for a display to SEND one, which is
// exactly what the snapshot refactor closed (see the note there, and the
// RETIRED_TYPES guard in tests/e2e/room-snapshot.spec.js).

(function (root, factory) {
  var LegacyDisplayRoom = factory();
  // Under node --test the model IS the unit (tests/legacy-display-shim.test.js
  // drives it directly), so the page glue below never runs there.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LegacyDisplayRoom;
    return;
  }
  // The page's one instance, and the only name the controller knows. It reads
  // the page globals (peerIndex, onState) at call time, which is why the glue
  // lives out here rather than inside the model.
  var room = new LegacyDisplayRoom();
  root.ControllerLegacyDisplay = {
    // True when this shim owns the message outright and the caller should stop
    // dispatching it.
    observe: function (data) {
      var verdict = room.apply(data);
      if (!verdict) return false;
      if (peerIndex != null) onState(room.snapshot(peerIndex));
      return verdict === LegacyDisplayRoom.OWNED;
    },
  };
})(typeof self !== 'undefined' ? self : this, function () {

  // Roster key for the host when it is somebody else. The synthetic roster
  // (see snapshot) needs a slot to hang the host's name and colour on, and the
  // legacy protocol never says which peer index the host is. A non-numeric key
  // can't collide with a real peerIndex, and keeps `peerIndex === hostPeerIndex`
  // false, which is precisely what "someone else is host" means to applyRoster.
  var HOST_KEY = 'host';

  function LegacyDisplayRoom() {
    // Latched by the first welcome. Until then every legacy type is ignored:
    // a snapshot-era display sends none of them, and acting on a stray one
    // before we know our own identity would publish a snapshot that doesn't
    // name us, which onState rejects anyway.
    this.active = false;

    this.roomState = 'lobby';
    this.paused = false;
    this.displayMuted = false;
    this.results = null;
    // Joined mid-round and sitting it out. The legacy display omits `alive`
    // from a late joiner's welcome, and that omission is the only signal.
    this.waiting = false;

    this.playerCount = 1;
    this.takenColorIndices = [];

    // This player's own row.
    this.name = null;
    this.color = null;
    this.startLevel = 1;
    this.alive = true;

    this.isHost = false;
    this.hostName = null;
    this.hostColorIndex = null;
  }

  // Types this shim consumes outright (nothing else in the controller handles
  // them) versus the one it only reads. player_state stays on its normal path
  // because onPlayerState owns the line-clear audio and lastLines; the shim
  // reads it purely for the KO, which now rides the snapshot's own row.
  LegacyDisplayRoom.OWNED = 'own';
  LegacyDisplayRoom.SHARED = 'tee';

  // Fold one legacy message into the room model. Returns OWNED / SHARED when a
  // republish is due (see the constants above), or null when the message is not
  // legacy room state and the caller should just carry on dispatching it.
  LegacyDisplayRoom.prototype.apply = function (msg) {
    if (!msg || typeof msg !== 'object') return null;
    // welcome is the only message that can start a session, and it carries
    // everything, so it runs before the latch it sets.
    if (msg.type === 'welcome') {
      this._applyWelcome(msg);
      return LegacyDisplayRoom.OWNED;
    }
    // Everything below is a partial update to a room we must already know.
    if (!this.active) return null;

    switch (msg.type) {
      case 'lobby_update':
        this._applyLobby(msg);
        return LegacyDisplayRoom.OWNED;

      case 'countdown':
        // A round is starting: 'GO' is the beat the game goes live on, which is
        // where the pre-snapshot controller armed its input too.
        this.roomState = msg.value === 'GO' ? 'playing' : 'countdown';
        this.paused = false;
        this.alive = true;
        return LegacyDisplayRoom.OWNED;

      case 'game_start':
        // Deliberately does NOT clear `waiting`: the legacy display broadcasts
        // this to the whole room, late joiners included, and promoting them here
        // would drop a phone the display isn't simulating onto the game screen.
        // They are admitted when the round they are waiting out ends, below.
        this.roomState = 'playing';
        this.paused = false;
        this.alive = true;
        return LegacyDisplayRoom.OWNED;

      case 'game_paused':
        this.paused = true;
        return LegacyDisplayRoom.OWNED;

      case 'game_resumed':
        this.paused = false;
        return LegacyDisplayRoom.OWNED;

      case 'display_muted':
        if (typeof msg.muted === 'boolean') this.displayMuted = msg.muted;
        return LegacyDisplayRoom.OWNED;

      case 'game_end':
        this.roomState = 'results';
        this.results = Array.isArray(msg.results) ? msg.results : null;
        this.paused = false;
        this.waiting = false;
        return LegacyDisplayRoom.OWNED;

      case 'return_to_lobby':
        this.roomState = 'lobby';
        this.results = null;
        this.paused = false;
        this.waiting = false;
        // The round is over, so a KO from it stops being true. This is where the
        // real display clears it too (DisplayGame.js#returnToLobby calls
        // roomCore.clearAlive), and where the pre-snapshot controller dropped
        // its 'dead' class.
        this.alive = true;
        if (typeof msg.playerCount === 'number') this.playerCount = msg.playerCount;
        return LegacyDisplayRoom.OWNED;

      case 'game_over':
        // Sent to the player who was just knocked out.
        this.alive = false;
        return LegacyDisplayRoom.OWNED;

      case 'player_state':
        // Only the KO matters here, and only as a change: republishing on every
        // line clear would re-apply an otherwise identical snapshot.
        if (msg.alive !== false || !this.alive) return null;
        this.alive = false;
        return LegacyDisplayRoom.SHARED;
    }
    return null;
  };

  // welcome is per-recipient and complete, so it rebuilds the model rather than
  // merging into it. That is what makes a rejoin self-healing: the display sends
  // one on every hello, so a reconnect resyncs without any reset hook.
  LegacyDisplayRoom.prototype._applyWelcome = function (msg) {
    this.active = true;
    this.roomState = typeof msg.roomState === 'string' ? msg.roomState : 'lobby';
    var inGame = this.roomState === 'playing' || this.roomState === 'countdown';
    // The display sends alive+paused only to a participant (4.6.0 sendWelcome
    // gates both on isLateJoiner), so their absence mid-round means we are
    // waiting out this one.
    this.waiting = inGame && msg.alive === undefined;
    this.alive = msg.alive !== false;
    this.paused = !!msg.paused;
    if (typeof msg.displayMuted === 'boolean') this.displayMuted = msg.displayMuted;
    if (msg.playerName) this.name = msg.playerName;
    if (typeof msg.colorIndex === 'number') this.color = msg.colorIndex;
    if (Array.isArray(msg.results)) this.results = msg.results;
    this._applyLobby(msg);
  };

  // The fields welcome shares with lobby_update. lobby_update carries no room
  // state, which is why this model is stateful: a host change mid-game must not
  // reset which screen is up.
  LegacyDisplayRoom.prototype._applyLobby = function (msg) {
    if (typeof msg.playerCount === 'number') this.playerCount = msg.playerCount;
    if (typeof msg.startLevel === 'number') this.startLevel = msg.startLevel;
    if (typeof msg.colorIndex === 'number') this.color = msg.colorIndex;
    if (Array.isArray(msg.takenColorIndices)) this.takenColorIndices = msg.takenColorIndices.slice();
    if (typeof msg.isHost === 'boolean') this.isHost = msg.isHost;
    // Omitted (not null) when the room has no host, so a plain read is right.
    this.hostName = msg.hostName != null ? msg.hostName : null;
    this.hostColorIndex = typeof msg.hostColorIndex === 'number' ? msg.hostColorIndex : null;
  };

  // The snapshot RoomCore would have published for this player, in the shape
  // ControllerGame.js#onState expects (server/RoomCore.js#snapshot).
  //
  // The roster is synthesized, because the legacy display never sends one. The
  // controller reads exactly four things out of it (applyRoster and
  // applyOwnIdentity): how many players there are, which colour slots are
  // taken, the host's name and colour, and our own row. It renders no
  // per-player list anywhere, so rows for the other seats need to carry their
  // colour and nothing else.
  LegacyDisplayRoom.prototype.snapshot = function (peerIndex) {
    var own = { name: this.name, color: this.color };
    // Absent means default, mirroring RoomCore.snapshot so both kinds of
    // display exercise the same decode path in applyOwnIdentity.
    if (this.startLevel !== 1) own.startLevel = this.startLevel;
    if (!this.alive) own.alive = false;

    var roster = {};
    roster[peerIndex] = own;
    var rows = 1;
    var claimed = {};
    if (typeof this.color === 'number') claimed[this.color] = true;

    var hostPeerIndex = null;
    if (this.isHost) {
      hostPeerIndex = peerIndex;
    } else if (this.hostName != null || this.hostColorIndex != null) {
      roster[HOST_KEY] = { name: this.hostName, color: this.hostColorIndex };
      rows++;
      hostPeerIndex = HOST_KEY;
      if (typeof this.hostColorIndex === 'number') claimed[this.hostColorIndex] = true;
    }

    // One row per remaining seat, carrying the colour slots still unaccounted
    // for. takenColorIndices holds exactly one entry per player, so this lands
    // on playerCount rows whenever the two agree; taking the max keeps every
    // taken colour (the picker greys out swatches from them) even if they
    // don't.
    var spare = [];
    for (var i = 0; i < this.takenColorIndices.length; i++) {
      if (!claimed[this.takenColorIndices[i]]) spare.push(this.takenColorIndices[i]);
    }
    var target = Math.max(this.playerCount, rows + spare.length);
    for (var n = 0; rows < target; n++, rows++) {
      roster['seat' + n] = n < spare.length ? { color: spare[n] } : {};
    }

    var snap = {
      roomState: this.roomState,
      hostPeerIndex: hostPeerIndex,
      paused: this.paused,
      displayMuted: this.displayMuted,
      // Nobody else's participation is knowable, and nothing reads it: the
      // controller only asks whether IT is in the running round.
      participants: this.waiting ? [] : [peerIndex],
      players: roster,
    };
    if (this.roomState === 'results' && this.results) snap.results = this.results;
    return snap;
  };

  return LegacyDisplayRoom;
});
