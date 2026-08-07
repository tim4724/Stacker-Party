'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MSG, INPUT } = require('../public/shared/protocol');

const { GamepadMapper, gamepadDisplayName, PAD_BTN } = require('../server/PadMapper.js');

const NAME_MAX_LEN = require('../server/RoomCore.js').RoomCore.NAME_MAX_LEN;

// The mapper is portable, so it cannot import public/shared/protocol.js — the
// portable set has no browser modules in it. It therefore writes the wire values
// as literals, and this is what stops that copy from drifting: every message it
// can emit is asserted against protocol.js below, so a renamed action fails here
// rather than silently producing input no display understands.
describe('wire values match the protocol', () => {
  const mapper = new GamepadMapper();
  const all = [];
  const feed = (buttons, axes, nowMs, playing) => {
    all.push(...mapper.poll(buttons, axes, nowMs, playing).messages);
  };
  // Every discrete binding, then a held direction, a stick soft drop and its
  // release, which between them cover all six actions and all three types.
  const press = new Array(17).fill(false);
  [PAD_BTN.FACE_RIGHT, PAD_BTN.FACE_DOWN, PAD_BTN.UP, PAD_BTN.L1, PAD_BTN.LEFT, PAD_BTN.RIGHT]
    .forEach((b, i) => {
      const state = new Array(17).fill(false);
      state[b] = true;
      feed(state, [0, 0, 0, 0], i * 16, true);
      feed(new Array(17).fill(false), [0, 0, 0, 0], i * 16 + 8, true);
    });
  feed(new Array(17).fill(false), [0, 1, 0, 0], 200, true);
  feed(new Array(17).fill(false), [0, 0, 0, 0], 216, true);

  test('every emitted type is a protocol MSG value', () => {
    const types = new Set(all.map((m) => m.type));
    assert.ok(types.size >= 3, `expected all three message types, saw ${[...types]}`);
    for (const t of types) {
      assert.ok(Object.values(MSG).includes(t), `${t} is not a MSG value`);
    }
  });

  test('every emitted action is a protocol INPUT value', () => {
    const actions = new Set(all.filter((m) => m.action).map((m) => m.action));
    assert.deepEqual(
      [...actions].sort(),
      Object.values(INPUT).slice().sort(),
      'the mapper should be able to emit exactly the INPUT vocabulary'
    );
  });
});

// A released-everything pad. Indices past the highest binding are irrelevant.
function noButtons() {
  return new Array(17).fill(false);
}

function withButtons(...indices) {
  const buttons = noButtons();
  for (const i of indices) buttons[i] = true;
  return buttons;
}

const NO_AXES = [0, 0, 0, 0];

