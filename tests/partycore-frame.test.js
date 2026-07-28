'use strict';

// PartyCore frame() conformance test.
//
// (1) Golden replay: replays a fixed, deterministic timeline through the
//     PartyCore.frame() facade and deep-asserts the per-frame
//     { deltaMs, events, commands, boards(value-copy gridHash) } against a
//     committed fixture (tests/fixtures/partycore-frame-golden.json).
// (2) Cross-validation vs the ENGINE golden (same seed + deltas + inputs):
//     frame()'s buffered drain + value-copy snapshot must NOT perturb the
//     wrapped engine, so the wrapped engine's per-step grids and drained events
//     stay bit-identical to driving Game.update() directly.
// (3) Unit assertions for the drained-callback inversion, the command
//     vocabulary, the value-copy non-aliasing, and the frame()-clock semantics.
//
// Re-record after an INTENTIONAL frame()/command-mapping change:
//   RECORD_PARTYCORE_GOLDEN=1 node --test tests/partycore-frame.test.js
// This NEVER touches tests/fixtures/engine-golden.json (must stay byte-identical).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PartyCore } = require('../server/PartyCore');
const GameConstants = require('../server/constants');
const { PLAYER_IDS } = require('./helpers/engine-golden-script');
const {
  runPartyCoreFrameScript,
  runPartyCoreEngineHashes,
  runReferenceGameSteps,
} = require('./helpers/partycore-frame-script');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'partycore-frame-golden.json');

function newPartyCore(seed) {
  const roster = new Map([['p1', { startLevel: 1 }], ['p2', { startLevel: 1 }]]);
  return new PartyCore(roster, seed);
}

if (process.env.RECORD_PARTYCORE_GOLDEN === '1') {
  const fresh = runPartyCoreFrameScript();
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fresh, null, 2) + '\n');
  console.log('[partycore-golden] recorded', fresh.steps.length, 'frames to', FIXTURE_PATH);
}

test('PartyCore frame() golden corpus replays exactly against committed fixture', () => {
  assert.ok(fs.existsSync(FIXTURE_PATH),
    'fixture missing — record it with RECORD_PARTYCORE_GOLDEN=1 node --test tests/partycore-frame.test.js');
  const expected = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const actual = runPartyCoreFrameScript();

  assert.equal(actual.steps.length, expected.steps.length, 'frame count drifted from the recorded golden');
  assert.equal(actual.seed, expected.seed, 'seed drifted from the recorded golden');
  for (let i = 0; i < expected.steps.length; i++) {
    assert.deepStrictEqual(actual.steps[i], expected.steps[i],
      'partycore golden drift at frame ' + i + ' (deltaMs=' + expected.steps[i].deltaMs + ')');
  }
  assert.deepStrictEqual(actual, expected, 'partycore golden corpus drifted from fixture');
});

test('PartyCore frame() driver is internally deterministic (record == replay)', () => {
  assert.deepStrictEqual(runPartyCoreFrameScript(), runPartyCoreFrameScript());
});

test('frame() wraps the engine faithfully vs a plain Game snapshotting at the same cadence', () => {
  // Reference: a plain Game driven with the SAME timeline and the SAME per-frame
  // getSnapshot() cadence frame() uses internally. (We deliberately do NOT use
  // the engine golden as the reference — it never calls getState(), whereas
  // frame() and the real web renderLoop snapshot every frame; getState's
  // _ghostOf cache makes those two executions legitimately diverge. See the
  // helper header.) Three independent proofs the facade is faithful:
  //   (1) wrapped-engine full grid == reference engine grid (no perturbation)
  //   (2) drained events == reference buffered onEvent/onGameEnd
  //   (3) value-copy snapshot visible grid == reference live getSnapshot visible grid
  const ref = runReferenceGameSteps();
  const frameRun = runPartyCoreFrameScript();
  const engineHashes = runPartyCoreEngineHashes();

  assert.equal(frameRun.steps.length, ref.length, 'frame() step count diverged from the reference');
  assert.equal(engineHashes.length, ref.length, 'engine-hash step count diverged from the reference');

  for (let i = 0; i < ref.length; i++) {
    for (let k = 0; k < PLAYER_IDS.length; k++) {
      assert.equal(engineHashes[i][k], ref[i].engineHash[k],
        'wrapped-engine grid diverged at frame ' + i + ' player ' + PLAYER_IDS[k]);
      assert.equal(frameRun.steps[i].boards[k].gridHash, ref[i].visibleHash[k],
        'value-copy visible grid diverged at frame ' + i + ' player ' + PLAYER_IDS[k]);
    }
    assert.deepStrictEqual(frameRun.steps[i].events, ref[i].events,
      'drained events diverged from the reference at frame ' + i);
  }
});

