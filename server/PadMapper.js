'use strict';

// UMD: works in Node.js (require), the browser (window.GameEngine.PadMapper),
// and JavaScriptCore/QuickJS on native (tvOS / Android TV). Pure: no wall clock,
// no timers, no DOM, no I/O — the caller passes nowMs.
//
// One gamepad mapping for all three displays. A pad plugged into the machine
// showing the board is a player on every platform, and what a press MEANS must
// not depend on which shell read it: DAS/ARR, the soft-drop ramp, the rotation
// convention and the button table are decided here once. The shells keep only
// what needs a host API — reading the pad, rumble, and the menu focus their own
// UI toolkit owns (see public/display/GamepadInput.js, and the tvOS / Android TV
// coordinators).
//
// The output is CONTROLLER MESSAGES, the same ones a phone sends over the wire.
// That is the whole trick: a local seat then joins, gets named, picks a colour,
// can be elected host and is held live by exactly the code path a phone uses,
// with no second implementation of any of it. Wire values are literals here
// rather than a shared constants import, because the portable set cannot reach
// public/shared/protocol.js; tests/pad-mapper.test.js pins them to it.
//
// Buttons are bound by INDEX, never by label. Index 0 is the physically bottom
// face button on every brand, so one binding lands in the same place on an Xbox
// pad (A), a DualSense (Cross) and a Switch Pro (B).
//
// The whole pad is one sentence: the D-pad moves and drops, the faces rotate,
// the shoulders hold. Rotation splits by column, right-hand pair clockwise and
// left-hand pair counter-clockwise, following the Tetris convention that puts CW
// on the right face button — which is also why ROTATE_CCW exists at all, since
// no touch gesture produces it.
(function(exports) {

// --- W3C "standard" mapping indices ---
// Named by PHYSICAL position, not by action, because most of these do one job
// during play and another in the menus. What each one means is stated where it
// is bound, not here.
var PAD_BTN = {
  FACE_DOWN: 0,   // A / Cross / Switch B
  FACE_RIGHT: 1,  // B / Circle / Switch A
  FACE_LEFT: 2,   // X / Square / Switch Y
  FACE_UP: 3,     // Y / Triangle / Switch X
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  START: 9,       // Start / Options / +
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15
};

// Wire values, pinned to public/shared/protocol.js by tests/pad-mapper.test.js.
var MSG_INPUT = 'input';
var MSG_SOFT_DROP = 'soft_drop';
var MSG_SOFT_DROP_END = 'soft_drop_end';
var IN_LEFT = 'left';
var IN_RIGHT = 'right';
var IN_ROTATE_CW = 'rotate_cw';
var IN_ROTATE_CCW = 'rotate_ccw';
var IN_HARD_DROP = 'hard_drop';
var IN_HOLD = 'hold';

// Auto-repeat for held left/right. DAS is the wait before the repeat starts,
// ARR the interval once it does; both are the familiar stacker values.
var PAD_DAS_MS = 170;
var PAD_ARR_MS = 40;
// A stick reads as a direction past this, and soft drop scales from here to
// full deflection.
var PAD_STICK_DEADZONE = 0.5;
// Same speed range and keepalive cadence as the touchpad's soft drop
// (TouchInput.SOFT_DROP_MIN_SPEED / _MAX_SPEED / SOFT_DROP_INTERVAL_MS): the
// message is state-shaped, so the engine re-arms its deadline on each one and
// auto-ends when they stop.
var PAD_SOFT_DROP_MIN_SPEED = 3;
var PAD_SOFT_DROP_MAX_SPEED = 10;
var PAD_SOFT_DROP_INTERVAL_MS = 100;
// Ceiling on repeats folded into one message. Only a long frame stall (or a
// backgrounded tab catching up) reaches it; the display clamps again on the way
// in, this just keeps the number sane at the source.
var PAD_MAX_STEPS_PER_POLL = 6;

// Turns one pad's raw button/axis state into controller messages.
function GamepadMapper() {
  this._prev = [];
  this._repeatDir = 0;
  this._repeatNextAt = 0;
  this._softDropSpeed = 0;
  this._softDropNextAt = 0;
  // Last stick direction the menu navigation saw, so a HELD stick is one step
  // rather than a run through the list at frame rate.
  this._navX = 0;
  this._navY = 0;
}

// buttons: array of booleans, axes: array of numbers, playing: whether game
// input is live. Returns { messages, pressed, nav }:
//   messages  game input, empty unless playing
//   pressed   button indices that went down this poll (join, pause, settings)
//   nav       'left'/'right'/'up'/'down' steps, empty while playing. Raw
//             directions rather than prev/next, because the two consumers
//             collapse them differently: a focus ring reads in reading order
//             (up is backwards), the level stepper reads as an axis (up is
//             more).
GamepadMapper.prototype.poll = function (buttons, axes, nowMs, playing) {
  var pressed = [];
  for (var i = 0; i < buttons.length; i++) {
    if (buttons[i] && !this._prev[i]) pressed.push(i);
  }

  var messages = [];
  var nav = [];
  if (playing) {
    this._move(buttons, axes, nowMs, messages);
    this._softDrop(buttons, axes, nowMs, messages);
    this._discrete(buttons, messages);
    // Keep the navigation baseline current while the stick is steering a
    // piece, so a stick still held when the game pauses does not read as a
    // fresh menu step on the first frame of the overlay.
    this._stickDir(axes);
  } else {
    this._endSoftDrop(messages);
    this._repeatDir = 0;
    this._nav(buttons, axes, nav);
  }

  this._prev = buttons.slice();
  return { messages: messages, pressed: pressed, nav: nav };
};

// Current stick octant as two discrete directions, recorded for edge
// detection. Returns the pair it just stored.
GamepadMapper.prototype._stickDir = function (axes) {
  var x = axes.length > 0 ? axes[0] : 0;
  var y = axes.length > 1 ? axes[1] : 0;
  this._navX = Math.abs(x) >= PAD_STICK_DEADZONE ? (x < 0 ? -1 : 1) : 0;
  this._navY = Math.abs(y) >= PAD_STICK_DEADZONE ? (y < 0 ? -1 : 1) : 0;
  return { x: this._navX, y: this._navY };
};

// Menu steps from the D-pad AND the left stick, both edge-triggered: one step
// per press and one per push past the dead zone. Lists are a handful of
// buttons and the level range is short, so an auto-repeat would overshoot more
// often than it would help.
GamepadMapper.prototype._nav = function (buttons, axes, out) {
  var self = this;
  function edge(index) { return buttons[index] && !self._prev[index]; }

  if (edge(PAD_BTN.LEFT)) out.push('left');
  if (edge(PAD_BTN.RIGHT)) out.push('right');
  if (edge(PAD_BTN.UP)) out.push('up');
  if (edge(PAD_BTN.DOWN)) out.push('down');

  var wasX = this._navX;
  var wasY = this._navY;
  var now = this._stickDir(axes);
  if (now.x && now.x !== wasX) out.push(now.x < 0 ? 'left' : 'right');
  if (now.y && now.y !== wasY) out.push(now.y < 0 ? 'up' : 'down');
};

// Held-direction auto-repeat. Steps ride as a COUNT on one message rather
// than one message each, the same shape TouchInput gives a fast drag.
GamepadMapper.prototype._move = function (buttons, axes, nowMs, out) {
  var dir = 0;
  if (buttons[PAD_BTN.LEFT]) dir -= 1;
  if (buttons[PAD_BTN.RIGHT]) dir += 1;
  if (dir === 0) {
    var ax = axes.length > 0 ? axes[0] : 0;
    if (Math.abs(ax) >= PAD_STICK_DEADZONE) dir = ax < 0 ? -1 : 1;
  }

  if (dir === 0) {
    this._repeatDir = 0;
    return;
  }

  var action = dir < 0 ? IN_LEFT : IN_RIGHT;
  if (dir !== this._repeatDir) {
    // Fresh press: one step now, then hold for DAS before repeating.
    this._repeatDir = dir;
    this._repeatNextAt = nowMs + PAD_DAS_MS;
    out.push({ type: MSG_INPUT, action: action });
    return;
  }
  if (nowMs < this._repeatNextAt) return;

  var steps = Math.min(
    1 + Math.floor((nowMs - this._repeatNextAt) / PAD_ARR_MS),
    PAD_MAX_STEPS_PER_POLL
  );
  // Re-baseline off now rather than accumulating: a dropped frame costs at
  // most a step's worth of drift and can never run away.
  this._repeatNextAt = nowMs + PAD_ARR_MS;
  var msg = { type: MSG_INPUT, action: action };
  if (steps > 1) msg.n = steps;
  out.push(msg);
};

// D-pad down drops at full speed (a digital press IS full deflection); the
// stick scales between the dead zone and its limit.
GamepadMapper.prototype._softDrop = function (buttons, axes, nowMs, out) {
  var speed = 0;
  if (buttons[PAD_BTN.DOWN]) {
    speed = PAD_SOFT_DROP_MAX_SPEED;
  } else {
    var ay = axes.length > 1 ? axes[1] : 0;
    if (ay >= PAD_STICK_DEADZONE) {
      var t = (ay - PAD_STICK_DEADZONE) / (1 - PAD_STICK_DEADZONE);
      speed = Math.round(
        PAD_SOFT_DROP_MIN_SPEED +
        Math.min(Math.max(t, 0), 1) * (PAD_SOFT_DROP_MAX_SPEED - PAD_SOFT_DROP_MIN_SPEED)
      );
    }
  }

  if (speed === 0) {
    this._endSoftDrop(out);
    return;
  }
  if (this._softDropSpeed !== speed || nowMs >= this._softDropNextAt) {
    this._softDropSpeed = speed;
    this._softDropNextAt = nowMs + PAD_SOFT_DROP_INTERVAL_MS;
    out.push({ type: MSG_SOFT_DROP, speed: speed });
  }
};

GamepadMapper.prototype._endSoftDrop = function (out) {
  if (this._softDropSpeed === 0) return;
  this._softDropSpeed = 0;
  // Explicit end so the piece stops on release instead of waiting out the
  // engine's own soft-drop deadline.
  out.push({ type: MSG_SOFT_DROP_END });
};

GamepadMapper.prototype._discrete = function (buttons, out) {
  var self = this;
  function edge(index) { return buttons[index] && !self._prev[index]; }

  // EVERY face button rotates, split by column: the right-hand pair clockwise,
  // the left-hand pair counter-clockwise. The right face button stays CW, which
  // is the Tetris convention and what a player has already learned, so this
  // extends that split rather than rearranging it.
  //
  // All four because rotation is the discrete action this game actually spends:
  // several times per piece, against a hold that happens at most once. An
  // earlier arrangement gave hold five buttons (both shoulder pairs plus the top
  // face) and rotation two, while the left face button did nothing at all.
  if (edge(PAD_BTN.FACE_RIGHT) || edge(PAD_BTN.FACE_UP)) {
    out.push({ type: MSG_INPUT, action: IN_ROTATE_CW });
  }
  if (edge(PAD_BTN.FACE_DOWN) || edge(PAD_BTN.FACE_LEFT)) {
    out.push({ type: MSG_INPUT, action: IN_ROTATE_CCW });
  }
  // Hard drop is D-pad up, the Tetris convention, and nothing else. Deliberately
  // not stick-up: at a 0.5 dead zone a push 30 degrees off horizontal already
  // clears the vertical threshold, so steering would fire the one input you
  // cannot take back.
  if (edge(PAD_BTN.UP)) {
    out.push({ type: MSG_INPUT, action: IN_HARD_DROP });
  }
  // ALL FOUR shoulders hold, which is what guideline games do and therefore what
  // a player's hands already expect. An earlier arrangement put hard drop on the
  // right side so that a thumb steering with the STICK still had a right-hand
  // hard drop, since it cannot also reach the D-pad. That traded a convention
  // everyone knows for a case that does not arise much: the D-pad is what people
  // reach for on this game, and it carries hard drop already. The cost is real
  // and worth naming — a stick-only player now has to move a thumb to drop.
  //
  // Nothing else holds. The top face button used to, back when only the LEFT
  // shoulders did and it was the fallback for a pad with no shoulders; with all
  // four holding, that fallback was spending a face button to cover a case the
  // shoulders already cover four times over. What it costs is a pad with no
  // shoulders AT ALL (an NES-style retro pad) having no hold, which is playable
  // in a way that missing a rotation direction is not.
  if (edge(PAD_BTN.L1) || edge(PAD_BTN.L2) || edge(PAD_BTN.R1) || edge(PAD_BTN.R2)) {
    out.push({ type: MSG_INPUT, action: IN_HOLD });
  }
};

// Cleaned-up brand name for `gamepad.id`, which is the only string a pad
// exposes and whose format differs per browser:
//   Chrome   "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"
//   Firefox  "045e-0b13-Xbox Wireless Controller"
//   Safari   "Xbox Wireless Controller Extended Gamepad"
// A known vendor id wins over the model string, because the model is the part
// browsers disagree about (and that fingerprinting protections generalize).
// The TVs pass their own product string here (GCController.vendorName,
// InputDevice.getName) so one pad is named the same on every platform.
var PAD_VENDORS = {
  '045e': 'Xbox',
  '054c': 'PlayStation',
  '057e': 'Nintendo',
  '046d': 'Logitech',
  '2dc8': '8BitDo',
  '28de': 'Steam'
};

// Words every pad's id repeats and none of them is identified by. Dropping
// them is what makes a name fit the room core's cap: "Xbox Wireless
// Controller" is 24 characters of which 4 carry the brand.
var PAD_NOISE_RE = /\b(wireless|wired|bluetooth|usb|controller|gamepad|joystick|joypad|extended|standard|xinput|unknown)\b/gi;

// `maxLen` is the room core's own name cap, passed in rather than read, so
// this stays pure and the cap keeps one definition.
function gamepadDisplayName(rawId, maxLen) {
  var id = String(rawId == null ? '' : rawId);

  var vendor = /Vendor:\s*([0-9a-f]{4})/i.exec(id) || /^([0-9a-f]{4})-[0-9a-f]{4}-/i.exec(id);
  if (vendor && PAD_VENDORS[vendor[1].toLowerCase()]) return PAD_VENDORS[vendor[1].toLowerCase()];

  var name = id
    .replace(/\([^)]*\)/g, ' ')                 // Chrome's vendor / XInput block
    .replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '')  // Firefox's leading ids
    .replace(PAD_NOISE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop whole words until it fits rather than hand the room core a name it
  // would cut mid-word.
  while (name.length > maxLen && name.indexOf(' ') > 0) {
    name = name.slice(0, name.lastIndexOf(' '));
  }
  if (!name || name.length > maxLen) return 'Gamepad';
  return name;
}

// --- Rumble ------------------------------------------------------------------
// What a pad does in the player's hands, as data rather than three copies of the
// same numbers. `weak`/`strong` are the two motors of a dual-rumble pad; a
// platform with one motor (Android's InputDevice vibrator) takes the larger.
//
// Deliberately SPARSE. Every one of these means something happened TO you, or
// that you just did something decisive, so the channel stays informative. A buzz
// on every piece lock was considered and rejected: a piece settles every second
// or two, and a rumble that constant stops being a signal and starts being noise
// the meaningful ones have to compete with.
// Nothing here runs shorter than ~70ms, which is a floor set by the hardware and
// not by taste: a rumble motor has to physically spin up, so a 45ms pulse is
// mostly spin-up and is felt as a faint tick no matter how high the amplitude is
// set. Below that floor, buying strength with amplitude alone does not work.
var RUMBLE = {
  // You pressed drop. The only self-inflicted one, and the game's one moment of
  // impact: short and firm rather than long and soft. Also the most FREQUENT by a
  // wide margin, so it is the first to dial back if it ever wears the hand out.
  hardDrop: function () { return { durationMs: 70, weak: 0, strong: 0.8 }; },
  // You cleared. Scaled by lines, so a quad is felt as bigger than a single.
  lineClear: function (lines) {
    return { durationMs: 70 + 30 * lines, weak: 0.45, strong: 0.15 * lines };
  },
  // The telegraph: garbage is queued against you and the meter is filling.
  garbageSent: function (lines) {
    return { durationMs: 130 + 40 * lines, weak: 0.5, strong: 0.25 };
  },
  // You defended it away.
  garbageCancelled: function () { return { durationMs: 85, weak: 0.65, strong: 0 }; },
  // It landed: the stack just moved up under you. The heaviest of the garbage
  // effects, because it is the only one with a consequence already on the board.
  garbageApplied: function (lines) {
    return { durationMs: 110 + 50 * lines, weak: 0.55, strong: 1 };
  },
  // You are out. Shares the amplitude ceiling with garbageApplied because there
  // is nothing above 1, so what separates them is length: this one runs about
  // three times as long and is the only effect that outlasts the moment.
  playerKO: function () { return { durationMs: 420, weak: 0.75, strong: 1 }; }
};

// --- Local seat ids ---------------------------------------------------------
// A seat filled by a pad attached to the display machine is a player like any
// other to the room core, but it has no peer on the relay, so every per-peer
// send must skip it. What it needs is an id the relay will never hand out: the
// relay owns slot 0 (the display) and hands out 1..MAX, so anything well clear
// of that is safe.
//
// It has to be POSITIVE, which is not a matter of taste. The natives receive
// frames through PartyCore's packed format, where every integer is one UTF-16
// code unit in 0..MAX_WIRE, and a player id is one of those integers. A negative
// id is not merely unusual there, it is unencodable: packFrame throws on it, so
// the first frame of a match with a pad seated kills the game. Web-only code
// never meets that boundary, which is exactly why the constraint is easy to miss
// from the web side and why this lives here rather than in any one shell.
var LOCAL_SEAT_BASE = 900;

function seatIdForSlot(slot) { return LOCAL_SEAT_BASE + slot; }

function isLocalSeat(peerIndex) {
  return typeof peerIndex === 'number' && peerIndex >= LOCAL_SEAT_BASE;
}

exports.RUMBLE = RUMBLE;
exports.LOCAL_SEAT_BASE = LOCAL_SEAT_BASE;
exports.seatIdForSlot = seatIdForSlot;
exports.isLocalSeat = isLocalSeat;
exports.PAD_BTN = PAD_BTN;
exports.GamepadMapper = GamepadMapper;
exports.gamepadDisplayName = gamepadDisplayName;
exports.STICK_DEADZONE = PAD_STICK_DEADZONE;

})(typeof exports !== 'undefined' ? exports : (window.GameEngine = window.GameEngine || {}, window.GameEngine.PadMapper = {}));