describe('GamepadMapper game input', () => {
  let mapper;
  beforeEach(() => { mapper = new GamepadMapper(); });

  function poll(buttons, axes, nowMs, playing = true) {
    return mapper.poll(buttons, axes, nowMs, playing);
  }

  test('every face button rotates, split by column', () => {
    let t = 0;
    const tap = (index) => {
      const res = poll(withButtons(index), NO_AXES, t += 16);
      poll(noButtons(), NO_AXES, t += 16);
      return res.messages;
    };
    const CW = [{ type: MSG.INPUT, action: INPUT.ROTATE_CW }];
    const CCW = [{ type: MSG.INPUT, action: INPUT.ROTATE_CCW }];

    // Right-hand pair clockwise, keeping the Tetris convention on index 1.
    assert.deepEqual(tap(PAD_BTN.FACE_RIGHT), CW);
    assert.deepEqual(tap(PAD_BTN.FACE_UP), CW);
    // Left-hand pair counter-clockwise.
    assert.deepEqual(tap(PAD_BTN.FACE_DOWN), CCW);
    assert.deepEqual(tap(PAD_BTN.FACE_LEFT), CCW);
  });

  test('a held rotate button fires once, not every frame', () => {
    poll(withButtons(PAD_BTN.FACE_RIGHT), NO_AXES, 0);
    for (let t = 16; t < 500; t += 16) {
      assert.deepEqual(poll(withButtons(PAD_BTN.FACE_RIGHT), NO_AXES, t).messages, []);
    }
  });

  test('every shoulder holds, and hard drop is the D-pad', () => {
    let t = 0;
    const tap = (index) => {
      const res = poll(withButtons(index), NO_AXES, t += 16);
      poll(noButtons(), NO_AXES, t += 16);
      return res.messages;
    };
    const HOLD = [{ type: MSG.INPUT, action: INPUT.HOLD }];
    const DROP = [{ type: MSG.INPUT, action: INPUT.HARD_DROP }];

    // All four, which is what guideline games do: there is nothing to remember
    // about which shoulder your finger found.
    assert.deepEqual(tap(PAD_BTN.L1), HOLD);
    assert.deepEqual(tap(PAD_BTN.L2), HOLD);
    assert.deepEqual(tap(PAD_BTN.R1), HOLD);
    assert.deepEqual(tap(PAD_BTN.R2), HOLD);
    // Hard drop is the D-pad's, and only the D-pad's.
    assert.deepEqual(tap(PAD_BTN.UP), DROP);
    // Nothing else holds: the faces are rotation's now, all four of them.
    assert.deepEqual(tap(PAD_BTN.FACE_UP), [{ type: MSG.INPUT, action: INPUT.ROTATE_CW }]);
  });

  test('a stick pushed up never hard drops (it would fire while steering)', () => {
    const moves = poll(noButtons(), [0, -1, 0, 0], 0).messages;
    assert.equal(moves.some(m => m.action === INPUT.HARD_DROP), false);
  });

  describe('held direction (DAS/ARR)', () => {
    test('steps once on press, then waits out DAS before repeating', () => {
      assert.deepEqual(
        poll(withButtons(PAD_BTN.RIGHT), NO_AXES, 0).messages,
        [{ type: MSG.INPUT, action: INPUT.RIGHT }]
      );
      // Inside DAS: nothing.
      for (let t = 16; t <= 160; t += 16) {
        assert.deepEqual(poll(withButtons(PAD_BTN.RIGHT), NO_AXES, t).messages, []);
      }
      // Past it: repeats.
      assert.deepEqual(
        poll(withButtons(PAD_BTN.RIGHT), NO_AXES, 180).messages,
        [{ type: MSG.INPUT, action: INPUT.RIGHT }]
      );
    });

    test('a long stall folds its repeats into one message with a count', () => {
      poll(withButtons(PAD_BTN.LEFT), NO_AXES, 0);
      const stalled = poll(withButtons(PAD_BTN.LEFT), NO_AXES, 400).messages;
      assert.equal(stalled.length, 1);
      assert.equal(stalled[0].action, INPUT.LEFT);
      assert.ok(stalled[0].n > 1, 'expected a repeat count');
    });

    test('reversing direction re-arms DAS instead of repeating', () => {
      poll(withButtons(PAD_BTN.RIGHT), NO_AXES, 0);
      poll(withButtons(PAD_BTN.RIGHT), NO_AXES, 200);
      const flipped = poll(withButtons(PAD_BTN.LEFT), NO_AXES, 216).messages;
      assert.deepEqual(flipped, [{ type: MSG.INPUT, action: INPUT.LEFT }]);
      assert.deepEqual(poll(withButtons(PAD_BTN.LEFT), NO_AXES, 300).messages, []);
    });

    test('the stick moves the piece like the D-pad does', () => {
      assert.deepEqual(
        poll(noButtons(), [-1, 0, 0, 0], 0).messages,
        [{ type: MSG.INPUT, action: INPUT.LEFT }]
      );
    });

    test('a stick inside the dead zone does not move', () => {
      assert.deepEqual(poll(noButtons(), [0.3, 0, 0, 0], 0).messages, []);
    });
  });

  describe('soft drop', () => {
    test('D-pad down drops at full speed and keeps the engine armed', () => {
      const first = poll(withButtons(PAD_BTN.DOWN), NO_AXES, 0).messages;
      assert.deepEqual(first, [{ type: MSG.SOFT_DROP, speed: 10 }]);

      // Same speed inside the keepalive window: silent.
      assert.deepEqual(poll(withButtons(PAD_BTN.DOWN), NO_AXES, 50).messages, []);
      // Past it: repeats, so the engine's own deadline never expires.
      assert.deepEqual(
        poll(withButtons(PAD_BTN.DOWN), NO_AXES, 120).messages,
        [{ type: MSG.SOFT_DROP, speed: 10 }]
      );
    });

    test('the stick scales speed with deflection', () => {
      const light = poll(noButtons(), [0, 0.55, 0, 0], 0).messages[0];
      const full = new GamepadMapper().poll(noButtons(), [0, 1, 0, 0], 0, true).messages[0];
      assert.ok(light.speed >= 3 && light.speed < full.speed);
      assert.equal(full.speed, 10);
    });

    test('release ends the drop immediately', () => {
      poll(withButtons(PAD_BTN.DOWN), NO_AXES, 0);
      assert.deepEqual(
        poll(noButtons(), NO_AXES, 16).messages,
        [{ type: MSG.SOFT_DROP_END }]
      );
      // Only once.
      assert.deepEqual(poll(noButtons(), NO_AXES, 32).messages, []);
    });

    test('leaving play ends a drop that was still held', () => {
      poll(withButtons(PAD_BTN.DOWN), NO_AXES, 0);
      const paused = mapper.poll(withButtons(PAD_BTN.DOWN), NO_AXES, 16, false);
      assert.deepEqual(paused.messages, [{ type: MSG.SOFT_DROP_END }]);
    });
  });

  test('no game messages while play is not live, but presses still register', () => {
    const res = mapper.poll(withButtons(PAD_BTN.FACE_DOWN), NO_AXES, 0, false);
    assert.deepEqual(res.messages, []);
    assert.deepEqual(res.pressed, [PAD_BTN.FACE_DOWN]);
  });

  describe('menu direction steps', () => {
    const menu = (buttons, axes, nowMs) => mapper.poll(buttons, axes, nowMs, false).nav;

    // Raw directions, not prev/next: the ring reads them in reading order
    // (up is backwards) and the level stepper as an axis (up is more), so
    // collapsing here would force one of the two to be wrong.
    test('the D-pad reports the direction pressed', () => {
      assert.deepEqual(menu(withButtons(PAD_BTN.RIGHT), NO_AXES, 0), ['right']);
      menu(noButtons(), NO_AXES, 16);
      assert.deepEqual(menu(withButtons(PAD_BTN.DOWN), NO_AXES, 32), ['down']);
      menu(noButtons(), NO_AXES, 48);
      assert.deepEqual(menu(withButtons(PAD_BTN.LEFT), NO_AXES, 64), ['left']);
      menu(noButtons(), NO_AXES, 80);
      assert.deepEqual(menu(withButtons(PAD_BTN.UP), NO_AXES, 96), ['up']);
    });

    test('the stick reports directions too, once per push', () => {
      assert.deepEqual(menu(noButtons(), [1, 0, 0, 0], 0), ['right']);
      // Held: no runaway.
      for (let t = 16; t < 400; t += 16) {
        assert.deepEqual(menu(noButtons(), [1, 0, 0, 0], t), []);
      }
      // Back to centre, then push again.
      menu(noButtons(), NO_AXES, 400);
      assert.deepEqual(menu(noButtons(), [-1, 0, 0, 0], 416), ['left']);
      menu(noButtons(), NO_AXES, 432);
      assert.deepEqual(menu(noButtons(), [0, -1, 0, 0], 448), ['up']);
    });

    test('a stick inside the dead zone does not step', () => {
      assert.deepEqual(menu(noButtons(), [0.3, 0.3, 0, 0], 0), []);
    });

    test('a stick still held when play ends does not step on the first menu frame', () => {
      mapper.poll(noButtons(), [1, 0, 0, 0], 0, true);   // steering a piece
      assert.deepEqual(mapper.poll(noButtons(), [1, 0, 0, 0], 16, false).nav, []);
    });

    test('nothing steps while play is live', () => {
      assert.deepEqual(poll(withButtons(PAD_BTN.RIGHT), [1, 0, 0, 0], 0).nav, []);
    });
  });

  test('pressed lists only the frame a button goes down', () => {
    assert.deepEqual(poll(withButtons(PAD_BTN.START), NO_AXES, 0).pressed, [PAD_BTN.START]);
    assert.deepEqual(poll(withButtons(PAD_BTN.START), NO_AXES, 16).pressed, []);
    poll(noButtons(), NO_AXES, 32);
    assert.deepEqual(poll(withButtons(PAD_BTN.START), NO_AXES, 48).pressed, [PAD_BTN.START]);
  });
});

