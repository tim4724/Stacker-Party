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
// pad (A), a DualSense (Cross) and a Switch Pro (B). Rotation follows the Tetris
// convention: right face button clockwise, bottom counter-clockwise, which is
// why ROTATE_CCW exists at all since no touch gesture produces it.
(function(exports) {

// --- W3C "standard" mapping indices ---
// Named by PHYSICAL position, not by action, because most of these do one job
// during play and another in the menus. What each one means is stated where it
// is bound, not here.
var PAD_BTN = {
  FACE_DOWN: 0,   // A / Cross / Switch B
  FACE_RIGHT: 1,  // B / Circle / Switch A
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

  // Tetris convention: right face button clockwise, bottom counter-clockwise.
  if (edge(PAD_BTN.FACE_RIGHT)) out.push({ type: MSG_INPUT, action: IN_ROTATE_CW });
  if (edge(PAD_BTN.FACE_DOWN)) out.push({ type: MSG_INPUT, action: IN_ROTATE_CCW });
  // A whole SIDE is one action: both left shoulders hold, both right shoulders
  // hard drop. Nothing to remember about which of the two your finger found.
  //
  // The right shoulder carries hard drop against the guideline convention (where
  // the shoulders are hold), because the left thumb steering with the STICK
  // cannot also reach the D-pad, on any pad layout. A stick player's hard drop
  // has to be a right-hand button, and this is it. Deliberately no stick-up hard
  // drop: at a 0.5 dead zone a push 30 degrees off horizontal already clears the
  // vertical threshold, so steering would fire the one input you cannot take
  // back. D-pad up stays the Tetris convention for it.
  if (edge(PAD_BTN.UP) || edge(PAD_BTN.R1) || edge(PAD_BTN.R2)) {
    out.push({ type: MSG_INPUT, action: IN_HARD_DROP });
  }
  // Hold is also on the TOP face button, which is where Tetris Effect puts it
  // and which is the only reason a pad with no shoulders at all (an NES-style
  // retro pad, a sideways single Joy-Con) can still hold a piece.
  if (edge(PAD_BTN.L1) || edge(PAD_BTN.L2) || edge(PAD_BTN.FACE_UP)) {
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

exports.PAD_BTN = PAD_BTN;
exports.GamepadMapper = GamepadMapper;
exports.gamepadDisplayName = gamepadDisplayName;
exports.STICK_DEADZONE = PAD_STICK_DEADZONE;

})(typeof exports !== 'undefined' ? exports : (window.GameEngine = window.GameEngine || {}, window.GameEngine.PadMapper = {}));