test('game_end is drained from the separate onGameEnd callback exactly once (event + command)', () => {
  const { steps } = runPartyCoreFrameScript();
  let endEvents = 0;
  let endCommands = 0;
  for (const s of steps) {
    for (const e of s.events) if (e.type === 'game_end') endEvents++;
    for (const c of s.commands) if (c.type === 'gameEnd') endCommands++;
  }
  assert.equal(endEvents, 1, 'game_end must appear exactly once in drained events');
  assert.equal(endCommands, 1, 'gameEnd command must appear exactly once');
});

test('toCommands maps each engine event type to the host-effect vocabulary', () => {
  const snapshot = {
    players: [
      { id: 'p1', level: 2, lines: 11, alive: true, pendingGarbage: 4 },
      { id: 'p2', level: 1, lines: 0, alive: true, pendingGarbage: 0 },
    ],
    elapsed: 1000,
  };
  // toCommands is pure: no instance/core arg.

  // garbage_sent carries senderId/toId, NOT playerId
  assert.deepStrictEqual(
    PartyCore.toCommands([{ type: 'garbage_sent', senderId: 'p1', toId: 'p2', lines: 3 }], snapshot),
    [{ type: 'garbageSent', senderId: 'p1', toId: 'p2', lines: 3 }]);

  assert.deepStrictEqual(
    PartyCore.toCommands([{ type: 'piece_lock', playerId: 'p1', blocks: [[0, 0]], typeId: 5 }], snapshot),
    [{ type: 'pieceLock', playerId: 'p1', blocks: [[0, 0]], typeId: 5 }]);

  // player_ko -> KO anim, then alive:false state, then playerEliminated (web order).
  // playerEliminated (this player is out) is deliberately distinct from gameEnd
  // (the whole match is done) so a native consumer can't conflate them.
  assert.deepStrictEqual(
    PartyCore.toCommands([{ type: 'player_ko', playerId: 'p2' }], snapshot),
    [
      { type: 'playerKO', playerId: 'p2' },
      { type: 'playerState', playerId: 'p2', alive: false },
      { type: 'playerEliminated', playerId: 'p2' },
    ]);

  // line_clear -> lineClear anim, then the post-update playerState. Only what a
  // controller acts on rides along: no level, no pre-resolved garbageIncoming
  // (both were on this command for a while and no controller ever read either).
  assert.deepStrictEqual(
    PartyCore.toCommands([{ type: 'line_clear', playerId: 'p1', lines: 1, rows: [3], clearCells: [[0, 3]] }], snapshot),
    [
      { type: 'lineClear', playerId: 'p1', clearCells: [[0, 3]], lines: 1 },
      { type: 'playerState', playerId: 'p1', lines: 11, alive: true },
    ]);

  assert.deepStrictEqual(
    PartyCore.toCommands([{ type: 'garbage_cancelled', playerId: 'p1', lines: 2 }], snapshot),
    [{ type: 'garbageCancelled', playerId: 'p1', lines: 2 }]);

  // game_end is RAW (elapsed + results), no roster enrichment
  assert.deepStrictEqual(
    PartyCore.toCommands([{ type: 'game_end', elapsed: 1234, results: [{ playerId: 'p1', rank: 1 }] }], snapshot),
    [{ type: 'gameEnd', elapsed: 1234, results: [{ playerId: 'p1', rank: 1 }] }]);
});

test('snapshot pendingGarbage includes the delayed GarbageManager queue', () => {
  const pc = newPartyCore(1);
  pc.init();
  // Queue a delayed (GarbageManager) delivery to p2 — distinct from p2's
  // board-pending queue, which a board.addPendingGarbage would feed.
  pc.game.garbageManager.processLineClear('p1', 1, () => 0, 0, 3);

  const snap = pc.snapshot();
  const p2 = snap.players.find((p) => p.id === 'p2');
  const boardOnly = pc.game.boards.get('p2').getState().pendingGarbage;
  assert.equal(boardOnly, 0, 'board-only pendingGarbage excludes the delayed queue');
  assert.equal(p2.pendingGarbage, 3, 'snapshot pendingGarbage includes the delayed queue');
  assert.ok(p2.pendingGarbage > boardOnly, 'snapshot pendingGarbage strictly exceeds board-only');
});

test('value-copy snapshot is non-aliasing across retained frames', () => {
  const pc = newPartyCore(1);
  pc.init();
  pc.frame(0);              // prime clock
  const a = pc.frame(16);   // frame N
  const ap1 = a.snapshot.players[0];

  const origCell = ap1.grid[5][0];
  const SENTINEL = 127;     // never a valid cell value
  ap1.grid[5][0] = SENTINEL;
  if (ap1.currentPiece) ap1.currentPiece.blocks[0][0] = SENTINEL;

  const b = pc.frame(32);   // frame N+1
  const bp1 = b.snapshot.players[0];

  assert.notStrictEqual(ap1.grid, bp1.grid, 'grid arrays must be distinct instances per frame');
  assert.notStrictEqual(ap1.grid[5], bp1.grid[5], 'grid rows must be distinct instances per frame');
  assert.equal(bp1.grid[5][0], origCell, 'mutating frame N must not leak into frame N+1');
  // host mutation must not reach engine internals
  assert.notEqual(pc.game.boards.get('p1').grid[5 + GameConstants.BUFFER_ROWS][0], SENTINEL,
    'mutating the value-copy must not corrupt the engine grid');
});

