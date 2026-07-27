'use strict';

// The canonical RoomCore operation log.
//
// This is the cross-platform contract. The same sequence is replayed against
// the same module three times: in Node (tests/room-core-conformance.test.js),
// inside JavaScriptCore on tvOS (RoomCoreConformanceTests.swift) and inside
// QuickJS on Android TV (RoomCoreConformanceTest.kt), and the snapshot after
// every step must be byte-identical.
//
// Because all three run the SAME JavaScript, these tests are not asking "did
// someone re-implement this wrong" any more. They ask "does the bridge marshal
// correctly" — a far smaller surface, and the same shape as the engine's
// existing FrameGoldenConformance gate.
//
// `INIT` is the constructor options. rngSeed (not rng) because the native
// bridges are JSON-only and cannot pass a function; it makes auto-naming
// deterministic, which matters because auto-naming is one of the behaviours
// that had silently diverged across the three platforms.
//
// Each op is { m: <RoomCore method>, a: [args] }. Steps that read a getter use
// { g: <property> }. The runner records the method's return value AND the full
// snapshot after every step.

const INIT = { maxPlayers: 8, rngSeed: 20260727, liveness: { timeoutMs: 3000, graceMs: 5000 } };

const OPS = [
  // --- an empty room ------------------------------------------------------
  { g: 'state' },
  { g: 'host' },
  { m: 'pause', a: ['manual'] },                // REFUSED: the lobby is not a running game

  // --- peer_joined arrives BEFORE hello (the helloSeen placeholder window) --
  { m: 'peerJoined', a: [1, 1000] },
  { m: 'peerJoined', a: [1, 1000] },            // duplicate: must be refused
  { m: 'peerJoined', a: [2, 1000] },
  { g: 'host' },
  { m: 'hello', a: [1, { name: 'Ann', colorIndex: 5 }, 1100] },
  // Preferred colour collides with Ann's: silently ignored, snapshot is truth.
  { m: 'hello', a: [2, { name: 'Bo', colorIndex: 5 }, 1100] },

  // --- name sanitizing: control chars, ZWJ, overlong, whitespace-only ------
  // Escaped rather than literal: raw control bytes make git treat this file
  // as binary, which hides the whole fixture from review.
  { m: 'setName', a: [1, 'A\u0000n\u001Fn\u007F'] },   // control chars are stripped
  { m: 'setName', a: [2, 'Bo\u200Db'] },                 // a zero-width joiner is KEPT
  { m: 'setName', a: [1, 'ThisNameIsFarTooLongToFit'] },
  { m: 'setName', a: [2, '   '] },              // whitespace-only -> auto name
  { m: 'setName', a: [1, 'P3'] },               // legacy slot name -> auto name
  { m: 'setName', a: [1, 'Ann'] },

  // --- a HELLO that asks for an auto name, plus a blocklisted preference ----
  { m: 'peerJoined', a: [3, 1200] },
  { m: 'hello', a: [3, { name: 'HX-4', autoName: true }, 1200] },
  { m: 'hello', a: [3, { name: 'HX-7', autoName: true }, 1200] },

  // --- levels and colours, including every rejection path -----------------
  { m: 'setLevel', a: [1, 9] },
  { m: 'setLevel', a: [1, 0] },                 // below range
  { m: 'setLevel', a: [1, 16] },                // above range
  { m: 'setLevel', a: [1, 'nope'] },            // unparseable
  { m: 'setLevel', a: [99, 5] },                // unknown peer
  { m: 'setColor', a: [2, 3] },
  { m: 'setColor', a: [2, 3] },                 // no-op, same slot
  { m: 'setColor', a: [1, 3] },                 // taken by peer 2
  { m: 'setColor', a: [1, 99] },                // out of range
  { g: 'participants' },

  // --- sparse peer indices (AirConsole device_ids are not slots) -----------
  { m: 'peerJoined', a: [4711, 1300] },
  { m: 'hello', a: [4711, { name: 'Sparse' }, 1300] },

  // --- start a round ------------------------------------------------------
  { m: 'transitionTo', a: ['countdown'] },
  { m: 'freezeParticipantOrder', a: [] },
  { m: 'transitionTo', a: ['playing'] },
  { m: 'setAlive', a: [2, false] },
  { g: 'participants' },

  // --- a late joiner mid-game waits out the round -------------------------
  { m: 'peerJoined', a: [5, 2000] },
  { m: 'hello', a: [5, { name: 'Late' }, 2000] },

  // --- the pause state machine -------------------------------------------
  // Three rules: a freeze takes only while the room is RUNNING, it is refused
  // while we are already frozen (except 'auto', which absorbs one), and a resume
  // takes only if it names the current reason and somebody is left to play.
  // Every step's {changed, reason, publish} is the assertion — publish is 'now'
  // exactly when snapshot.paused flips, i.e. only for the manual pause.
  { m: 'pause', a: ['manual'] },                // -> snapshot.paused true
  { m: 'pause', a: ['connection'] },            // REFUSED: already frozen, manual stands
  { m: 'resume', a: ['connection'] },           // REFUSED: not why we are frozen
  { g: 'pauseReason' },                         // ...so a link blip leaves the host's pause
  { m: 'pause', a: ['auto'] },                  // absorbs it; hint 'now' (visible flipped off)
  { g: 'paused' },                              // ...but the room IS still frozen
  { m: 'resume', a: ['manual'] },               // REFUSED: Continue can't lift an auto-pause
  { m: 'resume', a: ['auto'] },                 // the returning participant can
  { m: 'resume', a: ['auto'] },                 // idempotent: no second publish
  { m: 'pause', a: ['bogus'] },                 // unknown reasons are refused, not stored
  { g: 'pauseReason' },
  { m: 'pause', a: ['connection'] },            // running -> link drop takes
  { m: 'resume', a: [null] },                   // lifecycle clear: ends it, whatever it was
  { m: 'setMuted', a: [true] },

  // --- suspend and rejoin: the path a stale native cache would break -------
  { m: 'markDisconnected', a: [1] },
  { m: 'isDisconnected', a: [1] },
  { g: 'host' },                                // falls back to a present player
  { m: 'allParticipantsDisconnected', a: [] },
  // A different device claims the dropped seat under a FRESH peer index.
  { m: 'peerJoined', a: [6, 2500] },
  { m: 'hello', a: [6, { name: 'Ann', rejoinToken: '1' }, 2500] },
  { g: 'participants' },
  { g: 'host' },                                // the returning host reclaims it
  // A claim that must be REFUSED: peer 2 is an active participant already.
  { m: 'hello', a: [2, { name: 'Bo', rejoinToken: '6' }, 2600] },

  // --- liveness: batched tick, expiry, late-joiner grace -------------------
  { m: 'tick', a: [2700, [2, 6]] },
  { m: 'tick', a: [9000, []] },                 // everyone else expires
  // Every participant, not just the two that were claimed/rejoined: expiry alone
  // does not set the flag, so without 3 and 4711 the grace window below never
  // arms and the whole section asserts nothing.
  { m: 'markDisconnected', a: [2] },
  { m: 'markDisconnected', a: [6] },
  { m: 'markDisconnected', a: [3] },
  { m: 'markDisconnected', a: [4711] },
  { m: 'allParticipantsDisconnected', a: [] },
  // Nobody left to play: a freeze still takes, but neither Continue nor the
  // auto-resume may lift it — the rule that keeps a returning player from
  // meeting an overlay whose Continue the display would ignore.
  { m: 'pause', a: ['manual'] },
  { m: 'resume', a: ['manual'] },               // REFUSED: no participant is back
  { m: 'resume', a: [null] },                   // the lifecycle clear is exempt
  { m: 'graceTick', a: [10000] },               // arms the deadline
  { m: 'graceTick', a: [10001] },               // still inside the window
  { m: 'graceTick', a: [16000] },               // fires

  // --- results ------------------------------------------------------------
  { m: 'transitionTo', a: ['results'] },
  { m: 'enrichResults', a: [[{ playerId: 6, rank: 1, lines: 20 }, { playerId: 2, rank: 2, lines: 10 }]] },
  { m: 'setResults', a: [[{ playerId: 6, rank: 1, lines: 20 }, { playerId: 2, rank: 2, lines: 10 }]] },
  { m: 'peerLeft', a: [3] },

  // --- back to the lobby, pruning and admitting ---------------------------
  { m: 'transitionTo', a: ['lobby'] },
  { m: 'pruneDisconnected', a: [20000] },
  { m: 'admitWaiting', a: [] },
  { m: 'clearAlive', a: [] },
  { m: 'setResults', a: [null] },
  { g: 'participants' },
  { g: 'connectedCount' },

  // --- departures in each state -------------------------------------------
  { m: 'peerLeft', a: [5] },
  { m: 'peerLeft', a: [5] },                    // already gone
  { m: 'peerLeft', a: [4711] },

  // --- a full room, then one too many -------------------------------------
  { m: 'peerJoined', a: [10, 30000] },
  { m: 'peerJoined', a: [11, 30000] },
  { m: 'peerJoined', a: [12, 30000] },
  { m: 'peerJoined', a: [13, 30000] },
  { m: 'peerJoined', a: [14, 30000] },
  { m: 'peerJoined', a: [15, 30000] },
  { m: 'peerJoined', a: [16, 30000] },          // room is now full
  { m: 'hello', a: [17, { name: 'Nope' }, 30000] },
  { g: 'connectedCount' },

  // --- reset --------------------------------------------------------------
  { m: 'reset', a: [] },
  { g: 'state' },
  { g: 'host' },
];

module.exports = { INIT, OPS };
