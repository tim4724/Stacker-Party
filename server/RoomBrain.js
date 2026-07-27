'use strict';

// UMD: works in Node.js (require), the browser (window.GameEngine.RoomBrain),
// and JavaScriptCore/QuickJS on native (tvOS / Android TV). Pure: no wall clock,
// no timers, no DOM, no I/O. Time is injected via nowMs, randomness via opts.rng.
//
// RoomBrain is HexStacker's room brain: the single source of truth for
// everything a controller renders. It COMPOSES the generic partyplug RoomFlow
// (roster, presence, host election, the state machine, liveness predicates) and
// adds the game-flavoured layer RoomFlow deliberately refuses to know about:
// auto-naming, name sanitizing, colour-slot allocation, the pause/mute/results
// facts a display owns, and the projection of all of it into the retained room
// snapshot that controllers derive their whole UI from.
//
// Why this exists: web, tvOS and Android TV each used to implement that layer
// themselves. They drifted (three different auto-name algorithms, three
// different name sanitizers, one platform missing the blocklist entirely) and a
// regex-over-source parity guard could not see it, because the divergence was in
// the decisions rather than in the constants. All three now load this module out
// of dist/partycore.js and call it, so the divergence is structurally impossible
// and the parity tests only have to prove the bridge marshals correctly.
//
// The shells keep transport, timers, rendering and audio. Every mutator here
// returns a `publish` hint ('now' | 'soon' | 'none') so the 500ms level/colour
// throttle policy is single-sourced too; the throttle TIMER stays in each shell,
// because a timer needs a real clock.
(function(exports) {

var RoomFlow = ((typeof require !== 'undefined') ? require('../partyplug/RoomFlow.js') : window.RoomFlow);
var GameConstants = ((typeof require !== 'undefined') ? require('./constants.js') : window.GameConstants);

// Rapid, self-correcting roster churn: the +/- level stepper and the colour
// rose. Both are finger-speed controls where only the final value matters, so
// they publish on the 'soon' hint. Leading + trailing at the shell: the first
// change after a quiet period goes out immediately (the picker overlay closes on
// the display's echo, so it must not feel laggy), and everything inside the
// window collapses into one trailing publish that reads live state at fire time,
// so the latest value always wins.
var SNAPSHOT_THROTTLE_MS = 500;

// Auto names are room-unique, language-neutral, and survive lobby compaction
// (unlike the legacy P1-P8 slot names, which renumbered when someone left).
var AUTO_NAME_RE = /^HX-([1-9][0-9]?)$/i;
var LEGACY_SLOT_NAME_RE = /^P[1-8]$/i;
// Culturally unlucky numbers and one obvious content-adjacent number.
var AUTO_NAME_BLOCKLIST = [4, 13, 17, 69];
var AUTO_NAME_MAX = 99;

var NAME_MAX_LEN = 16;
var MIN_START_LEVEL = 1;
var MAX_START_LEVEL = 15;

// ---------------------------------------------------------------------
// Pure name helpers (module-level: no instance state, and the conformance
// harness exercises them directly)
// ---------------------------------------------------------------------

// Strip control characters (incl. \x00), trim, cap length. Defensive against
// names that would render weirdly in textContent or confuse downstream
// serialization: the controller's host banner uses \x00 as a template-split
// sentinel, so a \x00 surviving into a player name would reach that split.
// Every inbound name (HELLO + SET_NAME) passes through here. Single chokepoint.
function cleanInboundName(raw) {
  return typeof raw === 'string'
    ? raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, NAME_MAX_LEN)
    : '';
}

function autoNameNumber(name) {
  var match = typeof name === 'string' ? AUTO_NAME_RE.exec(name) : null;
  return match ? parseInt(match[1], 10) : null;
}

function isAllowedAutoNameNumber(num) {
  return num >= 1 && num <= AUTO_NAME_MAX && AUTO_NAME_BLOCKLIST.indexOf(num) < 0;
}

// ---------------------------------------------------------------------

function RoomBrain(opts) {
  opts = opts || {};

  this.maxPlayers = opts.maxPlayers != null ? opts.maxPlayers : GameConstants.MAX_PLAYERS;

  // Auto-name picks are deliberately random: sequential picks made every room
  // read HX-1, HX-2, HX-3, which looks assigned rather than chosen. Randomness
  // is also the one thing a cross-platform golden test cannot diff, so it is
  // injectable two ways. `rng` takes a function (in-process callers). `rngSeed`
  // takes a NUMBER, which is what the conformance harness uses, because the
  // native bridges are JSON-only and cannot pass a function across. Production
  // supplies neither and gets Math.random on all three platforms.
  if (opts.rngSeed != null) {
    // mulberry32: tiny, deterministic, and identical wherever the bundle runs.
    var seed = opts.rngSeed >>> 0;
    this._rng = function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  } else {
    this._rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  }

  this.flow = new RoomFlow({
    masterProvider: opts.masterProvider,
    liveness: opts.liveness,
  });

  // Roster backing store, aliased onto flow's map so in-process consumers (the
  // web display's renderers) keep their cheap reads. Writes always go through
  // this brain. Native shells cannot alias a JS Map and read the snapshot
  // instead, which is the same data by construction.
  // peerIndex -> { playerName, playerIndex (colour slot), startLevel, helloSeen,
  //                joinedAt, connected, peerIndex }
  this.players = this.flow.players;

  // Active participants, in board-layout order. Deliberately NOT the same thing
  // as flow's internal _order: in the lobby this list holds everyone who has
  // joined while flow's is empty (host eligibility is unrestricted there). The
  // two are reconciled explicitly via setActiveOrder(), at exactly the moments
  // the display already did it.
  this._participants = [];

  this._alive = {};             // peerIndex -> false once KO'd; absent means alive
  this._results = null;         // last ranking, replayed in the RESULTS snapshot
  this._muted = false;

  // Three flags, one composite. A manual pause is the ONLY one a controller can
  // act on; the auto- (everyone disconnected) and connection (our own link down)
  // pauses are display-internal and resolve themselves. Reporting the composite
  // stranded controllers on a pause overlay whose Continue could not work.
  this._paused = false;
  this._autoPaused = false;
  this._connectionPaused = false;
}

RoomBrain.SNAPSHOT_THROTTLE_MS = SNAPSHOT_THROTTLE_MS;
RoomBrain.AUTO_NAME_BLOCKLIST = AUTO_NAME_BLOCKLIST.slice();
RoomBrain.NAME_MAX_LEN = NAME_MAX_LEN;
RoomBrain.STATES = RoomFlow.STATES;
RoomBrain.cleanInboundName = cleanInboundName;

// =====================================================================
// Read accessors
// =====================================================================

// Also an INSTANCE property, not just the static below. The native bridges
// expose `roomGet(prop)`, which is an instance lookup, so a static on the
// constructor is unreachable from tvOS and Android; without this each of them
// has to hand-mirror the number, which is exactly the drift the module exists
// to stop.
Object.defineProperty(RoomBrain.prototype, 'snapshotThrottleMs', {
  get: function () { return SNAPSHOT_THROTTLE_MS; },
});

Object.defineProperty(RoomBrain.prototype, 'state', {
  get: function () { return this.flow.state; },
});

// The RAW sticky host slot. Use `host` for the effective (fallback-resolved)
// one: the two differ during a mid-game blip, when the sticky holder is
// disconnected but their slot stays pinned for their return.
Object.defineProperty(RoomBrain.prototype, 'stickyHost', {
  get: function () { return this.flow.hostPeerIndex; },
});

Object.defineProperty(RoomBrain.prototype, 'host', {
  get: function () { return this.flow.host; },
});

Object.defineProperty(RoomBrain.prototype, 'participants', {
  get: function () { return this._participants; },
});

Object.defineProperty(RoomBrain.prototype, 'size', {
  get: function () { return this.flow.size; },
});

Object.defineProperty(RoomBrain.prototype, 'connectedCount', {
  get: function () { return this.flow.connectedCount; },
});

Object.defineProperty(RoomBrain.prototype, 'results', {
  get: function () { return this._results; },
});

Object.defineProperty(RoomBrain.prototype, 'muted', {
  get: function () { return this._muted; },
});

Object.defineProperty(RoomBrain.prototype, 'paused', {
  get: function () { return this._paused; },
});

Object.defineProperty(RoomBrain.prototype, 'autoPaused', {
  get: function () { return this._autoPaused; },
});

Object.defineProperty(RoomBrain.prototype, 'connectionPaused', {
  get: function () { return this._connectionPaused; },
});

RoomBrain.prototype.get = function (peerIndex) { return this.flow.get(peerIndex); };
RoomBrain.prototype.has = function (peerIndex) { return this.flow.has(peerIndex); };
RoomBrain.prototype.list = function () { return this.flow.list(); };
RoomBrain.prototype.isHost = function (peerIndex) { return this.flow.isHost(peerIndex); };
RoomBrain.prototype.isDisconnected = function (peerIndex) { return this.flow.isDisconnected(peerIndex); };
RoomBrain.prototype.isAlive = function (peerIndex) { return this._alive[peerIndex] !== false; };
RoomBrain.prototype.isParticipant = function (peerIndex) { return this._participants.indexOf(peerIndex) >= 0; };

RoomBrain.prototype.userVisiblePaused = function () {
  return this._paused && !this._autoPaused && !this._connectionPaused;
};

// =====================================================================
// The retained room snapshot
// =====================================================================

// Everything a controller renders, in one object: identity, roster, host, room
// state, pause, liveness and the final ranking. Controllers derive their whole
// UI from this, screen routing included, so there is no second message left that
// could drift out of sync with it. Tiny: well under 2 KiB even for a full room
// sitting on results, against the relay's 16 KiB retained-state cap.
RoomBrain.prototype.snapshot = function () {
  var roster = {};
  for (var entry of this.players) {
    var p = entry[1];
    roster[entry[0]] = {
      name: p.playerName,
      color: p.playerIndex,
      startLevel: p.startLevel || 1,
      alive: this._alive[entry[0]] !== false,
      // False until this player's HELLO lands (see peerJoined). Their own
      // controller waits for it before rendering itself; everyone else reads the
      // row regardless, so the palette slot is claimed immediately.
      helloSeen: p.helloSeen !== false,
    };
  }
  var snap = {
    roomState: this.flow.state,
    hostPeerIndex: this.flow.host,
    // Only a host-pressed pause reaches controllers. See userVisiblePaused().
    paused: this.userVisiblePaused(),
    displayMuted: !!this._muted,
    // Who is actually in the running game. A player in the roster but absent
    // here during playing/countdown joined late and waits out the round.
    participants: this._participants.slice(),
    players: roster,
  };
  if (this.flow.state === RoomFlow.STATES.RESULTS && this._results) {
    snap.results = this._results;
  }
  return snap;
};

// Native shells cross the bridge with JSON strings, so hand them one directly
// rather than making every platform re-serialize an object it just decoded.
RoomBrain.prototype.snapshotJSON = function () {
  return JSON.stringify(this.snapshot());
};

// =====================================================================
// Naming
// =====================================================================

RoomBrain.prototype._takenAutoNameNumbers = function (exceptPeerIndex) {
  var taken = [];
  for (var entry of this.players) {
    if (entry[0] === exceptPeerIndex) continue;
    var num = autoNameNumber(entry[1].playerName);
    if (num != null) taken.push(num);
  }
  return taken;
};

// A room-unique HX name. Honours a preferred number (so a returning player keeps
// the name they had) when it is allowed and free, otherwise picks at random from
// what is left.
RoomBrain.prototype.generateAutoName = function (exceptPeerIndex, preferredName) {
  var taken = this._takenAutoNameNumbers(exceptPeerIndex);
  var preferredNum = autoNameNumber(preferredName);
  if (preferredNum != null
      && isAllowedAutoNameNumber(preferredNum)
      && taken.indexOf(preferredNum) < 0) {
    return 'HX-' + preferredNum;
  }

  var available = [];
  for (var i = 1; i <= AUTO_NAME_MAX; i++) {
    if (isAllowedAutoNameNumber(i) && taken.indexOf(i) < 0) available.push(i);
  }

  // maxPlayers is 8, so this fallback only matters if a test harness
  // deliberately fills every normal candidate.
  if (available.length === 0) {
    for (var j = 1; j <= AUTO_NAME_MAX; j++) {
      if (taken.indexOf(j) < 0) available.push(j);
    }
  }

  if (available.length === 0) return 'HX-1';
  return 'HX-' + available[Math.floor(this._rng() * available.length)];
};

// Resolve a submitted name. Empty submissions and legacy P1-P8 fallbacks become
// room-unique HX names; custom names stay as entered.
RoomBrain.prototype.resolveName = function (name, peerIndex, requestedAutoName) {
  if (requestedAutoName || !name || LEGACY_SLOT_NAME_RE.test(name)) {
    return this.generateAutoName(peerIndex, name);
  }
  return name;
};

// =====================================================================
// Colour slots
// =====================================================================

// Lowest free colour slot. Slots are dense (0..maxPlayers-1) and game-owned;
// peerIndex is NOT a slot (it can be a sparse AirConsole device_id), so we
// allocate from the slots in use via the kit's sparse-safe helper.
RoomBrain.prototype.nextAvailableColorSlot = function () {
  var used = [];
  for (var entry of this.players) used.push(entry[1].playerIndex);
  return RoomFlow.lowestFreeSlot(used, this.maxPlayers);
};

// The preferred colour carried on HELLO (the controller's persisted favourite):
// a valid, un-taken slot index, or null. Mirrors setColor's validation, silently
// skipping collisions because the snapshot carries the truth either way.
// Honouring it at HELLO time (instead of waiting for the controller's follow-up
// SET_COLOR reclaim) removes a full round trip during which both the display and
// the controller showed the default slot colour.
RoomBrain.prototype.preferredColor = function (peerIndex, rawColorIndex) {
  var idx = parseInt(rawColorIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= this.maxPlayers) return null;
  for (var entry of this.players) {
    if (entry[0] !== peerIndex && entry[1].playerIndex === idx) return null;
  }
  return idx;
};

// =====================================================================
// Roster lifecycle
// =====================================================================

// The relay announced a peer. Registers a PLACEHOLDER row: the relay hands us
// peer_joined before the controller's HELLO, so the name and colour here are our
// guesses, not the player's. Other controllers still need the row (it claims a
// palette slot), but the joiner's own controller must not render a guessed
// identity and then visibly correct itself a round trip later, which is what
// helloSeen:false gates.
RoomBrain.prototype.peerJoined = function (peerIndex, nowMs) {
  if (this.players.has(peerIndex)) return { added: false, publish: 'none' };
  if (this.players.size >= this.maxPlayers) return { added: false, publish: 'none' };

  var index = this.nextAvailableColorSlot();
  if (index < 0) return { added: false, publish: 'none' };

  this.flow.addPlayer(peerIndex, {
    playerName: this.generateAutoName(peerIndex),
    playerIndex: index,
    startLevel: 1,
    helloSeen: false,
  });
  this.flow.onSeen(peerIndex, nowMs);

  // Only join the participant list in the lobby; late joiners wait out the round.
  var joinedLobby = this.flow.state === RoomFlow.STATES.LOBBY;
  if (joinedLobby) this._participants.push(peerIndex);

  // The roster changed: a palette slot is claimed and (in an empty room) the
  // host moved. The joiner's own HELLO republishes a moment later, but the other
  // controllers' pickers must not wait for it.
  return { added: true, colorIndex: index, joinedLobby: joinedLobby, publish: 'now' };
};

// A controller introduced itself. Returns what the shell needs to finish the
// job: whether a cross-device reconnect claim was honoured (and which peer index
// it came from, so the shell can remap its own game structures), and whether the
// room was full.
//
// `msg` is the raw HELLO: { name, autoName, colorIndex, rejoinToken, rejoinId }.
RoomBrain.prototype.hello = function (peerIndex, msg, nowMs) {
  msg = msg || {};
  var name = cleanInboundName(msg.name);
  var claim = this.claimReconnect(peerIndex, msg, nowMs);

  var existing = this.players.get(peerIndex);
  if (existing) {
    // Their identity is authoritative from here on, not what peer_joined
    // guessed. Their own controller renders itself once it sees this.
    existing.helloSeen = true;

    if (name || (msg.autoName === true && !claim.claimed)) {
      // For the peer_joined-before-HELLO path, preserve the HX name already
      // assigned to this row while excluding that row from collision checks.
      var requestedName = name || existing.playerName;
      existing.playerName = this.resolveName(requestedName, peerIndex, msg.autoName === true);
    }

    var preferred = this.preferredColor(peerIndex, msg.colorIndex);
    if (preferred != null && existing.playerIndex !== preferred) {
      existing.playerIndex = preferred;
    }

    // One publish settles everything a HELLO can move: this controller's own
    // identity (name, colour, level), the roster the others render, and the
    // host, since a reconnecting ex-host reclaims the role their pinned slot
    // held through the disconnect.
    return {
      accepted: true,
      isNew: false,
      claimed: claim.claimed,
      oldPeerIndex: claim.oldPeerIndex,
      publish: 'now',
    };
  }

  // New player. Their preferred colour wins over the default slot when it is
  // free; a free colour implies a free slot, so the room-full check only guards
  // the fallback.
  var index = this.preferredColor(peerIndex, msg.colorIndex);
  if (index == null) index = this.nextAvailableColorSlot();
  if (index < 0) {
    return { accepted: false, roomFull: true, isNew: true, claimed: false, oldPeerIndex: null, publish: 'none' };
  }

  this.flow.addPlayer(peerIndex, {
    playerName: this.resolveName(name, peerIndex, msg.autoName === true),
    playerIndex: index,
    startLevel: 1,
    helloSeen: true,
  });
  this.flow.onSeen(peerIndex, nowMs);
  if (this.flow.state === RoomFlow.STATES.LOBBY) this._participants.push(peerIndex);

  // Publishes in every room state: the joiner needs the snapshot to learn who
  // they are and which screen to show, and a new low-slot player can take over
  // as host, which moves the other controllers' "Waiting for {name}" banners.
  return {
    accepted: true,
    isNew: true,
    colorIndex: index,
    claimed: claim.claimed,
    oldPeerIndex: claim.oldPeerIndex,
    publish: 'now',
  };
};

// Register a roster row verbatim, bypassing slot allocation and auto-naming.
// This is the FIXTURE path: gallery scenarios and screenshot harnesses need a
// deterministic, possibly non-contiguous roster (three players plus player 7)
// that the join sequence would never produce. Real joins go through peerJoined
// and hello, which is where the allocation policy lives.
RoomBrain.prototype.addPlayer = function (peerIndex, fields) {
  return this.flow.addPlayer(peerIndex, fields);
};

// A peer vanished. The action tells the shell what its own structures must do:
//   'disconnected' - keep the row, raise a rejoin QR, they may come back
//   'removed'      - the row is gone, drop their effects/boards
//   'none'         - we never knew them
RoomBrain.prototype.peerLeft = function (peerIndex) {
  if (!this.players.has(peerIndex)) return { known: false, action: 'none', publish: 'none' };

  var state = this.flow.state;
  var action = 'removed';
  var returnedToLobby = false;

  if (state === RoomFlow.STATES.PLAYING || state === RoomFlow.STATES.COUNTDOWN) {
    if (this.isParticipant(peerIndex)) {
      // An active participant stays in the roster so the slot stays pinned and a
      // reconnect can reclaim it. The shell marks them disconnected when it
      // raises the rejoin QR, which keeps that pair of writes in one place.
      action = 'disconnected';
    } else {
      // A late joiner who was never in the game: remove silently.
      this.flow.removePlayer(peerIndex);
    }
  } else if (state === RoomFlow.STATES.LOBBY) {
    this.flow.removePlayer(peerIndex);
    this._removeParticipant(peerIndex);
  } else if (state === RoomFlow.STATES.RESULTS) {
    this.flow.removePlayer(peerIndex);
    this._removeParticipant(peerIndex);
    this.flow.setActiveOrder(this._participants);
    // Return to the lobby once no game participants remain; late joiners, who
    // are not in the participant list, do not count.
    var hasParticipants = false;
    for (var i = 0; i < this._participants.length; i++) {
      if (this.players.has(this._participants[i])) { hasParticipants = true; break; }
    }
    if (!hasParticipants) {
      this._results = null;
      this.flow.transitionTo(RoomFlow.STATES.LOBBY);
      returnedToLobby = true;
    }
  }

  // The roster changed in every branch: someone is gone, the host may have moved
  // to a present player, and a mid-game departure flips that player's `alive` for
  // the remaining boards. Publishing unconditionally also covers the
  // last-player-leaves case, where the snapshot must stop naming a departed
  // player (and a stale host) to the next peer that joins.
  return { known: true, action: action, returnedToLobby: returnedToLobby, publish: 'now' };
};

// =====================================================================
// Cross-device reconnect claim
// =====================================================================

function normalizePeerIndex(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  var n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Can `peerIndex` claim the dropped seat named by the HELLO's rejoin token?
// Returns the old peer index, or null. Reads flow's presence set rather than the
// display's QR map, so the decision cannot drift from the roster it is about.
RoomBrain.prototype.claimablePeerIndex = function (peerIndex, msg) {
  var oldId = normalizePeerIndex(msg && msg.rejoinToken);
  if (oldId == null && msg && msg.rejoinId != null) oldId = normalizePeerIndex(msg.rejoinId);
  if (oldId == null || oldId === peerIndex) return null;
  if (!this.players.has(oldId) || !this.flow.isDisconnected(oldId)) return null;
  if (!this.isParticipant(oldId)) return null;
  // An active participant cannot claim another board: rekeying onto an id that
  // already owns one would silently drop one of the two. A genuine cross-device
  // rejoin always arrives under a FRESH peer index.
  if (this.isParticipant(peerIndex)) return null;
  return oldId;
};

// Honour the claim if it is valid: move the kept record (and everything keyed by
// peer index that this brain owns) from the old index to the new one. The shell
// remaps its own structures using the returned oldPeerIndex.
RoomBrain.prototype.claimReconnect = function (peerIndex, msg, nowMs) {
  var oldId = this.claimablePeerIndex(peerIndex, msg);
  if (oldId == null) return { claimed: false, oldPeerIndex: null };

  // flow.rekey moves the kept record from oldId to peerIndex (dropping the
  // placeholder row peerIndex got when it joined), and reclaims the sticky host
  // slot and last-seen stamp for the returning peer.
  this.flow.rekey(oldId, peerIndex);
  this.flow.onSeen(peerIndex, nowMs);

  for (var i = 0; i < this._participants.length; i++) {
    if (this._participants[i] === oldId) this._participants[i] = peerIndex;
  }

  if (this._alive[oldId] !== undefined) {
    this._alive[peerIndex] = this._alive[oldId];
    delete this._alive[oldId];
  }

  // Remap the cached ranking too: a claim on the results screen replays it in
  // the snapshot, and the returning controller matches its own row by playerId.
  if (Array.isArray(this._results)) {
    for (var li = 0; li < this._results.length; li++) {
      if (this._results[li].playerId === oldId) this._results[li].playerId = peerIndex;
    }
  }

  return { claimed: true, oldPeerIndex: oldId };
};

// =====================================================================
// Controller settings
// =====================================================================

RoomBrain.prototype.setLevel = function (peerIndex, rawLevel) {
  var player = this.players.get(peerIndex);
  if (!player) return { changed: false, publish: 'none' };
  var level = parseInt(rawLevel, 10);
  if (isNaN(level) || level < MIN_START_LEVEL || level > MAX_START_LEVEL) {
    return { changed: false, publish: 'none' };
  }
  player.startLevel = level;
  // Held-finger control: the throttle collapses a burst of +/- taps into at most
  // ~2 publishes per second no matter how fast they come, and the trailing one
  // always carries the final level. Outside the lobby the stepper is
  // unreachable, so the value is recorded but nothing needs to hear about it.
  var inLobby = this.flow.state === RoomFlow.STATES.LOBBY;
  return { changed: true, level: level, publish: inLobby ? 'soon' : 'none' };
};

// Re-claim a palette slot. Silently rejects collisions so concurrent picks do
// not spam the sender with errors; the next snapshot carries the truth. Not
// state-gated: the controller's colour picker is reachable only in the lobby, so
// a mid-game pick cannot occur in practice.
RoomBrain.prototype.setColor = function (peerIndex, rawColorIndex) {
  var player = this.players.get(peerIndex);
  if (!player) return { changed: false, publish: 'none' };
  var idx = parseInt(rawColorIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= this.maxPlayers) return { changed: false, publish: 'none' };
  if (player.playerIndex === idx) return { changed: false, publish: 'none' };

  for (var entry of this.players) {
    if (entry[0] !== peerIndex && entry[1].playerIndex === idx) {
      return { changed: false, publish: 'none' };
    }
  }

  player.playerIndex = idx;
  // Throttled like the level stepper: the picker overlay closes on the echoed
  // colour, so the leading edge keeps a deliberate pick feeling instant while a
  // flurry of picks still collapses to the last one.
  return { changed: true, colorIndex: idx, publish: 'soon' };
};

// Live rename from an already-registered controller (e.g. an AirConsole profile
// edit). Unlike setColor this is allowed in every state, including mid-game,
// because it only relabels the player and never touches game state.
RoomBrain.prototype.setName = function (peerIndex, rawName) {
  var player = this.players.get(peerIndex);
  if (!player) return { changed: false, publish: 'none' };
  var prevName = player.playerName;
  // requestedAutoName is hardcoded false: SET_NAME always means "I have a real
  // name now". Honouring autoName:true here would discard the name and hand back
  // an HX fallback, the opposite of a rename. Empty and legacy names still
  // resolve to an HX name via resolveName's !name branch.
  player.playerName = this.resolveName(cleanInboundName(rawName), peerIndex, false);
  if (player.playerName === prevName) return { changed: false, publish: 'none' };
  return { changed: true, name: player.playerName, publish: 'now' };
};

// =====================================================================
// Snapshot inputs the display owns
// =====================================================================

RoomBrain.prototype.setAlive = function (peerIndex, alive) {
  if (alive === false) this._alive[peerIndex] = false;
  else delete this._alive[peerIndex];
  return { changed: true, publish: 'now' };
};

RoomBrain.prototype.clearAlive = function () { this._alive = {}; };

RoomBrain.prototype.setResults = function (results) {
  this._results = results || null;
};

RoomBrain.prototype.setMuted = function (muted) {
  this._muted = !!muted;
  return { changed: true, publish: 'now' };
};

RoomBrain.prototype.setPaused = function (paused) { this._paused = !!paused; };
RoomBrain.prototype.setAutoPaused = function (paused) { this._autoPaused = !!paused; };
RoomBrain.prototype.setConnectionPaused = function (paused) { this._connectionPaused = !!paused; };

// =====================================================================
// Room lifecycle
// =====================================================================

// Validated state transition. Every transition is a publish point: controllers
// route their screens purely off snapshot.roomState, so one guaranteed publish
// per transition is what let the GAME_START / COUNTDOWN / GAME_END /
// RETURN_TO_LOBBY broadcasts go. Immediate, ahead of the level/colour throttle.
RoomBrain.prototype.transitionTo = function (to) {
  var applied = this.flow.transitionTo(to);
  return { changed: applied, publish: 'now' };
};

RoomBrain.prototype.setParticipants = function (peerIndices) {
  this._participants = (peerIndices || []).slice();
};

RoomBrain.prototype.addParticipant = function (peerIndex) {
  if (this._participants.indexOf(peerIndex) < 0) this._participants.push(peerIndex);
};

RoomBrain.prototype._removeParticipant = function (peerIndex) {
  var i = this._participants.indexOf(peerIndex);
  if (i >= 0) this._participants.splice(i, 1);
};

RoomBrain.prototype.removeParticipant = function (peerIndex) { this._removeParticipant(peerIndex); };

// Keep flow's host-eligibility set in step with the game's participant order.
// Called at exactly the moments the display already did it, because in the lobby
// the two deliberately differ (flow's is empty; eligibility is unrestricted).
RoomBrain.prototype.setActiveOrder = function (peerIndices) {
  this.flow.setActiveOrder(peerIndices || this._participants);
};

// Sort participants into board-layout order (join order, first joiner leftmost)
// and pin the result as the active set for the round about to start. Overrides
// flow's own COUNTDOWN auto-snapshot: the two normally agree, but this makes the
// game's order authoritative if they ever diverge. A row that vanished mid-sort
// sinks to the end rather than jumping to the front.
RoomBrain.prototype.freezeParticipantOrder = function () {
  var self = this;
  this._participants.sort(function (a, b) {
    var pa = self.players.get(a);
    var pb = self.players.get(b);
    return (pa && pa.joinedAt != null ? pa.joinedAt : Infinity)
         - (pb && pb.joinedAt != null ? pb.joinedAt : Infinity);
  });
  // Snapshot the array so mid-game layout can't drift under later roster edits.
  this._participants = this._participants.slice();
  this.flow.setActiveOrder(this._participants);
  return this._participants.slice();
};

// Drop everyone who went missing while we were away. isDisconnected catches
// AirConsole mode (where isExpired is always false); isExpired catches a
// relay-mode peer that dropped without peer_left or a liveness tick ever
// flagging it. Reconnects clear the flag, so present players survive.
RoomBrain.prototype.pruneDisconnected = function (nowMs) {
  var gone = [];
  for (var entry of this.players) {
    if (this.flow.isDisconnected(entry[0]) || this.flow.isExpired(entry[0], nowMs)) {
      gone.push(entry[0]);
    }
  }
  for (var i = 0; i < gone.length; i++) {
    this.flow.removePlayer(gone[i]);
    this._removeParticipant(gone[i]);
  }
  return gone;
};

// Fold everyone still waiting (late joiners from the round that just ended) into
// the participant list, preserving the existing order.
RoomBrain.prototype.admitWaiting = function () {
  var admitted = [];
  for (var id of this.players.keys()) {
    if (this._participants.indexOf(id) < 0) { this._participants.push(id); admitted.push(id); }
  }
  return admitted;
};

// Label a finished ranking with the roster's names and colours, then append the
// connected players who sat this round out. Late joiners are absent from the
// engine's results (which are built from the participant list), so they are
// flagged newPlayer and every screen renders them as such instead of dropping
// them. Mutates and returns the array, which is also what the RESULTS snapshot
// then carries.
RoomBrain.prototype.enrichResults = function (ranking) {
  if (!Array.isArray(ranking)) return ranking;
  var played = {};
  for (var i = 0; i < ranking.length; i++) {
    var r = ranking[i];
    played[r.playerId] = true;
    var info = this.players.get(r.playerId);
    if (info) {
      r.playerName = info.playerName;
      r.colorIndex = info.playerIndex;
    }
  }
  for (var entry of this.players) {
    if (!played[entry[0]]) {
      ranking.push({
        playerId: entry[0],
        playerName: entry[1].playerName,
        colorIndex: entry[1].playerIndex,
        newPlayer: true,
      });
    }
  }
  return ranking;
};

// Reset to a fresh room. Mirrors the room-local half of the display's
// resetRoomData: roster, participants, liveness, results and the pause flags.
// Mute is deliberately untouched (it is a device preference, not room state).
RoomBrain.prototype.reset = function () {
  this.flow.reset();
  this._participants = [];
  this._alive = {};
  this._results = null;
  this._paused = false;
  this._autoPaused = false;
};

// =====================================================================
// Liveness passthrough (the predicates live in RoomFlow; the effects live in
// the shell, which owns the QR canvases, the pause and the lobby return)
// =====================================================================

RoomBrain.prototype.onSeen = function (peerIndex, nowMs) { this.flow.onSeen(peerIndex, nowMs); };
RoomBrain.prototype.isExpired = function (peerIndex, nowMs) { return this.flow.isExpired(peerIndex, nowMs); };
RoomBrain.prototype.expiredPeers = function (nowMs) { return this.flow.expiredPeers(nowMs); };
RoomBrain.prototype.markDisconnected = function (peerIndex) { this.flow.markDisconnected(peerIndex); };
RoomBrain.prototype.markReconnected = function (peerIndex) { this.flow.markReconnected(peerIndex); };
RoomBrain.prototype.clearDisconnected = function (nowMs) { this.flow.clearDisconnected(nowMs); };
RoomBrain.prototype.allParticipantsDisconnected = function () { return this.flow.allParticipantsDisconnected(); };
RoomBrain.prototype.hasLateJoiners = function () { return this.flow.hasLateJoiners(); };
RoomBrain.prototype.graceTick = function (nowMs) { return this.flow.graceTick(nowMs); };

// One batched liveness pull. Native shells call this once per frame rather than
// crossing the bridge on every inbound controller packet: `seen` is the set of
// peers heard from since the last tick. Returns the decisions, never the
// effects. Empty `expired` when the shell is not currently in the room, which
// the caller signals by simply not calling it.
RoomBrain.prototype.tick = function (nowMs, seen) {
  if (seen) {
    for (var i = 0; i < seen.length; i++) this.flow.onSeen(seen[i], nowMs);
  }
  return {
    expired: this.flow.expiredPeers(nowMs),
    graceFired: this.flow.graceTick(nowMs),
  };
};

exports.RoomBrain = RoomBrain;

})(typeof module !== 'undefined' ? module.exports : (window.GameEngine = window.GameEngine || {}));