test('value-copy snapshot cells are deep-copied (host cannot corrupt the live engine Piece)', () => {
  // cells[i] are {q,r} objects; a shallow slice would share them with the engine
  // Piece, so a native host writing into the retained snapshot would corrupt the
  // engine — the same class of bug copyPlayer deep-copies blocks to prevent.
  const pc = newPartyCore(1);
  pc.init();
  const sp = pc.snapshot().players[0];
  const engPiece = pc.game.boards.get('p1').currentPiece;
  assert.ok(sp.currentPiece && engPiece, 'a current piece exists after init');
  assert.notStrictEqual(sp.currentPiece.cells[0], engPiece.cells[0],
    'snapshot cells objects must be distinct instances from the engine piece');

  const origQ = engPiece.cells[0].q;
  sp.currentPiece.cells[0].q = 999;   // host writes into the retained snapshot
  assert.equal(engPiece.cells[0].q, origQ,
    'mutating snapshot cells must not reach the engine piece');
});

test('frame() command arrays do not alias the parallel events arrays', () => {
  // frame() returns events and commands from the same buffer; a host transforming
  // a command's coordinate arrays must not corrupt the events entry it also holds.
  const pc = newPartyCore(1);
  pc.init();
  pc.frame(0);
  pc.processInput('p1', 'hard_drop');   // emits a piece_lock
  const f = pc.frame(16);
  const ev = f.events.find((e) => e.type === 'piece_lock');
  const cmd = f.commands.find((c) => c.type === 'pieceLock');
  assert.ok(ev && cmd, 'hard_drop produced a piece_lock event and a pieceLock command');
  assert.notStrictEqual(cmd.blocks, ev.blocks, 'command blocks must be a distinct array from the event');

  const orig = ev.blocks[0][0];
  cmd.blocks[0][0] = 999;   // host transforms the command coords
  assert.equal(ev.blocks[0][0], orig, 'mutating the command must not corrupt the parallel event');
});

test('drainEvents returns buffered events once, then empties', () => {
  const pc = newPartyCore(1);
  pc.init();
  assert.deepStrictEqual(pc.drainEvents(), [], 'no events before any input/tick');
  pc.processInput('p1', 'hard_drop');
  const first = pc.drainEvents();
  assert.ok(first.some((e) => e.type === 'piece_lock'), 'hard_drop emits a buffered piece_lock');
  assert.deepStrictEqual(pc.drainEvents(), [], 'buffer is empty after draining');
});

test("input between two frame() calls surfaces in the SECOND frame's events (between-frame buffering)", () => {
  // The native contract: a host calls processInput between vsync frames; those
  // engine events accumulate and are drained by the NEXT frame(), not lost.
  const pc = newPartyCore(1);
  pc.init();
  pc.frame(0);                          // prime
  const a = pc.frame(16);               // frame N: nothing yet (16ms can't gravity-lock from spawn)
  assert.ok(!a.events.some((e) => e.type === 'piece_lock'), 'no lock before the input arrives');

  pc.processInput('p1', 'hard_drop');   // input arrives between frames
  const b = pc.frame(32);               // frame N+1: the hard_drop's events surface here
  assert.ok(b.events.some((e) => e.type === 'piece_lock'),
    'the between-frame hard_drop piece_lock surfaces in the next frame, not dropped');
  assert.ok(b.commands.some((c) => c.type === 'pieceLock'),
    'and is normalized into that frame\'s commands');
});

test('frame() on a paused engine advances the frame clock but the engine no-ops', () => {
  const pc = newPartyCore(1);
  pc.init();
  pc.pause();
  pc.frame(0); // prime
  const before = pc.snapshot().elapsed;
  const f = pc.frame(100); // would apply 50ms, but Game.update no-ops while paused
  assert.deepStrictEqual(f.events, [], 'paused engine emits no events');
  assert.equal(f.snapshot.elapsed, before, 'paused engine does not advance elapsed');
});

test('frame() caps a large nowMs jump to MAX_FRAME_DELTA_MS', () => {
  const pc = newPartyCore(1);
  pc.init();
  pc.frame(0);             // prime at t=0
  const f = pc.frame(200); // 200ms jump
  assert.equal(PartyCore.MAX_FRAME_DELTA_MS, 50);
  assert.equal(f.snapshot.elapsed, PartyCore.MAX_FRAME_DELTA_MS,
    'a 200ms jump advances elapsed by the 50ms cap, not 200ms');
});