describe('gamepadDisplayName', () => {
  const cases = [
    // Chrome / Edge
    ['Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'Xbox'],
    ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'PlayStation'],
    ['Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', 'Nintendo'],
    // Firefox
    ['045e-0b13-Xbox Wireless Controller', 'Xbox'],
    ['2dc8-3106-8BitDo Ultimate', '8BitDo'],
    // Safari (GameController framework names, no vendor id at all)
    ['DualSense Extended Gamepad', 'DualSense'],
    ['Xbox Wireless Controller Extended Gamepad', 'Xbox'],
    // Chrome on Windows via XInput: also no vendor id
    ['Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'Xbox 360'],
    // Unknown vendor: the model survives, stripped of decoration
    ['Rando Pad (STANDARD GAMEPAD Vendor: 9999 Product: 0001)', 'Rando Pad'],
    ['PowerA Wired Controller (STANDARD GAMEPAD Vendor: 20d6 Product: a713)', 'PowerA'],
    // Too long even without the noise words: whole words go, not characters
    ['Nacon Revolution Pro Controller (Vendor: 146b Product: 0d01)', 'Nacon Revolution'],
  ];

  for (const [id, expected] of cases) {
    test(`${id} -> ${expected}`, () => {
      assert.equal(gamepadDisplayName(id, NAME_MAX_LEN), expected);
    });
  }

  test('falls back only when nothing identifying is left', () => {
    assert.equal(gamepadDisplayName('', NAME_MAX_LEN), 'Gamepad');
    assert.equal(gamepadDisplayName(null, NAME_MAX_LEN), 'Gamepad');
    assert.equal(gamepadDisplayName('Unknown Gamepad', NAME_MAX_LEN), 'Gamepad');
    // One unbroken word past the cap has nothing to drop.
    assert.equal(gamepadDisplayName('Absurdlylongcontrollername', NAME_MAX_LEN), 'Gamepad');
  });

  test('never returns a name the room core would truncate', () => {
    for (const [id] of cases) {
      assert.ok(gamepadDisplayName(id, NAME_MAX_LEN).length <= NAME_MAX_LEN);
    }
  });
});