// --- delivery filter (deliverFrame / deliverSnapshot) ------------------------
//
// What a native host actually pulls. Both TV ports call these instead of
// frame()/snapshot(); the logic lives here rather than in their bootstrap shims
// precisely because it drifted between those two copies once already.

test('deliverFrame omits the snapshot while the frame is render-identical', () => {
  const pc = newPartyCore(1);
  pc.init();
  assert.ok(pc.deliverFrame(0).snapshot, 'the opening frame is always delivered');
  assert.equal('snapshot' in pc.deliverFrame(1), false,
    'nothing moved in 1ms, so the whole snapshot is dropped from the payload');

  pc.processInput('p1', 'hard_drop');
  const locked = pc.deliverFrame(17);
  assert.ok(locked.snapshot, 'a changed board is delivered again');
  assert.ok(locked.commands.some((c) => c.type === 'pieceLock'),
    'events and commands are never filtered, whatever the snapshot does');
});

test('deliverFrame strips a grid only while its gridVersion is unchanged', () => {
  const pc = newPartyCore(1);
  pc.init();
  const first = pc.deliverFrame(0).snapshot;
  assert.ok(first.players[0].grid, 'first delivery carries full grids');

  pc.processInput('p1', 'hard_drop');
  const locked = pc.deliverFrame(17).snapshot;
  const [p1, p2] = locked.players;
  assert.ok(p1.grid, "the locked board's rows must be re-sent");
  assert.equal('grid' in p2, false, 'the untouched board keeps its grid stripped');
  assert.notEqual(p1.gridVersion, first.players[0].gridVersion);
});

test('deliverSnapshot strips grids but does not consume the scene signature', () => {
  const pc = newPartyCore(1);
  pc.init();
  const full = pc.deliverSnapshot();
  assert.ok(full.players[0].grid);
  assert.equal('grid' in pc.deliverSnapshot().players[0], false,
    'a second pull at the same gridVersion is stripped');
  // An out-of-band pull is not a delivered FRAME: the next frame still has to
  // arrive, or a host that pulled a snapshot would never get its first render.
  assert.ok(pc.deliverFrame(0).snapshot, 'the first frame is still delivered');
});

test('rekeyPlayer voids both delivery ledgers so the new id gets a full render', () => {
  const pc = newPartyCore(1);
  pc.init();
  pc.deliverFrame(0);
  assert.equal('snapshot' in pc.deliverFrame(1), false);   // steady state: nothing delivered

  assert.equal(pc.rekeyPlayer('p1', 'p9'), true);
  const after = pc.deliverFrame(2).snapshot;
  assert.ok(after, 'the roster changed ids, so the frame must be delivered');
  const moved = after.players.find((p) => p.id === 'p9');
  assert.ok(moved && moved.grid, 'the moved board re-sends its grid under the new id');
});

test('the web display drives its off-screen effects through the shared mapping', () => {
  // The web used to hand-write this mapping in its engine callback, and drifted
  // from the TVs while doing it. It now dispatches the same command list they do,
  // so the callback must only BUFFER: any send or room mutation inside it is the
  // per-shell mapping this test exists to keep deleted.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'display', 'DisplayGame.js'), 'utf8');
  assert.match(src, /PartyCore\.toCommands\(/,
    'DisplayGame.js no longer maps engine events through PartyCore');
  for (const type of ['playerState', 'gameEnd']) {
    assert.ok(src.includes(`'${type}'`), `DisplayGame.js handles no ${type} command`);
  }
  const onEvent = src.match(/onEvent: function\(event\) \{([^}]*)\}/);
  assert.ok(onEvent, 'the engine onEvent callback moved — re-point this guard');
  assert.match(onEvent[1], /engineEvents\.push/, 'onEvent must buffer the event');
  assert.ok(!/sendTo|roomCore\.|publishAs/.test(onEvent[1]),
    'the engine callback acts on events again; route it through toCommands instead');
});

test('PartyCore.js is wired into the served engine artifacts', () => {
  // Display load order lives in scripts/asset-manifest.js (the index.html files
  // carry a <!--DISPLAY_SCRIPTS--> placeholder that the server and the bundle
  // build expand), so assert against that canonical source. server/index.js
  // derives its /engine/ allowlist from these same lists, and that every entry
  // is actually serveable is covered by tests/dev-asset-serving.test.js.
  const { DISPLAY_SCRIPTS } = require('../scripts/asset-manifest.js');
  assert.ok(DISPLAY_SCRIPTS.includes('/engine/PartyCore.js'),
    'display load order (asset-manifest.js) must include /engine/PartyCore.js');
});
